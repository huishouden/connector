import { z } from 'zod';
import { agendaDays, agendaInRange, agendaTime, agendaWords, todayItems, type AgendaItem } from '@huishouden/pwa-kit/agenda-core';
import { canDo, olderThan, sortTodos, todoDueText, todoOverdue, todoWords, type TodoItem, type TodoSort } from '@huishouden/pwa-kit/todo-core';
import { roleLabel } from '@huishouden/pwa-kit/role-core';
import { LANG_NAMES } from '@huishouden/pwa-kit/i18n';
import { addDays, toYmd, ymdToTime, DAY, longDate } from '@huishouden/pwa-kit/time';
import { t } from '../i18n';
import { UserError } from '../context';
import { common, defineTool, render, type ToolContext } from './registry';
import { agendaLine, loadAgenda, loadTodos } from './shared';

/** The app's name in the reader's language ("Tareas"), or its id. Call inside `render`. */
export function appName(app: string): string {
  const key = `app.${app}` as Parameters<typeof t>[0];
  const name = t(key);
  return name === key ? app : name;
}

function todoLine(ctx: ToolContext, item: TodoItem): string {
  const words = todoWords(item);
  const parts = [appName(item.app), item.who, words.detail, item.due !== undefined ? todoDueText({ due: ctx.clock.local(item.due) }, ctx.clock.localNow()) : undefined].filter(Boolean);
  const actions = [
    canDo(item, 'done', ctx.here.role, ctx.session.email) && words.done ? `todo_done: "${words.done}"` : '',
    canDo(item, 'cancel', ctx.here.role, ctx.session.email) && words.cancel ? `todo_cancel: "${words.cancel}"` : '',
  ].filter(Boolean);
  return `- [${words.title}](${item.url}) · ${parts.join(' · ')} · id \`${item.id}\`${actions.length ? ` · ${actions.join(', ')}` : ''}`;
}

function todoData(ctx: ToolContext, item: TodoItem) {
  const words = todoWords(item);
  return {
    id: item.id,
    app: item.app,
    title: words.title,
    ...(words.detail ? { detail: words.detail } : {}),
    ...(item.who ? { who: item.who } : {}),
    ...(item.due !== undefined ? { due: ctx.clock.isoLocal(item.due).slice(0, 10), overdue: todoOverdue({ due: ctx.clock.local(item.due), status: item.status }, ctx.clock.localNow()) } : {}),
    added: ctx.clock.isoLocal(item.createdAt).slice(0, 10),
    status: item.status,
    url: item.url,
    can_done: canDo(item, 'done', ctx.here.role, ctx.session.email),
    can_cancel: canDo(item, 'cancel', ctx.here.role, ctx.session.email),
  };
}

function agendaData(item: AgendaItem, ctx: ToolContext, when?: string) {
  const { title, detail } = agendaWords(item);
  return {
    app: item.app,
    kind: item.kind,
    title,
    ...(detail ? { detail } : {}),
    start: new Date(item.start).toISOString().slice(0, item.allDay ? 10 : 16),
    ...(item.end !== undefined ? { end: new Date(item.end).toISOString().slice(0, item.allDay ? 10 : 16) } : {}),
    all_day: item.allDay,
    ...(item.who ? { who: item.who } : {}),
    ...(when ? { when } : {}),
    ...(item.status ? { status: item.status } : {}),
    url: item.url,
    time_zone: ctx.clock.timeZone,
  };
}

export const households = defineTool({
  name: 'households',
  title: 'Who am I and my households',
  description:
    "Who is signed in, the Huishouden households they belong to (id, name, their role: admin, member, helper or kid), their language and time zone, and links to the apps. Call this first when unsure which household to use; every other tool takes `household` and defaults to the one the apps open.",
  kind: 'read',
  input: { lang: common.lang },
  async run(ctx) {
    const all = await ctx.session.households();
    const rows = all.map((h) => ({ id: h.id, name: h.name, role: h.id === ctx.here.id ? ctx.here.role : null, default: h.id === ctx.here.id }));
    const text = render(ctx.lang, () =>
      [
        t('households.signedInAs', { email: ctx.session.email }),
        '',
        ...all.map((h) => `- **${h.name}** (id \`${h.id}\`)${h.id === ctx.here.id ? ` · ${roleLabel(ctx.here.role)} · ${t('households.default')}` : ''}`),
        '',
        t('households.settings', { lang: LANG_NAMES[ctx.lang], zone: ctx.clock.timeZone }),
        t('households.portal', { url: ctx.session.link('').replace(/\/\/$/, '/') }),
      ].join('\n'),
    );
    return { text, data: { email: ctx.session.email, households: rows, role: ctx.here.role, lang: ctx.lang, time_zone: ctx.clock.timeZone } };
  },
});

export const today = defineTool({
  name: 'today',
  title: "What's on today",
  description:
    "The household's day, as the portal's Today screen shows it to this person: what is overdue, today's appointments, feeds, doses, bins and jobs, the next 48 hours, and the open to-dos (overdue first). Use it for questions like \"what's on today?\" or \"what do I need to do?\".",
  kind: 'read',
  input: { ...common },
  async run(ctx) {
    const [agenda, todos] = await Promise.all([loadAgenda(ctx.session, ctx.here, ctx.clock), loadTodos(ctx.session, ctx.here)]);
    const now = ctx.clock.localNow();
    const open = sortTodos(
      todos.filter((i) => i.status === 'open'),
      'due',
    );
    return render(ctx.lang, () => {
      const entries = todayItems(agenda, now);
      const groups = (['overdue', 'today', 'soon'] as const).map((g) => ({ g, items: entries.filter((e) => e.group === g) }));
      const lines = [`**${t('today.title', { day: longDate(toYmd(now)) })}** · ${ctx.here.name}`];
      for (const { g, items } of groups) {
        if (!items.length) continue;
        lines.push('', `**${t(`today.${g}`)}**`, ...items.map((e) => agendaLine(e.item, e.when)));
      }
      if (!entries.length) lines.push('', t('today.nothing'));
      const overdueTodos = open.filter((i) => todoOverdue({ due: i.due === undefined ? undefined : ctx.clock.local(i.due), status: i.status }, now));
      lines.push('', `**${t('today.todos', { count: open.length, overdue: overdueTodos.length })}**`, ...open.slice(0, 15).map((i) => todoLine(ctx, i)));
      if (open.length > 15) lines.push(t('today.moreTodos', { count: open.length - 15 }));
      lines.push('', t('today.links', { today: ctx.session.link('').replace(/\/\/$/, '/'), todo: `${ctx.session.siteUrl.replace(/\/$/, '')}/todo` }));
      return {
        text: lines.join('\n'),
        data: {
          household: ctx.here.id,
          date: toYmd(now),
          time_zone: ctx.clock.timeZone,
          agenda: entries.map((e) => ({ group: e.group, ...agendaData(e.item, ctx, e.when) })),
          todos: open.slice(0, 50).map((i) => todoData(ctx, i)),
        },
      };
    });
  },
});

export const calendar = defineTool({
  name: 'calendar',
  title: 'Household calendar',
  description:
    "Everything dated on the household's calendar between two days: appointments (pet, baby, car, health), bills, renewals, birthdays, upkeep, bins, meal plans and dated tasks, by day. Dates are the person's local days (YYYY-MM-DD). Default: today and the next 7 days. At most 62 days.",
  kind: 'read',
  input: {
    ...common,
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('First day, YYYY-MM-DD. Default today.'),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Last day, YYYY-MM-DD. Default 7 days after `from`.'),
    apps: z.array(z.enum(['tasks', 'groceries', 'pet', 'baby', 'home', 'car', 'bills', 'health', 'spending', 'assistant'])).optional().describe('Only these apps.'),
  },
  async run(ctx, args) {
    const today = ctx.clock.today();
    const from = args.from ?? today;
    const to = args.to ?? addDays(from, 7);
    if (to < from) throw new UserError('error.rangeBackwards');
    if ((ymdToTime(to) - ymdToTime(from)) / DAY > 62) throw new UserError('error.rangeTooLong', { days: 62 });
    const agenda = await loadAgenda(ctx.session, ctx.here, ctx.clock);
    const now = ctx.clock.localNow();
    const range = agendaInRange(agenda, { from: ymdToTime(from), to: ymdToTime(addDays(to, 1)), apps: args.apps });
    return render(ctx.lang, () => {
      const days = agendaDays(range, now, { from, to });
      const lines = [`**${t('calendar.title', { from: longDate(from), to: longDate(to) })}** · ${ctx.here.name}`];
      for (const day of days) lines.push('', `**${day.label}**`, ...day.items.map((i) => agendaLine(i, agendaTime(i))));
      if (!days.length) lines.push('', t('calendar.nothing'));
      lines.push('', t('calendar.link', { url: `${ctx.session.siteUrl.replace(/\/$/, '')}/calendar` }));
      return {
        text: lines.join('\n'),
        data: { household: ctx.here.id, from, to, time_zone: ctx.clock.timeZone, days: days.map((d) => ({ day: d.day, items: d.items.map((i) => agendaData(i, ctx)) })) },
      };
    });
  },
});

export const todos = defineTool({
  name: 'todos',
  title: 'To-do list',
  description:
    "The household's open to-dos from every app (tasks, upkeep, pet care, bills, car renewals, baby checklists, missed doses, refills), as the portal's To-do list shows them to this person. Each has an `id` for `todo_done` / `todo_cancel` and says whether this person may do each.",
  kind: 'read',
  input: {
    ...common,
    filter: z.enum(['all', 'overdue', 'due_soon', 'older_than_30_days', 'undated']).optional().describe('Default all.'),
    app: z.enum(['tasks', 'groceries', 'pet', 'baby', 'home', 'car', 'bills', 'health']).optional().describe('Only this app.'),
    sort: z.enum(['newest', 'oldest', 'due', 'app']).optional().describe('Default due (soonest first, undated last).'),
    limit: z.number().int().min(1).max(100).optional().describe('Default 40.'),
  },
  async run(ctx, args) {
    const all = await loadTodos(ctx.session, ctx.here);
    const now = ctx.clock.now();
    const local = (i: TodoItem) => ({ ...i, due: i.due === undefined ? undefined : ctx.clock.local(i.due) });
    const filter = args.filter ?? 'all';
    const keep = all.filter((i) => {
      if (args.app && i.app !== args.app) return false;
      if (filter === 'overdue') return todoOverdue(local(i), ctx.clock.localNow());
      if (filter === 'due_soon') return i.due !== undefined && i.due <= now + 7 * DAY;
      if (filter === 'older_than_30_days') return olderThan(i, now);
      if (filter === 'undated') return i.due === undefined;
      return true;
    });
    const sorted = sortTodos(keep, (args.sort ?? 'due') as TodoSort, ['tasks', 'groceries', 'pet', 'baby', 'health', 'home', 'car', 'bills']);
    const shown = sorted.slice(0, args.limit ?? 40);
    return render(ctx.lang, () => ({
      text: [
        `**${t('todos.title', { count: keep.filter((i) => i.status === 'open').length })}** · ${ctx.here.name}`,
        '',
        ...(shown.length ? shown.map((i) => (i.status === 'info' ? `- ${todoWords(i).title}${todoWords(i).detail ? ` (${todoWords(i).detail})` : ''}` : todoLine(ctx, i))) : [t('todos.none')]),
        ...(sorted.length > shown.length ? ['', t('today.moreTodos', { count: sorted.length - shown.length })] : []),
      ].join('\n'),
      data: { household: ctx.here.id, todos: shown.map((i) => todoData(ctx, i)), total: sorted.length },
    }));
  },
});
