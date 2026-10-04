import { z } from 'zod';
import { canDo, PERSONAL_TODOS, planTodo, resolveOps, todoOpsAllowed, todoWords, TodoActionError, toTodoItem, type TodoItem } from '@huishouden/pwa-kit/todo-core';
import type { Op } from '@huishouden/pwa-kit/store';
import { t } from '../i18n';
import { UserError } from '../context';
import { Increment, type Doc, type Write } from '@huishouden/pwa-kit/firestore-rest';
import { common, defineTool, idempotency, render, type ToolContext } from './registry';
import { alreadyThere, clip, pick, recordId } from './shared';
import { appName } from './overview';

// ---- To-dos: Done and Cancel, exactly as the portal applies them ----

/** '$now' as the absolute time; the rest of the placeholders on the person's calendar. */
function nowFilled(v: unknown, now: number): unknown {
  if (v === '$now') return now;
  if (Array.isArray(v)) return v.map((x) => nowFilled(x, now));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, nowFilled(x, now)]));
  return v;
}

/** Store ops (`col` under the household) as a REST commit. */
export function writesOf(householdId: string, ops: readonly Op[]): Write[] {
  return ops.map((op) => {
    const path = `households/${householdId}/${op.col}/${op.id}`;
    if (op.data === null) return { path, delete: true as const };
    return op.merge ? { path, merge: op.data as Record<string, unknown> } : { path, set: op.data as Record<string, unknown> };
  });
}

async function findTodo(ctx: ToolContext, id: string): Promise<TodoItem> {
  const base = `households/${ctx.here.id}`;
  // FirestoreRest ids can't hold '/'; anything else is the item's id as the to-do list gave it.
  if (!/^[^/]{1,250}$/.test(id)) throw new UserError('error.noSuchTodo');
  const [shared, personal] = await Promise.all([ctx.session.db.get(`${base}/todos/${id}`).catch(() => null), ctx.session.db.get(`${base}/${PERSONAL_TODOS}/${id}`).catch(() => null)]);
  const doc = shared ?? personal;
  if (!doc) throw new UserError('error.noSuchTodo');
  return toTodoItem(doc.id, doc.data);
}

async function applyTodo(ctx: ToolContext, id: string, which: 'done' | 'cancel') {
  const item = await findTodo(ctx, id);
  const words = render(ctx.lang, () => todoWords(item));
  if (item.status !== 'open' || !item[which]) throw new UserError(which === 'done' ? 'todo.noDone' : 'todo.noCancel', { title: words.title });
  if (!canDo(item, which, ctx.here.role, ctx.session.email)) throw new UserError('todo.notAllowed', { title: words.title });
  const action = item[which]!;
  if (!todoOpsAllowed(item.app, action.ops)) throw new UserError('todo.onlyInApp', { title: words.title });
  const me = ctx.session.email;
  const now = ctx.clock.now();
  const ops = resolveOps(
    action.ops.map((op) => ({ ...op, data: op.data === null ? null : (nowFilled(op.data, now) as object) })),
    { now, me, today: ctx.clock.today() },
  );
  const base = `households/${ctx.here.id}`;
  const before = new Map<string, { id: string } | undefined>();
  for (const op of ops) {
    const key = `${op.col}/${op.id}`;
    if (before.has(key)) continue;
    const doc = await ctx.session.db.get(`${base}/${key}`);
    before.set(key, doc ? { id: op.id, ...doc.data } : undefined);
  }
  let writes: Op[];
  try {
    writes = planTodo(item, ops, (col, rid) => before.get(`${col}/${rid}`), { now, me }).writes;
  } catch (e) {
    if (e instanceof TodoActionError) throw new UserError('todo.changedInApp', { title: words.title });
    throw e;
  }
  await ctx.session.db.commit(writesOf(ctx.here.id, writes));
  ctx.touched(item.app, item.ref);
  return render(ctx.lang, () => ({
    text: t(which === 'done' ? 'todo.done' : 'todo.cancelled', { title: words.title, action: (which === 'done' ? words.done : words.cancel) ?? '', app: appName(item.app), url: item.url }),
    data: { id: item.id, app: item.app, action: which, title: words.title, url: item.url },
  }));
}

const todoId = z.string().min(3).max(250).describe('The to-do\'s `id` from `todos` or `today` ("tasks:item:abc").');

export const todoDone = defineTool({
  name: 'todo_done',
  title: 'Mark a to-do done',
  description:
    "Runs a to-do's Done action (the button the portal shows: \"Done\", \"Mark paid\", \"Given\", \"Ordered\"…) as this person. It writes to the app's own record, so the household's rules for that app apply. Use the `id` from `todos`. Check `can_done` first.",
  kind: 'write',
  input: { ...common, id: todoId },
  run: (ctx, args) => applyTodo(ctx, args.id, 'done'),
});

export const todoCancel = defineTool({
  name: 'todo_cancel',
  title: 'Cancel or skip a to-do',
  description:
    "Runs a to-do's Cancel action (\"Skip\", \"Cancel\", \"Pause\", \"Not needed\"…) as this person, the same way the portal does. Use the `id` from `todos`. Check `can_cancel` first.",
  kind: 'write',
  input: { ...common, id: todoId },
  run: (ctx, args) => applyTodo(ctx, args.id, 'cancel'),
});

// ---- Groceries and Tasks: one `items` collection, lists told apart by their icon ----

/** Category names as Groceries stores them (in English; every device shows them in its own language). */
export const GROCERY_CATEGORIES = [
  'Produce & Greens',
  'Dairy & Eggs',
  'Bakery & Bread',
  'Meat & Seafood',
  'Pantry & Dry Goods',
  'Frozen Foods',
  'Beverages & Coffee',
  'Snacks & Sweets',
  'Household & Cleaning',
  'Personal Care',
  'Hardware & Tools',
  'Other',
] as const;
const TASK_CATEGORY = 'Chores & Tasks';

interface List {
  id: string;
  name: string;
  icon: string;
  sortOrder: number;
}

const isTaskList = (l: Pick<List, 'icon'>) => l.icon === 'chores' || l.icon === 'notes';

async function lists(ctx: ToolContext): Promise<List[]> {
  const docs = await ctx.session.db.query(`households/${ctx.here.id}`, 'lists');
  return docs
    .map((d) => ({ id: d.id, name: String(d.data.name ?? d.id), icon: String(d.data.icon ?? ''), sortOrder: Number(d.data.sortOrder ?? 0) }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

function chooseList(all: List[], wanted: string | undefined, tasks: boolean): List {
  const mine = all.filter((l) => isTaskList(l) === tasks);
  if (!mine.length) throw new UserError(tasks ? 'lists.noTaskList' : 'lists.noShoppingList');
  if (!wanted) return mine.find((l) => l.id === (tasks ? 'chores' : 'groceries')) ?? mine[0];
  const { found, ambiguous } = pick(mine, wanted, (l) => l.id, (l) => l.name);
  if (found) return found;
  throw new UserError(ambiguous ? 'lists.ambiguous' : 'lists.unknown', { name: wanted, lists: mine.map((l) => l.name).join(', ') });
}

const stapleKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\//g, '-');

const itemsUrl = (ctx: ToolContext, app: 'groceries' | 'tasks', list: string, item?: string) =>
  ctx.session.link(app, `?list=${encodeURIComponent(list)}${item ? `&item=${encodeURIComponent(item)}` : ''}`);

async function openItems(ctx: ToolContext, listIds: string[]): Promise<Doc[]> {
  const docs = await ctx.session.db.query(`households/${ctx.here.id}`, 'items', { where: [{ field: 'completed', op: 'EQUAL', value: false }] });
  return docs.filter((d) => listIds.includes(String(d.data.listId)));
}

export const groceriesList = defineTool({
  name: 'groceries_list',
  title: 'Shopping lists',
  description: "What's on the household's shopping lists (Groceries, Pantry, Costco & Bulk, Hardware… whatever lists it has), not yet bought, by list and category, with urgency and quantity.",
  kind: 'read',
  input: { ...common, list: z.string().max(80).optional().describe('One list by name or id. Default every shopping list.') },
  async run(ctx, args) {
    const all = await lists(ctx);
    const shopping = args.list ? [chooseList(all, args.list, false)] : all.filter((l) => !isTaskList(l));
    const items = await openItems(ctx, shopping.map((l) => l.id));
    ctx.touched('groceries');
    return render(ctx.lang, () => {
      const lines: string[] = [];
      const data = shopping.map((l) => {
        const mine = items.filter((d) => d.data.listId === l.id).sort((a, b) => String(a.data.category).localeCompare(String(b.data.category)) || Number(a.data.position ?? 0) - Number(b.data.position ?? 0));
        lines.push('', `**[${l.name}](${itemsUrl(ctx, 'groceries', l.id)})** (${mine.length})`);
        for (const d of mine) {
          const urgent = d.data.urgency === 'Need Today' ? ` · ${t('groceries.needToday')}` : '';
          const qty = d.data.quantity && d.data.quantity !== '1' ? ` × ${d.data.quantity}` : '';
          lines.push(`- ${d.data.name}${qty}${urgent} · ${d.data.category ?? ''} · id \`${d.id}\``);
        }
        return { id: l.id, name: l.name, items: mine.map((d) => ({ id: d.id, name: d.data.name, quantity: d.data.quantity, category: d.data.category, urgency: d.data.urgency, notes: d.data.notes || undefined, added_by: d.data.addedBy })) };
      });
      return { text: [`**${t('groceries.title')}** · ${ctx.here.name}`, ...lines].join('\n'), data: { household: ctx.here.id, lists: data } };
    });
  },
});

export const groceriesAdd = defineTool({
  name: 'groceries_add',
  title: 'Add to the shopping list',
  description:
    "Adds an item to a household shopping list, as this person, exactly as the Groceries app does (it also counts it as a staple for suggestions). Pick the `category` yourself from the list; default list is Groceries.",
  kind: 'write',
  input: {
    ...common,
    ...idempotency,
    name: z.string().min(1).max(200).describe('What to buy: "Oat milk".'),
    quantity: z.string().max(40).optional().describe('"2", "1 kg", "a dozen". Default "1".'),
    category: z.enum(GROCERY_CATEGORIES).optional().describe('Aisle category. Default Other.'),
    list: z.string().max(80).optional().describe('List name or id ("Costco & Bulk"). Default Groceries.'),
    urgency: z.enum(['Standard', 'Need Today', 'Whenever']).optional().describe('Default Standard.'),
    notes: z.string().max(500).optional(),
  },
  async run(ctx, args) {
    const list = chooseList(await lists(ctx), args.list, false);
    const name = clip(args.name, 200);
    const quantity = clip(args.quantity, 40) || '1';
    const category = args.category ?? 'Other';
    const urgency = args.urgency ?? 'Standard';
    const now = ctx.clock.now();
    const id = await recordId(ctx.session.props.connectionId, 'groceries_add', args.idempotency_key);
    const base = `households/${ctx.here.id}`;
    const item = {
      listId: list.id,
      name,
      category,
      quantity,
      notes: clip(args.notes, 500),
      addedBy: await ctx.session.firstName(ctx.here.id),
      by: ctx.session.email,
      completed: false,
      urgency,
      position: urgency === 'Need Today' ? -now : now,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      via: 'assistant',
    };
    let repeated = false;
    try {
      await ctx.session.db.commit([
        { path: `${base}/items/${id}`, create: item },
        { path: `${base}/staples/${stapleKey(name)}`, merge: { displayName: name, category, defaultQuantity: quantity, timesAdded: new Increment(1), lastAddedAt: now } },
      ]);
    } catch (e) {
      if (!alreadyThere(e)) throw e;
      repeated = true;
    }
    ctx.touched('groceries', `items/${id}`);
    const url = itemsUrl(ctx, 'groceries', list.id, id);
    return render(ctx.lang, () => ({
      text: t(repeated ? 'groceries.alreadyAdded' : 'groceries.added', { name, list: list.name, url }),
      data: { id, list: list.id, name, quantity, category, urgency, url, repeated },
    }));
  },
});

export const groceriesCheck = defineTool({
  name: 'groceries_check',
  title: 'Tick off a shopping item',
  description: 'Marks a shopping-list item bought (or, with `bought: false`, back on the list), as the Groceries app does. Name it or use its `id` from `groceries_list`.',
  kind: 'write',
  input: {
    ...common,
    item: z.string().min(1).max(200).describe('Item id or name ("milk").'),
    list: z.string().max(80).optional().describe('Only look on this list.'),
    bought: z.boolean().optional().describe('Default true.'),
  },
  async run(ctx, args) {
    const all = await lists(ctx);
    const shopping = args.list ? [chooseList(all, args.list, false)] : all.filter((l) => !isTaskList(l));
    const bought = args.bought ?? true;
    const base = `households/${ctx.here.id}`;
    let candidates: Doc[];
    if (bought) candidates = await openItems(ctx, shopping.map((l) => l.id));
    else {
      const done = await ctx.session.db.query(base, 'items', { where: [{ field: 'completed', op: 'EQUAL', value: true }] });
      candidates = done.filter((d) => shopping.some((l) => l.id === d.data.listId));
    }
    const { found, ambiguous } = pick(candidates, args.item, (d) => d.id, (d) => String(d.data.name ?? ''));
    if (!found) throw new UserError(ambiguous ? 'groceries.ambiguous' : 'groceries.notFound', { name: args.item, options: (ambiguous ?? []).map((d) => String(d.data.name)).join(', ') });
    const now = ctx.clock.now();
    const name = String(found.data.name);
    await ctx.session.db.commit([
      { path: found.path, merge: { completed: bought, completedAt: bought ? now : null, updatedAt: now } },
      ...(bought ? [{ path: `${base}/staples/${stapleKey(name)}`, merge: { displayName: name, category: found.data.category ?? 'Other', timesCompleted: new Increment(1) } }] : []),
    ]);
    ctx.touched('groceries', `items/${found.id}`);
    const list = shopping.find((l) => l.id === found.data.listId)!;
    return render(ctx.lang, () => ({
      text: t(bought ? 'groceries.checked' : 'groceries.unchecked', { name, list: list.name }),
      data: { id: found.id, name, list: list.id, bought },
    }));
  },
});

export const tasksAdd = defineTool({
  name: 'tasks_add',
  title: 'Add a task',
  description:
    'Adds a task to a household task list (Chores & Notes by default), as this person, as the Tasks app does. With `due` it shows on the calendar and gets a reminder. Helpers and kids add their own tasks too.',
  kind: 'write',
  input: {
    ...common,
    ...idempotency,
    name: z.string().min(1).max(200).describe('The task: "Drop off the dry cleaning".'),
    due: z.string().max(40).optional().describe('Local "YYYY-MM-DD" (any time that day) or "YYYY-MM-DDTHH:MM".'),
    by: z.boolean().optional().describe('With a time: due by then rather than at then.'),
    list: z.string().max(80).optional().describe('Task list name or id. Default Chores & Notes.'),
    notes: z.string().max(500).optional(),
    link: z.string().url().max(2000).optional().describe('A web link to show with it (https).'),
  },
  async run(ctx, args) {
    const list = chooseList(await lists(ctx), args.list, true);
    const when = args.due ? ctx.clock.parse(args.due) : null;
    if (args.due && !when) throw new UserError('error.badDate', { value: args.due });
    if (args.link && !/^https?:\/\/[^ ]+$/i.test(args.link)) throw new UserError('error.badLink');
    const now = ctx.clock.now();
    const id = await recordId(ctx.session.props.connectionId, 'tasks_add', args.idempotency_key);
    const name = clip(args.name, 200);
    const item = {
      listId: list.id,
      name,
      category: TASK_CATEGORY,
      quantity: '1',
      notes: clip(args.notes, 500),
      addedBy: await ctx.session.firstName(ctx.here.id),
      by: ctx.session.email,
      completed: false,
      urgency: 'Standard',
      position: now,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      ...(when ? { dueAt: when.at, allDay: when.allDay, dueBy: !when.allDay && args.by === true } : {}),
      ...(args.link ? { link: args.link } : {}),
      via: 'assistant',
    };
    let repeated = false;
    try {
      await ctx.session.db.commit([{ path: `households/${ctx.here.id}/items/${id}`, create: item }]);
    } catch (e) {
      if (!alreadyThere(e)) throw e;
      repeated = true;
    }
    ctx.touched('tasks', `items/${id}`);
    const url = itemsUrl(ctx, 'tasks', list.id, id);
    return render(ctx.lang, () => ({
      text: t(repeated ? 'tasks.alreadyAdded' : 'tasks.added', { name, list: list.name, url, due: when ? ctx.clock.isoLocal(when.at).slice(0, when.allDay ? 10 : 16).replace('T', ' ') : '-' }),
      data: { id, list: list.id, name, ...(when ? { due: ctx.clock.isoLocal(when.at), all_day: when.allDay } : {}), url, repeated },
    }));
  },
});

