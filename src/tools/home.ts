import { z } from 'zod';
import { addDays, daysBetween, dueText, longDate } from '@huishouden/pwa-kit/time';
import { cleanRule, describeRule, describeSchedule, eventOccurrences, isEventRule, isSchedule, type EventRule, type OccurrenceChanges } from '@huishouden/pwa-kit/schedule';
import { t } from '../i18n';
import { UserError } from '../context';
import { common, defineTool, idempotency, render, type ToolContext } from './registry';
import { alreadyThere, clip, recordId } from './shared';

/**
 * Huishouden Home: upkeep jobs (`homeTasks`, each with a schedule and a due day), regular events
 * (`homeEvents`: bins, the lawn service, on an EventRule) and the service history (`homeServiceLog`,
 * also booked visits). Shapes match the app's model (home src/lib/model.ts) and the rules.
 */

const EVENT_KINDS = ['trash', 'recycling', 'yard waste', 'lawn', 'hoa', 'cleaning', 'other'] as const;
const homeUrl = (ctx: ToolContext, tab: string) => ctx.session.link('home', `#${tab}`);

export const homeUpkeepDue = defineTool({
  name: 'home_upkeep_due',
  title: 'Home upkeep due',
  description:
    "Huishouden Home's upkeep jobs that are overdue or due within `days` (default 14): filters, gutters, pest control… with their schedules, plus the household's regular events (bins, lawn service) happening in that time. Mark a job done with `todo_done` (its to-do id is `home:job:<id>`).",
  kind: 'read',
  input: { ...common, days: z.number().int().min(1).max(365).optional().describe('How far ahead. Default 14.') },
  async run(ctx, args) {
    const base = `households/${ctx.here.id}`;
    const [tasks, events] = await Promise.all([ctx.session.db.query(base, 'homeTasks'), ctx.session.db.query(base, 'homeEvents')]);
    ctx.touched('home');
    const today = ctx.clock.today();
    const until = addDays(today, args.days ?? 14);
    const jobs = tasks
      .filter((d) => d.data.pausedAt === undefined && typeof d.data.due === 'string' && (d.data.due as string) <= until)
      .map((d) => ({ id: d.id, title: String(d.data.title ?? ''), category: String(d.data.category ?? 'other'), due: String(d.data.due), lastDone: typeof d.data.lastDone === 'string' ? d.data.lastDone : undefined, schedule: d.data.schedule }))
      .sort((a, b) => a.due.localeCompare(b.due) || a.title.localeCompare(b.title));
    const happenings = events.flatMap((d) => {
      if (!isEventRule(d.data.rule)) return [];
      const time = typeof d.data.time === 'string' ? d.data.time : undefined;
      return eventOccurrences(d.data.rule as EventRule, today, until, { time, changes: d.data.exceptions as OccurrenceChanges | undefined }).map((o) => ({ id: d.id, title: String(d.data.title ?? ''), kind: String(d.data.kind ?? 'other'), date: o.date, time: o.time, moved: o.moved, note: o.note }));
    }).sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? ''));
    return render(ctx.lang, () => ({
      text: [
        `**${t('home.title', { days: args.days ?? 14 })}** · ${ctx.here.name}`,
        '',
        ...(jobs.length ? jobs.map((j) => `- **${j.title}**: ${dueText(j.due, today)}${isSchedule(j.schedule) ? ` · ${describeSchedule(j.schedule)}` : ''}${j.lastDone ? ` · ${t('home.lastDone', { date: longDate(j.lastDone, today) })}` : ''} · to-do \`home:job:${j.id}\``) : [t('home.noJobs')]),
        ...(happenings.length ? ['', `**${t('home.events')}**`, ...happenings.slice(0, 30).map((h) => `- ${longDate(h.date, today)}${h.time ? ` ${h.time}` : ''}: ${h.title}${h.note ? ` (${h.note})` : ''}`)] : []),
        '',
        t('home.link', { url: homeUrl(ctx, 'upkeep') }),
      ].join('\n'),
      data: {
        household: ctx.here.id,
        jobs: jobs.map((j) => ({ ...j, overdue: daysBetween(today, j.due) < 0, todo_id: `home:job:${j.id}` })),
        events: happenings,
      },
    }));
  },
});

const weekdayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

export const homeAddEvent = defineTool({
  name: 'home_add_event',
  title: 'Add a home event',
  description:
    "Adds to Huishouden Home, as this person. `type: \"regular\"` is something on a schedule whether or not anyone does anything (garbage every Thursday, recycling every other Tuesday, the lawn service on the 1st and 3rd Friday → two events, HOA meeting the last Monday of the month). `type: \"visit\"` is one dated service visit, booked or done (\"Plumber coming on 2031-03-14\", \"Gutters cleaned yesterday, $180\").",
  kind: 'write',
  input: {
    ...common,
    ...idempotency,
    type: z.enum(['regular', 'visit']),
    title: z.string().min(1).max(120).describe('"Trash pickup", "Plumber: kitchen sink".'),
    kind: z.enum(EVENT_KINDS).optional().describe('Regular events: what it is. Default other.'),
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Regular: first day it happens. Visit: its day. Local YYYY-MM-DD.'),
    frequency: z.enum(['week', 'month', 'year']).optional().describe('Regular: repeats every week, month or year. Default week.'),
    every: z.number().int().min(1).max(99).optional().describe('Regular: every N weeks/months/years. Default 1.'),
    weekdays: z.array(z.enum(weekdayNames)).max(7).optional().describe('Regular, weekly: which days. Default the weekday of `start`.'),
    nth_weekday: z
      .object({ nth: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(-1)]), weekday: z.enum(weekdayNames) })
      .optional()
      .describe('Regular, monthly: "the 2nd Tuesday" ({nth: 2, weekday: "tuesday"}); -1 is the last. Default the day of the month of `start`.'),
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Regular: last day it can happen.'),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().describe('Regular: time of day "HH:MM".'),
    who: z.string().max(120).optional().describe('Visit: who comes (a company or person).'),
    cost: z.number().min(0).max(1_000_000).optional().describe('Visit: what it cost, in the household currency.'),
    notes: z.string().max(1000).optional(),
  },
  async run(ctx, args) {
    const now = ctx.clock.now();
    const id = await recordId(ctx.session.props.connectionId, 'home_add_event', args.idempotency_key);
    const base = `households/${ctx.here.id}`;
    const title = clip(args.title, 120);
    const notes = clip(args.notes, 1000);
    if (args.type === 'visit') {
      const who = clip(args.who, 120);
      const doc = {
        date: args.start,
        title,
        ...(who ? { who } : {}),
        ...(args.cost !== undefined ? { costCents: Math.round(args.cost * 100) } : {}),
        ...(notes ? { notes } : {}),
        createdAt: now,
        by: ctx.session.email,
        via: 'assistant',
      };
      const repeated = await create(ctx, `${base}/homeServiceLog/${id}`, doc);
      ctx.touched('home', `homeServiceLog/${id}`);
      return render(ctx.lang, () => ({ text: t('home.visitAdded', { title, date: longDate(args.start, ctx.clock.today()), url: homeUrl(ctx, 'history') }), data: { id, type: 'visit', date: args.start, repeated } }));
    }
    const freq = args.frequency ?? 'week';
    const rule = cleanRule({
      freq,
      every: args.every ?? 1,
      start: args.start,
      ...(freq === 'week' && args.weekdays?.length ? { days: args.weekdays.map((d) => weekdayNames.indexOf(d)) } : {}),
      ...(freq === 'month' && args.nth_weekday ? { nth: args.nth_weekday.nth, weekday: weekdayNames.indexOf(args.nth_weekday.weekday) } : {}),
      ...(args.until ? { until: args.until } : {}),
    });
    if (!isEventRule(rule) || (rule.until && rule.until < rule.start)) throw new UserError('home.badRule');
    const doc = {
      title,
      kind: args.kind ?? 'other',
      rule,
      ...(args.time ? { time: args.time } : {}),
      ...(notes ? { notes } : {}),
      createdAt: now,
      by: ctx.session.email,
      via: 'assistant',
    };
    const repeated = await create(ctx, `${base}/homeEvents/${id}`, doc);
    ctx.touched('home', `homeEvents/${id}`);
    const next = eventOccurrences(rule, ctx.clock.today(), addDays(ctx.clock.today(), 400), { time: args.time })[0];
    return render(ctx.lang, () => ({
      text: t('home.eventAdded', { title, rule: describeRule(rule), next: next ? longDate(next.date, ctx.clock.today()) : '-', url: homeUrl(ctx, 'regular') }),
      data: { id, type: 'regular', rule, next: next?.date ?? null, repeated },
    }));
  },
});

async function create(ctx: ToolContext, path: string, doc: Record<string, unknown>): Promise<boolean> {
  try {
    await ctx.session.db.commit([{ path, create: doc }]);
    return false;
  } catch (e) {
    if (alreadyThere(e)) return true;
    throw e;
  }
}

export { create };
