import { z } from 'zod';
import { addDays, atTime, daysBetween, dueText, formatTime, toYmd, type Ymd } from '@huishouden/pwa-kit/time';
import { addInterval, type Unit } from '@huishouden/pwa-kit/schedule';
import { t } from '../i18n';
import { UserError } from '../context';
import type { Doc } from '@huishouden/pwa-kit/firestore-rest';
import { common, defineTool, idempotency, render, type ToolContext } from './registry';
import { alreadyThere, clip, pick, recordId } from './shared';

/**
 * Huishouden Pet, read and written as the app does (pet src/lib: today.ts, feeding.ts,
 * schedule.ts, courses.ts; src/lib/build.ts for the documents). Days are the person's local days:
 * every time is moved into the local frame (../clock) before the kit's day logic reads it.
 */

interface Pet {
  id: string;
  name: string;
  species: string;
}
interface Meal {
  id: string;
  petId: string;
  name: string;
  time: string;
  food?: string;
  portion?: string;
}
interface Reminder {
  id: string;
  petId: string;
  kind: string;
  title: string;
  every?: number;
  unit?: Unit;
  due: Ymd;
  lastDoneAt?: number;
  dismissedAt?: number;
}
interface Course {
  id: string;
  petId: string;
  name: string;
  dose: string;
  times: string[];
  startDate: Ymd;
  days: number;
  withFood: boolean;
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

const MED_KINDS = ['flea-tick', 'heartworm', 'deworming', 'medication'];

interface PetData {
  pets: Pet[];
  meals: Meal[];
  feedings: Doc[];
  reminders: Reminder[];
  courses: Course[];
  medDoses: Doc[];
}

async function load(ctx: ToolContext, sinceLocalDay: Ymd): Promise<PetData> {
  const base = `households/${ctx.here.id}`;
  const db = ctx.session.db;
  // Feeds and doses of the last two days are all "today" needs (absolute ms, a day's margin for zones).
  const since = ctx.clock.utc(Date.parse(`${addDays(sinceLocalDay, -1)}T00:00:00Z`));
  const [pets, meals, feedings, reminders, courses, medDoses] = await Promise.all([
    db.query(base, 'petProfiles'),
    db.query(base, 'petMeals'),
    db.query(base, 'petFeedings', { where: [{ field: 'at', op: 'GREATER_THAN_OR_EQUAL', value: since }] }),
    db.query(base, 'petReminders'),
    db.query(base, 'petMedCourses'),
    db.query(base, 'petMedDoses', { where: [{ field: 'at', op: 'GREATER_THAN_OR_EQUAL', value: since }] }),
  ]);
  return {
    pets: pets.map((d) => ({ id: d.id, name: String(d.data.name ?? ''), species: String(d.data.species ?? 'other') })).sort((a, b) => a.name.localeCompare(b.name)),
    meals: meals
      .map((d) => ({ id: d.id, petId: String(d.data.petId), name: String(d.data.name ?? ''), time: String(d.data.time ?? '00:00'), food: str(d.data.food), portion: str(d.data.portion) }))
      .sort((a, b) => a.time.localeCompare(b.time) || a.name.localeCompare(b.name)),
    feedings,
    reminders: reminders.map((d) => ({
      id: d.id,
      petId: String(d.data.petId),
      kind: String(d.data.kind ?? 'other'),
      title: String(d.data.title ?? ''),
      every: num(d.data.every),
      unit: str(d.data.unit) as Unit | undefined,
      due: String(d.data.due ?? ''),
      lastDoneAt: num(d.data.lastDoneAt),
      dismissedAt: num(d.data.dismissedAt),
    })),
    courses: courses.map((d) => ({
      id: d.id,
      petId: String(d.data.petId),
      name: String(d.data.name ?? ''),
      dose: String(d.data.dose ?? ''),
      times: [...new Set(Array.isArray(d.data.times) ? (d.data.times as string[]) : [])].sort().slice(0, 6),
      startDate: String(d.data.startDate ?? ''),
      days: num(d.data.days) ?? 0,
      withFood: d.data.withFood === true,
    })),
    medDoses,
  };
}

const isRecurring = (r: Pick<Reminder, 'every' | 'unit'>) => !!r.unit && typeof r.every === 'number' && r.every >= 1;
function leadDays(r: Pick<Reminder, 'every' | 'unit'>): number {
  if (r.unit === 'year') return 30;
  if (r.unit === 'day' || (r.unit === 'week' && (r.every ?? 1) === 1)) return 2;
  return 7;
}
type DueState = 'overdue' | 'today' | 'soon' | 'later' | 'done' | 'dismissed';
function reminderState(r: Reminder, today: Ymd): DueState {
  if (r.dismissedAt !== undefined) return 'dismissed';
  if (!isRecurring(r) && r.lastDoneAt !== undefined) return 'done';
  const days = daysBetween(today, r.due);
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  return days <= leadDays(r) ? 'soon' : 'later';
}

/** Each meal of `day` for a pet: fed (the latest feed for it that day) or due / late. Local frame. */
function mealsOn(ctx: ToolContext, data: PetData, petId: string, day: Ymd, localNow: number) {
  const fed = data.feedings.filter((f) => f.data.petId === petId && typeof f.data.mealId === 'string' && toYmd(ctx.clock.local(Number(f.data.at))) === day);
  return data.meals
    .filter((m) => m.petId === petId)
    .map((meal) => {
      const last = fed.filter((f) => f.data.mealId === meal.id).sort((a, b) => Number(b.data.at) - Number(a.data.at))[0];
      const at = atTime(day, meal.time);
      return { meal, at, state: last ? ('fed' as const) : localNow > at ? ('late' as const) : ('due' as const), fedAt: last ? ctx.clock.local(Number(last.data.at)) : undefined, by: last ? String(last.data.by ?? '') : undefined };
    });
}

/** A course's slots on `day`: given, skipped, missed or due. Local frame. */
function courseSlots(ctx: ToolContext, data: PetData, course: Course, day: Ymd, localNow: number) {
  const n = daysBetween(course.startDate, day) + 1;
  if (n < 1 || n > course.days) return [];
  const doses = data.medDoses.filter((d) => d.data.courseId === course.id && toYmd(ctx.clock.local(Number(d.data.at))) === day);
  return course.times.map((time, slot) => {
    const mine = doses.filter((d) => d.data.slot === slot).sort((a, b) => Number(b.data.at) - Number(a.data.at));
    const given = mine.find((d) => d.data.skipped !== true);
    const at = atTime(day, time);
    const state = given ? ('given' as const) : mine.length ? ('skipped' as const) : localNow > at ? ('missed' as const) : ('due' as const);
    return { slot, time, at, state };
  });
}

function choosePet(pets: Pet[], wanted?: string): Pet[] {
  if (!wanted) return pets;
  const { found, ambiguous } = pick(pets, wanted, (p) => p.id, (p) => p.name);
  if (found) return [found];
  throw new UserError(ambiguous ? 'pet.ambiguous' : 'pet.unknown', { name: wanted, pets: pets.map((p) => p.name).join(', ') });
}

const petUrl = (ctx: ToolContext, query = '') => ctx.session.link('pet', query);

export const petToday = defineTool({
  name: 'pet_today',
  title: "Pets today",
  description:
    "Each pet's day in Huishouden Pet: meals on the feeding board (fed, due or late, and by whom), care reminders overdue, due today or coming up (flea and tick, heartworm, vaccines…), and today's medicine-course doses. Meal, reminder and course names are what `pet_log_feeding` and `pet_log_dose` take.",
  kind: 'read',
  input: { ...common, pet: z.string().max(60).optional().describe('One pet by name or id. Default all.') },
  async run(ctx, args) {
    const today = ctx.clock.today();
    const data = await load(ctx, today);
    const pets = choosePet(data.pets, args.pet);
    const localNow = ctx.clock.localNow();
    ctx.touched('pet');
    return render(ctx.lang, () => {
      const lines = [`**${t('pet.title')}** · ${ctx.here.name}`];
      const out = pets.map((p) => {
        const meals = mealsOn(ctx, data, p.id, today, localNow);
        const reminders = data.reminders
          .filter((r) => r.petId === p.id)
          .map((r) => ({ r, state: reminderState(r, today) }))
          .filter((x) => ['overdue', 'today', 'soon'].includes(x.state))
          .sort((a, b) => a.r.due.localeCompare(b.r.due));
        const courses = data.courses.filter((c) => c.petId === p.id).map((c) => ({ c, slots: courseSlots(ctx, data, c, today, localNow) })).filter((x) => x.slots.length);
        lines.push('', `**[${p.name}](${petUrl(ctx, `?tab=pets&pet=${encodeURIComponent(p.id)}`)})**`);
        for (const m of meals)
          lines.push(
            `- ${t('pet.meal', { name: m.meal.name, time: formatTime(atTime(today, m.meal.time)) })}: ${m.state === 'fed' ? t('pet.fed', { time: formatTime(m.fedAt!), who: m.by ?? '' }) : t(m.state === 'late' ? 'pet.late' : 'pet.due')}${m.meal.portion ? ` · ${m.meal.portion}` : ''}${m.meal.food ? ` ${m.meal.food}` : ''}`,
          );
        for (const { r, state } of reminders) lines.push(`- ${r.title}: ${dueText(r.due, today)}${state === 'overdue' ? ' ⚠' : ''}`);
        for (const { c, slots } of courses) lines.push(`- ${c.name} (${c.dose}): ${slots.map((s) => `${formatTime(s.at)} ${t(`pet.slot.${s.state}`)}`).join(', ')}`);
        if (!meals.length && !reminders.length && !courses.length) lines.push(`- ${t('pet.nothing')}`);
        return {
          id: p.id,
          name: p.name,
          species: p.species,
          meals: meals.map((m) => ({ id: m.meal.id, name: m.meal.name, time: m.meal.time, state: m.state, ...(m.fedAt ? { fed_at: new Date(m.fedAt).toISOString().slice(11, 16), fed_by: m.by } : {}) })),
          reminders: reminders.map(({ r, state }) => ({ id: r.id, title: r.title, kind: r.kind, due: r.due, state, medicine: MED_KINDS.includes(r.kind) })),
          courses: courses.map(({ c, slots }) => ({ id: c.id, name: c.name, dose: c.dose, slots: slots.map((s) => ({ slot: s.slot, time: s.time, state: s.state })) })),
        };
      });
      if (!pets.length) lines.push('', t('pet.none'));
      lines.push('', t('pet.link', { url: petUrl(ctx) }));
      return { text: lines.join('\n'), data: { household: ctx.here.id, date: today, pets: out } };
    });
  },
});

export const petLogFeeding = defineTool({
  name: 'pet_log_feeding',
  title: 'Log a pet feeding',
  description:
    "Records that a pet was fed, as this person, on Huishouden Pet's feeding board. With a `meal` (\"AM\", \"Dinner\") it ticks that meal for today; without one it picks today's next unfed meal, or logs an extra feed when every meal is done.",
  kind: 'write',
  input: {
    ...common,
    ...idempotency,
    pet: z.string().min(1).max(60).describe('Pet name or id.'),
    meal: z.string().max(40).optional().describe('Meal name or id from `pet_today`.'),
    at: z.string().max(40).optional().describe('When, local "YYYY-MM-DDTHH:MM". Default now.'),
    portion: z.string().max(40).optional(),
    note: z.string().max(200).optional(),
  },
  async run(ctx, args) {
    const today = ctx.clock.today();
    const data = await load(ctx, today);
    const [pet] = choosePet(data.pets, args.pet);
    const when = args.at ? ctx.clock.parse(args.at) : { at: ctx.clock.now(), allDay: false };
    if (!when || when.allDay) throw new UserError('error.badTime', { value: args.at ?? '' });
    if (when.at > ctx.clock.now() + 60_000) throw new UserError('error.future');
    const day = toYmd(ctx.clock.local(when.at));
    const meals = mealsOn(ctx, data, pet.id, day, ctx.clock.local(when.at));
    let meal = undefined as (typeof meals)[number] | undefined;
    if (args.meal) {
      const { found } = pick(meals, args.meal, (m) => m.meal.id, (m) => m.meal.name);
      if (!found) throw new UserError('pet.unknownMeal', { name: args.meal, meals: meals.map((m) => m.meal.name).join(', ') || '-' });
      meal = found;
    } else meal = meals.find((m) => m.state !== 'fed');
    const now = ctx.clock.now();
    const id = await recordId(ctx.session.props.connectionId, 'pet_log_feeding', args.idempotency_key);
    const doc = {
      petId: pet.id,
      ...(meal ? { mealId: meal.meal.id } : {}),
      at: Math.round(when.at),
      ...(clip(args.portion, 40) ? { portion: clip(args.portion, 40) } : {}),
      ...(clip(args.note, 200) ? { note: clip(args.note, 200) } : {}),
      by: ctx.session.email,
      createdAt: now,
      via: 'assistant',
    };
    let repeated = false;
    try {
      await ctx.session.db.commit([{ path: `households/${ctx.here.id}/petFeedings/${id}`, create: doc }]);
    } catch (e) {
      if (!alreadyThere(e)) throw e;
      repeated = true;
    }
    ctx.touched('pet', `petFeedings/${id}`);
    return render(ctx.lang, () => ({
      text: t(meal ? (meal.state === 'fed' ? 'pet.fedAgain' : 'pet.fedMeal') : 'pet.fedExtra', { pet: pet.name, meal: meal?.meal.name ?? '', time: formatTime(ctx.clock.local(when.at)), url: petUrl(ctx) }),
      data: { id, pet: pet.id, meal: meal?.meal.id ?? null, at: ctx.clock.isoLocal(when.at), repeated },
    }));
  },
});

export const petLogDose = defineTool({
  name: 'pet_log_dose',
  title: "Log a pet's medicine",
  description:
    "Records a pet's medicine as given (or skipped), as this person: a care reminder (flea and tick, heartworm, deworming, medication: the next due date moves on as in the app) or a dose of a medicine course (\"1 tablet twice a day for 7 days\"). Kids can't log medicine; helpers only for courses that allow them. Refuses a course slot already given unless `confirm_again`.",
  kind: 'write',
  input: {
    ...common,
    ...idempotency,
    pet: z.string().min(1).max(60).describe('Pet name or id.'),
    medicine: z.string().min(1).max(80).describe('Care reminder title or medicine course name/id, from `pet_today`.'),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().describe('Course dose time "HH:MM" being answered. Default the one due now.'),
    skipped: z.boolean().optional().describe('Skipped rather than given (courses only).'),
    confirm_again: z.boolean().optional().describe('Log it although that dose was already given today.'),
  },
  async run(ctx, args) {
    if (ctx.here.role === 'kid') throw new UserError('pet.noKids');
    const today = ctx.clock.today();
    const data = await load(ctx, today);
    const [pet] = choosePet(data.pets, args.pet);
    const now = ctx.clock.now();
    const localNow = ctx.clock.localNow();
    const base = `households/${ctx.here.id}`;
    const id = await recordId(ctx.session.props.connectionId, 'pet_log_dose', args.idempotency_key);
    const courses = data.courses.filter((c) => c.petId === pet.id && courseSlots(ctx, data, c, today, localNow).length);
    const reminders = data.reminders.filter((r) => r.petId === pet.id && r.dismissedAt === undefined && MED_KINDS.includes(r.kind));
    const course = pick(courses, args.medicine, (c) => c.id, (c) => c.name).found;
    const reminder = course ? undefined : pick(reminders, args.medicine, (r) => r.id, (r) => r.title).found;
    if (course) {
      const slots = courseSlots(ctx, data, course, today, localNow);
      const slot = args.time ? slots.find((s) => s.time === args.time) : (slots.filter((s) => s.state === 'missed' || s.state === 'due').sort((a, b) => Math.abs(a.at - localNow) - Math.abs(b.at - localNow))[0] ?? slots.find((s) => s.state !== 'given'));
      if (!slot) throw new UserError('pet.noSlot', { name: course.name, times: course.times.join(', ') });
      if (slot.state === 'given' && !args.confirm_again && !args.skipped)
        return render(ctx.lang, () => ({ text: t('pet.alreadyGiven', { name: course.name, time: formatTime(slot.at), pet: pet.name }), data: { written: false, needs_confirmation: true } }));
      const doc = { petId: pet.id, courseId: course.id, slot: slot.slot, at: now, ...(args.skipped ? { skipped: true } : {}), by: ctx.session.email, createdAt: now, via: 'assistant' };
      let repeated = false;
      try {
        await ctx.session.db.commit([{ path: `${base}/petMedDoses/${id}`, create: doc }]);
      } catch (e) {
        if (!alreadyThere(e)) throw e;
        repeated = true;
      }
      ctx.touched('pet', `petMedDoses/${id}`);
      return render(ctx.lang, () => ({
        text: t(args.skipped ? 'pet.doseSkipped' : 'pet.doseGiven', { name: course.name, pet: pet.name, time: formatTime(slot.at), url: petUrl(ctx, '?tab=care') }),
        data: { id, pet: pet.id, course: course.id, slot: slot.slot, skipped: args.skipped === true, repeated },
      }));
    }
    if (!reminder) throw new UserError('pet.unknownMedicine', { name: args.medicine, options: [...courses.map((c) => c.name), ...reminders.map((r) => r.title)].join(', ') || '-' });
    if (args.skipped) throw new UserError('pet.skipReminder');
    const day = toYmd(localNow);
    const next = isRecurring(reminder) ? addInterval(day, reminder.every!, reminder.unit!) : reminder.due;
    let repeated = false;
    try {
      await ctx.session.db.commit([
        { path: `${base}/petDoses/${id}`, create: { petId: pet.id, reminderId: reminder.id, title: reminder.title.trim().slice(0, 80), at: now, by: ctx.session.email, createdAt: now, via: 'assistant' } },
        { path: `${base}/petReminders/${reminder.id}`, merge: { lastDoneAt: now, due: next, updatedAt: now } },
      ]);
    } catch (e) {
      if (!alreadyThere(e)) throw e;
      repeated = true;
    }
    ctx.touched('pet', `petReminders/${reminder.id}`);
    return render(ctx.lang, () => ({
      text: t(isRecurring(reminder) ? 'pet.reminderGiven' : 'pet.reminderDone', { name: reminder.title, pet: pet.name, next: dueText(next, day), url: petUrl(ctx, '?tab=care') }),
      data: { id, pet: pet.id, reminder: reminder.id, next_due: next, repeated },
    }));
  },
});

export { petUrl };
