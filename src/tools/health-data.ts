import { asNeededCheck, adherence, doseSlots, doubleDoseWindowMs, recentlyGiven, slotStatuses, type Adherence, type DoseLog, type ScheduleCourse, type SlotStatus } from '@huishouden/pwa-kit/dose';
import { cleanRule, describeRule, isEventRule, type EventRule } from '@huishouden/pwa-kit/schedule';
import { addDays, agoWords, clockWords, DAY, toHhmm, toYmd, ymdToTime, type Ymd } from '@huishouden/pwa-kit/time';
import { formatList } from '@huishouden/pwa-kit/i18n';
import { t } from '../i18n';
import type { ToolContext } from './registry';

/**
 * Huishouden Health's people, medicines and doses, read as the person may (admins everyone, carers
 * and the person themself their own; kids and other members nothing), and the app's own logic
 * ported from health src/lib/meds.ts: schedules, supply, refills, the double-dose and as-needed
 * guards, adherence. Every time given to the kit is in the local frame (../clock), so slot keys
 * ("2031-01-05T08:00") and days are the person's own, as on their phone.
 */

export interface Person {
  id: string;
  name: string;
  birthDate?: Ymd;
  email?: string;
  carers: string[];
  readers: string[];
  allergies?: string;
  notes?: string;
}

export interface Med {
  id: string;
  personId: string;
  name: string;
  strength?: string;
  dose?: string;
  doseAmount?: number;
  doseUnit?: string;
  asNeeded: boolean;
  times: string[];
  everyDays?: number;
  rule?: EventRule;
  minHours?: number;
  maxPerDay?: number;
  withFood?: boolean;
  startDate: Ymd;
  endDate?: Ymd;
  prescriberId?: string;
  pharmacyId?: string;
  refills?: number;
  supply?: number;
  supplyAt?: number;
  refillOrderedAt?: number;
  escalateMinutes: number;
  remind: boolean;
  notes?: string;
  createdAt: number;
  by: string;
}

/** A dose record; `at` absolute. */
export interface Dose extends DoseLog {
  id: string;
  medId: string;
  personId: string;
  slot?: string;
  at: number;
  status: 'given' | 'skipped';
  note?: string;
  by: string;
}

/** A dose is due from 30 minutes before its time until two hours after; then it is missed (health meds.ts WINDOW). */
export const WINDOW = { earlyMinutes: 30, graceMinutes: 120 };
export const LOW_SUPPLY_DAYS = 7;
export const DEFAULT_ESCALATE_MINUTES = 30;

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function toPerson(id: string, d: Record<string, unknown>): Person {
  return { id, name: String(d.name ?? ''), birthDate: str(d.birthDate), email: str(d.email), carers: strings(d.carers), readers: strings(d.readers), allergies: str(d.allergies), notes: str(d.notes) };
}

export function toMed(id: string, d: Record<string, unknown>): Med {
  return {
    id,
    personId: String(d.personId ?? ''),
    name: String(d.name ?? ''),
    strength: str(d.strength),
    dose: str(d.dose),
    doseAmount: num(d.doseAmount),
    doseUnit: str(d.doseUnit),
    asNeeded: d.asNeeded === true,
    times: [...new Set(strings(d.times))].sort(),
    everyDays: num(d.everyDays),
    rule: isEventRule(d.rule) ? (d.rule as EventRule) : undefined,
    minHours: num(d.minHours),
    maxPerDay: num(d.maxPerDay),
    withFood: typeof d.withFood === 'boolean' ? d.withFood : undefined,
    startDate: String(d.startDate ?? ''),
    endDate: str(d.endDate),
    prescriberId: str(d.prescriberId),
    pharmacyId: str(d.pharmacyId),
    refills: num(d.refills),
    supply: num(d.supply),
    supplyAt: num(d.supplyAt),
    refillOrderedAt: num(d.refillOrderedAt),
    escalateMinutes: num(d.escalateMinutes) ?? DEFAULT_ESCALATE_MINUTES,
    remind: d.remind === true,
    notes: str(d.notes),
    createdAt: num(d.createdAt) ?? 0,
    by: String(d.by ?? ''),
  };
}

export function toDose(id: string, d: Record<string, unknown>): Dose {
  return { id, medId: String(d.medId ?? ''), personId: String(d.personId ?? ''), ...(str(d.slot) ? { slot: str(d.slot) } : {}), at: num(d.at) ?? 0, status: d.status === 'skipped' ? 'skipped' : 'given', ...(str(d.note) ? { note: str(d.note) } : {}), by: String(d.by ?? '') };
}

const personPath = (ctx: ToolContext, id: string) => `households/${ctx.here.id}/healthPeople/${id}`;

/** The people this person may read: everyone for admins, else those listing them as a reader; kids none. */
export async function loadPeople(ctx: ToolContext): Promise<Person[]> {
  if (ctx.here.role === 'kid') return [];
  const docs =
    ctx.here.role === 'admin'
      ? await ctx.session.db.query(`households/${ctx.here.id}`, 'healthPeople')
      : await ctx.session.db.query(`households/${ctx.here.id}`, 'healthPeople', { where: [{ field: 'readers', op: 'ARRAY_CONTAINS', value: ctx.session.email }] });
  return docs.map((d) => toPerson(d.id, d.data)).sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadMeds(ctx: ToolContext, person: Person): Promise<Med[]> {
  return (await ctx.session.db.query(personPath(ctx, person.id), 'meds')).map((d) => toMed(d.id, d.data));
}

/** Doses since `since` (absolute ms). */
export async function loadDoses(ctx: ToolContext, person: Person, since: number): Promise<Dose[]> {
  return (await ctx.session.db.query(personPath(ctx, person.id), 'doses', { where: [{ field: 'at', op: 'GREATER_THAN_OR_EQUAL', value: since }] })).map((d) => toDose(d.id, d.data));
}

export const personUrl = (ctx: ToolContext, personId: string, tab = 'today') => ctx.session.link('health', `?tab=${tab}&person=${encodeURIComponent(personId)}`);
export const medUrl = (ctx: ToolContext, med: Pick<Med, 'id' | 'personId'>) => ctx.session.link('health', `?tab=medicines&person=${encodeURIComponent(med.personId)}&med=${encodeURIComponent(med.id)}`);
export const printUrl = (ctx: ToolContext, personId: string) => ctx.session.link('health', `?print=${encodeURIComponent(personId)}`);

/** Same id for the same slot from any device (health meds.ts `doseId`). */
export const doseId = (medId: string, slot: string) => `${medId}_${slot.replace(/[^0-9T-]/g, '')}`;

export function scheduleOf(m: Med): ScheduleCourse {
  return { startDate: m.startDate, times: m.asNeeded ? [] : m.times, ...(m.rule ? { rule: m.rule } : { everyDays: m.everyDays ?? 1 }), ...(m.endDate ? { until: m.endDate } : {}) };
}

/** Logs in the local frame, for the kit's day and slot logic. */
export const localLogs = (ctx: ToolContext, doses: readonly Dose[]): Dose[] => doses.map((d) => ({ ...d, at: ctx.clock.local(d.at) }));

export const logsOf = <D extends { medId: string }>(doses: readonly D[], medId: string) => doses.filter((d) => d.medId === medId);

/** `today` and every `Ymd` here are local; `localNow` local-frame ms. */
export const isStopped = (m: Pick<Med, 'endDate'>, today: Ymd) => !!m.endDate && m.endDate < today;
export const isCurrent = (m: Pick<Med, 'startDate' | 'endDate'>, day: Ymd) => m.startDate <= day && (!m.endDate || m.endDate >= day);

export function supplyLeft(m: Med, doses: readonly Dose[]): number | null {
  if (m.supply === undefined) return null;
  const since = m.supplyAt ?? m.createdAt;
  const used = logsOf(doses, m.id).filter((d) => d.status === 'given' && d.at >= since).length * (m.doseAmount ?? 1);
  return Math.max(0, m.supply - used);
}

/** Units used on an average day: scheduled doses over the next four weeks, or as needed the last two. Local-frame `localNow`, absolute `now`. */
export function dailyUse(m: Med, doses: readonly Dose[], now: number, localNow: number): number | null {
  const amount = m.doseAmount ?? 1;
  if (m.asNeeded) {
    const recent = logsOf(doses, m.id).filter((d) => d.status === 'given' && d.at > now - 14 * DAY && d.at <= now).length;
    return recent ? (recent * amount) / 14 : null;
  }
  const slots = doseSlots(scheduleOf(m), localNow, localNow + 28 * DAY).length;
  return slots ? (slots * amount) / 28 : null;
}

export function daysLeft(m: Med, doses: readonly Dose[], now: number, localNow: number): number | null {
  const left = supplyLeft(m, doses);
  const use = dailyUse(m, doses, now, localNow);
  if (left === null || !use) return null;
  return Math.floor(left / use);
}

export function refillDue(m: Med, doses: readonly Dose[], now: number, localNow: number): boolean {
  if (isStopped(m, toYmd(localNow))) return false;
  const days = daysLeft(m, doses, now, localNow);
  if (days === null || days > LOW_SUPPLY_DAYS) return false;
  return !(m.refillOrderedAt && m.refillOrderedAt >= (m.supplyAt ?? m.createdAt));
}

// ---- Words (inside `render`) ----

export const medLabel = (m: Pick<Med, 'name' | 'strength'>) => [m.name, m.strength].filter(Boolean).join(' ');

export function scheduleText(m: Med): string {
  if (m.asNeeded) {
    const parts = [t('meds.asNeeded')];
    if (m.minHours) parts.push(t('meds.minHours', { count: m.minHours }));
    if (m.maxPerDay) parts.push(t('meds.maxPerDay', { count: m.maxPerDay }));
    return parts.join(', ');
  }
  const days = m.rule ? describeRule(m.rule) : t('meds.everyDays', { count: m.everyDays ?? 1 });
  if (!m.times.length) return days;
  const times = m.times.map((x) => clockWords(x));
  return t('meds.daysAtTimes', { days, times: formatList(times), one: /^1(?!\d)/.test(times[0]) ? 'yes' : 'no' });
}

export const doseText = (m: Pick<Med, 'dose' | 'withFood'>) => [m.dose, m.withFood === true ? t('meds.withFood') : m.withFood === false ? t('meds.emptyStomach') : ''].filter(Boolean).join(', ');

export function daysLeftText(days: number): string {
  return days < 1 ? t('meds.lessThanDay') : t('meds.daysLeft', { count: days });
}

export function ageOn(birthDate: Ymd | undefined, today: Ymd): number | null {
  if (!birthDate) return null;
  const [by, bm, bd] = birthDate.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  const age = ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
  return age >= 0 && age < 150 ? age : null;
}

/** The scheduled doses of current medicines from `fromDay` to `toDay` (local days), with what happened. */
export function rowsBetween(ctx: ToolContext, meds: readonly Med[], doses: readonly Dose[], fromDay: Ymd, toDay: Ymd): (SlotStatus<Dose> & { med: Med })[] {
  const localNow = ctx.clock.localNow();
  const logs = localLogs(ctx, doses);
  const from = ymdToTime(fromDay);
  const to = ymdToTime(addDays(toDay, 1)) - 1;
  return meds
    .filter((m) => !m.asNeeded)
    .flatMap((med) => slotStatuses(scheduleOf(med), logsOf(logs, med.id), from, to, localNow, WINDOW).map((row) => ({ ...row, med })))
    .sort((a, b) => a.slot.at - b.slot.at || medLabel(a.med).localeCompare(medLabel(b.med)));
}

export function adherenceOf(ctx: ToolContext, m: Med, doses: readonly Dose[], fromDay: Ymd, toDay: Ymd): Adherence {
  const localNow = ctx.clock.localNow();
  return adherence(scheduleOf(m), logsOf(localLogs(ctx, doses), m.id), ymdToTime(fromDay), ymdToTime(addDays(toDay, 1)) - 1, localNow, WINDOW);
}

/**
 * The app's warning before a dose is marked given (health meds.ts `guardFor`): as needed, too soon
 * or too many in 24 hours; scheduled, that slot (or any dose within half the gap between doses)
 * already given. Health asks and lets the carer give it anyway; so does the connector, through
 * `confirm`. Call inside `render`.
 */
export function guardFor(ctx: ToolContext, m: Med, doses: readonly Dose[], at: number, nameOf: (email: string) => string, slot?: string): string | null {
  const logs = logsOf(doses, m.id);
  if (m.asNeeded) {
    const check = asNeededCheck(logs, at, { minHours: m.minHours, maxPerDay: m.maxPerDay });
    if (check.ok) return null;
    const nextLocal = ctx.clock.local(check.nextAt);
    const next = t(toYmd(nextLocal) !== toYmd(ctx.clock.local(at)) ? 'guard.nextTomorrow' : 'guard.next', { time: clockWords(toHhmm(nextLocal)) });
    if (check.reason === 'max-reached') return `${t('guard.max', { count: check.inLastDay, med: medLabel(m) })} ${next}`;
    return `${t('guard.tooSoon', { ago: agoWords(check.last!, at), med: medLabel(m), count: m.minHours ?? 0 })} ${next}`;
  }
  const same = slot ? logs.find((l) => l.slot === slot && l.status === 'given') : undefined;
  const recent = same ?? recentlyGiven(logs, at, doubleDoseWindowMs(m.times));
  if (!recent) return null;
  return t('guard.already', { med: medLabel(m), ago: agoWords(recent.at, at), name: nameOf(recent.by) });
}

export { cleanRule, isEventRule };
