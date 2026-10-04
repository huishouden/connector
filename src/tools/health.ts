import { z } from 'zod';
import { toContact, type Contact } from '@huishouden/pwa-kit/contact-core';
import { addDays, clockWords, DAY, daysBetween, formatTime, longDate, toYmd, type Ymd } from '@huishouden/pwa-kit/time';
import { asNeededCheck } from '@huishouden/pwa-kit/dose';
import { t } from '../i18n';
import { UserError } from '../context';
import { FirestoreError } from '@huishouden/pwa-kit/firestore-rest';
import { common, defineTool, idempotency, render, type ToolContext } from './registry';
import { alreadyThere, clip, pick, recordId } from './shared';
import {
  adherenceOf,
  ageOn,
  cleanRule,
  daysLeft,
  daysLeftText,
  doseId,
  doseText,
  guardFor,
  isCurrent,
  isEventRule,
  isStopped,
  loadDoses,
  loadMeds,
  loadPeople,
  logsOf,
  medLabel,
  medUrl,
  personUrl,
  printUrl,
  refillDue,
  rowsBetween,
  scheduleText,
  supplyLeft,
  toMed,
  type Dose,
  type Med,
  type Person,
} from './health-data';

/**
 * Health in full: everything Health's rules let this person read and do for the people they care
 * for (admins: everyone; carers and the person themself: that person; kids and other members:
 * nothing). Research on the medicines happens in the assistant, from these records.
 */

const personArg = z.string().min(1).max(60).describe('Person by name or id, from `health_people`.');
const medArg = z.string().min(1).max(80).describe('Medicine by name or id, from `health_medicines`.');

async function choosePerson(ctx: ToolContext, wanted: string): Promise<Person> {
  if (ctx.here.role === 'kid') throw new UserError('health.noKids');
  const people = await loadPeople(ctx);
  const { found } = pick(people, wanted, (p) => p.id, (p) => p.name);
  // Someone this person may not read looks exactly like someone who doesn't exist.
  if (!found) throw new UserError('health.unknownPerson', { name: wanted, people: people.map((p) => p.name).join(', ') || '-' });
  return found;
}

function chooseMed(meds: Med[], wanted: string): Med {
  const { found, ambiguous } = pick(meds, wanted, (m) => m.id, (m) => medLabel(m));
  if (found) return found;
  const byName = pick(meds, wanted, (m) => m.id, (m) => m.name);
  if (byName.found) return byName.found;
  throw new UserError(ambiguous || byName.ambiguous ? 'health.ambiguousMed' : 'health.unknownMed', { name: wanted, meds: meds.map(medLabel).join(', ') || '-' });
}

async function contactsById(ctx: ToolContext): Promise<Map<string, Contact>> {
  const docs = await ctx.session.openRecords(ctx.here, 'contacts', true).catch(() => []);
  return new Map(docs.map((d) => [d.id, toContact(d.id, d.data)]));
}

async function namesOf(ctx: ToolContext): Promise<(email: string) => string> {
  const docs = await ctx.session.db.query(`households/${ctx.here.id}`, 'profiles').catch(() => []);
  const names = new Map(docs.map((d) => [d.id, typeof d.data.name === 'string' ? d.data.name : '']));
  return (email: string) => (email === ctx.session.email ? t('health.you') : names.get(email) || email.split('@')[0]);
}

const contactWords = (c: Contact | undefined) => (c ? [c.name, c.phone].filter(Boolean).join(', ') : undefined);

function medFacts(ctx: ToolContext, m: Med, doses: Dose[], contacts: Map<string, Contact>) {
  const now = ctx.clock.now();
  const localNow = ctx.clock.localNow();
  const left = supplyLeft(m, doses);
  const days = daysLeft(m, doses, now, localNow);
  const prescriber = m.prescriberId ? contacts.get(m.prescriberId) : undefined;
  const pharmacy = m.pharmacyId ? contacts.get(m.pharmacyId) : undefined;
  return {
    id: m.id,
    name: m.name,
    ...(m.strength ? { strength: m.strength } : {}),
    ...(m.dose ? { dose: m.dose } : {}),
    ...(m.doseAmount !== undefined ? { dose_amount: m.doseAmount, dose_unit: m.doseUnit ?? null } : {}),
    as_needed: m.asNeeded,
    times: m.times,
    ...(m.rule ? { rule: m.rule } : { every_days: m.everyDays ?? 1 }),
    ...(m.minHours !== undefined ? { min_hours: m.minHours } : {}),
    ...(m.maxPerDay !== undefined ? { max_per_day: m.maxPerDay } : {}),
    with_food: m.withFood ?? null,
    start_date: m.startDate,
    ...(m.endDate ? { end_date: m.endDate } : {}),
    stopped: isStopped(m, ctx.clock.today()),
    ...(prescriber ? { prescriber: { id: prescriber.id, name: prescriber.name, phone: prescriber.phone, role: prescriber.role } } : m.prescriberId ? { prescriber: { id: m.prescriberId } } : {}),
    ...(pharmacy ? { pharmacy: { id: pharmacy.id, name: pharmacy.name, phone: pharmacy.phone, address: pharmacy.address } } : m.pharmacyId ? { pharmacy: { id: m.pharmacyId } } : {}),
    ...(m.refills !== undefined ? { refills: m.refills } : {}),
    ...(left !== null ? { supply_left: left, supply_counted: ctx.clock.isoLocal(m.supplyAt ?? m.createdAt).slice(0, 10) } : {}),
    ...(days !== null ? { days_left: days } : {}),
    refill_due: refillDue(m, doses, now, localNow),
    ...(m.refillOrderedAt ? { refill_ordered: ctx.clock.isoLocal(m.refillOrderedAt).slice(0, 10) } : {}),
    reminders: m.remind,
    ...(m.notes ? { notes: m.notes } : {}),
    url: medUrl(ctx, m),
  };
}

export const healthPeople = defineTool({
  name: 'health_people',
  title: 'People in Health',
  description:
    "The people whose medicines this person looks after in Huishouden Health (admins see everyone; carers and the person themself their own; kids and other members no one): name, age, allergies, notes, carers, and how many medicines.",
  kind: 'read',
  health: true,
  input: { ...common },
  async run(ctx) {
    const people = await loadPeople(ctx);
    ctx.touched('health');
    const today = ctx.clock.today();
    const meds = await Promise.all(people.map((p) => loadMeds(ctx, p)));
    const nameOf = await namesOf(ctx);
    return render(ctx.lang, () => ({
      text: [
        `**${t('health.peopleTitle')}** · ${ctx.here.name}`,
        '',
        ...(people.length
          ? people.map((p, i) => {
              const age = ageOn(p.birthDate, today);
              const current = meds[i].filter((m) => !isStopped(m, today)).length;
              return `- **[${p.name}](${personUrl(ctx, p.id)})**${age !== null ? ` (${age})` : ''} · ${t('health.medCount', { count: current })} · ${p.allergies ? t('today.allergies', { allergies: p.allergies }) : t('print.noAllergies')} · ${t('health.carers', { names: p.carers.map(nameOf).join(', ') || '-' })} · id \`${p.id}\``;
            })
          : [t(ctx.here.role === 'kid' ? 'health.noKids' : 'health.nobody')]),
      ].join('\n'),
      data: {
        household: ctx.here.id,
        people: people.map((p, i) => ({ id: p.id, name: p.name, birth_date: p.birthDate, age: ageOn(p.birthDate, today), allergies: p.allergies ?? null, notes: p.notes, carers: p.carers, is_me: p.email === ctx.session.email, medicines: meds[i].filter((m) => !isStopped(m, today)).length, url: personUrl(ctx, p.id) })),
      },
    }));
  },
});

export const healthMedicines = defineTool({
  name: 'health_medicines',
  title: "A person's medicines",
  description:
    "Everything Health has on a person's medicines: name, strength, dose, schedule (times, days, as needed with minimum hours and daily maximum), with food or not, since/until, prescriber and pharmacy (from the household contacts), refills, supply left and days left, refill due or ordered, notes, and the person's allergies. Use it to research interactions, side effects or timing in the assistant.",
  kind: 'read',
  health: true,
  input: { ...common, person: personArg, include_stopped: z.boolean().optional().describe('Also medicines stopped in the last 90 days. Default false.') },
  async run(ctx, args) {
    const person = await choosePerson(ctx, args.person);
    const [meds, doses, contacts] = await Promise.all([loadMeds(ctx, person), loadDoses(ctx, person, ctx.clock.now() - 30 * DAY), contactsById(ctx)]);
    ctx.touched('health', `healthPeople/${person.id}`);
    const today = ctx.clock.today();
    const shown = meds
      .filter((m) => !isStopped(m, today) || (args.include_stopped && m.endDate! >= addDays(today, -90)))
      .sort((a, b) => Number(a.asNeeded) - Number(b.asNeeded) || medLabel(a).localeCompare(medLabel(b)));
    return render(ctx.lang, () => {
      const facts = shown.map((m) => medFacts(ctx, m, doses, contacts));
      const lines = [`**${t('print.title', { name: person.name })}**`, person.allergies ? t('today.allergies', { allergies: person.allergies }) : t('print.noAllergies'), ''];
      for (const m of shown) {
        const f = facts.find((x) => x.id === m.id)!;
        const bits = [
          doseText(m),
          scheduleText(m),
          m.endDate ? t('print.until', { date: longDate(m.endDate, today) }) : '',
          m.prescriberId && contacts.has(m.prescriberId) ? `${t('print.prescribedBy')}: ${contactWords(contacts.get(m.prescriberId))}` : '',
          m.pharmacyId && contacts.has(m.pharmacyId) ? `${t('health.pharmacy')}: ${contactWords(contacts.get(m.pharmacyId))}` : '',
          f.days_left !== undefined ? daysLeftText(f.days_left) : '',
          m.refills !== undefined ? t('meds.refillsLeft', { count: m.refills }) : '',
          f.refill_due ? `**${t('health.refillDue')}**` : '',
          f.refill_ordered ? t('health.refillOrdered', { date: longDate(f.refill_ordered, today) }) : '',
        ].filter(Boolean);
        lines.push(`- **[${medLabel(m)}](${f.url})**${f.stopped ? ` (${t('health.stopped', { date: longDate(m.endDate!, today) })})` : ''}: ${bits.join(' · ')}${m.notes ? `\n  ${m.notes}` : ''}`);
      }
      if (!shown.length) lines.push(t('today.noMeds'));
      return { text: lines.join('\n'), data: { person: { id: person.id, name: person.name, allergies: person.allergies ?? null, notes: person.notes }, medicines: facts } };
    });
  },
});

export const healthHistory = defineTool({
  name: 'health_history',
  title: "A person's dose history",
  description:
    "What happened to each scheduled dose of a person's medicines between two days (given, skipped, missed, by whom and when), as-needed doses taken, and adherence per medicine and overall (given ÷ (given + missed)). Default the last 30 days; at most 400.",
  kind: 'read',
  health: true,
  input: {
    ...common,
    person: personArg,
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('First day, local YYYY-MM-DD. Default 29 days ago.'),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Last day. Default today.'),
    medicine: medArg.optional(),
  },
  async run(ctx, args) {
    const person = await choosePerson(ctx, args.person);
    const today = ctx.clock.today();
    const to = args.to && args.to < today ? args.to : today;
    const from = args.from ?? addDays(to, -29);
    if (from > to) throw new UserError('error.rangeBackwards');
    if (daysBetween(from, to) > 400) throw new UserError('error.rangeTooLong', { days: 400 });
    const since = ctx.clock.utc(Date.parse(`${addDays(from, -1)}T00:00:00Z`));
    const [allMeds, doses] = await Promise.all([loadMeds(ctx, person), loadDoses(ctx, person, since)]);
    const meds = args.medicine ? [chooseMed(allMeds, args.medicine)] : allMeds.filter((m) => m.startDate <= to && (!m.endDate || m.endDate >= from));
    ctx.touched('health', `healthPeople/${person.id}`);
    const nameOf = await namesOf(ctx);
    return render(ctx.lang, () => {
      const per = meds.filter((m) => !m.asNeeded).map((m) => ({ m, a: adherenceOf(ctx, m, doses, from, to) }));
      const given = per.reduce((n, x) => n + x.a.given, 0);
      const missed = per.reduce((n, x) => n + x.a.missed, 0);
      const overall = given + missed ? Math.round((given / (given + missed)) * 100) : null;
      const rows = rowsBetween(ctx, meds, doses, from, to).filter((r) => r.state !== 'upcoming');
      const asNeeded = doses.filter((d) => !d.slot && meds.some((m) => m.id === d.medId && m.asNeeded) && toYmd(ctx.clock.local(d.at)) >= from && toYmd(ctx.clock.local(d.at)) <= to).sort((a, b) => b.at - a.at);
      const lines = [`**${t('health.historyTitle', { name: person.name, from: longDate(from, today), to: longDate(to, today) })}**`, '', overall === null ? t('meds.noDoses') : t('print.adherence', { percent: `${overall}%` }), ''];
      for (const { m, a } of per) lines.push(`- ${medLabel(m)}: ${a.rate === null ? t('meds.noDoses') : `${Math.round(a.rate * 100)}%`} · ${t('health.counts', { given: a.given, missed: a.missed, skipped: a.skipped })}`);
      const recent = rows.slice(-40).reverse();
      if (recent.length) lines.push('', `**${t('health.log')}**`, ...recent.map((r) => `- ${longDate(r.slot.date, today)} ${formatTime(r.slot.at)} · ${medLabel(r.med)} · ${t(`health.state.${r.state}` as Parameters<typeof t>[0])}${r.log ? ` · ${nameOf(r.log.by)}${r.log.note ? ` · ${r.log.note}` : ''}` : ''}`));
      if (asNeeded.length) lines.push('', `**${t('today.whenNeeded')}**`, ...asNeeded.slice(0, 30).map((d) => `- ${longDate(toYmd(ctx.clock.local(d.at)), today)} ${formatTime(ctx.clock.local(d.at))} · ${medLabel(meds.find((m) => m.id === d.medId)!)} · ${t(`health.state.${d.status}` as Parameters<typeof t>[0])} · ${nameOf(d.by)}`));
      lines.push('', t('health.historyLink', { url: personUrl(ctx, person.id, 'history') }));
      return {
        text: lines.join('\n'),
        data: {
          person: person.id,
          from,
          to,
          adherence_percent: overall,
          medicines: per.map(({ m, a }) => ({ id: m.id, name: medLabel(m), ...a })),
          doses: rows.map((r) => ({ medicine: r.med.id, slot: r.slot.key, state: r.state, ...(r.log ? { by: r.log.by, at: ctx.clock.isoLocal(r.log.at - (ctx.clock.local(r.log.at) - r.log.at)), note: r.log.note } : {}) })),
          as_needed: asNeeded.map((d) => ({ medicine: d.medId, at: ctx.clock.isoLocal(d.at), status: d.status, by: d.by, note: d.note })),
        },
      };
    });
  },
});

export const healthDue = defineTool({
  name: 'health_due',
  title: 'Medicines due',
  description:
    "Today's doses for each person this person cares for (or one person): due now, missed, given, still to come, the as-needed medicines and when the next is fine, and medicines running low on supply. The same as Health's Today screen.",
  kind: 'read',
  health: true,
  input: { ...common, person: personArg.optional() },
  async run(ctx, args) {
    const people = args.person ? [await choosePerson(ctx, args.person)] : await loadPeople(ctx);
    const today = ctx.clock.today();
    const now = ctx.clock.now();
    const localNow = ctx.clock.localNow();
    const data = await Promise.all(people.map(async (p) => ({ p, meds: await loadMeds(ctx, p), doses: await loadDoses(ctx, p, now - 30 * DAY) })));
    ctx.touched('health');
    const nameOf = await namesOf(ctx);
    return render(ctx.lang, () => {
      const lines = [`**${t('health.dueTitle', { day: longDate(today) })}**`];
      const out = data.map(({ p, meds, doses }) => {
        const current = meds.filter((m) => isCurrent(m, today));
        const rows = rowsBetween(ctx, current, doses, today, today);
        const asNeeded = current.filter((m) => m.asNeeded).map((m) => ({ m, check: asNeededCheck(logsOf(doses, m.id), now, { minHours: m.minHours, maxPerDay: m.maxPerDay }) }));
        const low = current.filter((m) => refillDue(m, doses, now, localNow));
        lines.push('', `**[${p.name}](${personUrl(ctx, p.id)})**`);
        for (const r of rows) lines.push(`- ${formatTime(r.slot.at)} · ${medLabel(r.med)}${r.med.dose ? ` (${r.med.dose})` : ''} · ${t(`health.state.${r.state}` as Parameters<typeof t>[0])}${r.log ? ` · ${nameOf(r.log.by)}` : ''}`);
        for (const { m, check } of asNeeded) lines.push(`- ${medLabel(m)} · ${t('meds.asNeeded')} · ${check.ok ? t('health.fineNow') : t('guard.next', { time: clockWords(new Date(ctx.clock.local(check.nextAt)).toISOString().slice(11, 16)) })}`);
        for (const m of low) lines.push(`- ⚠ ${t('health.runningLow', { med: medLabel(m), left: daysLeftText(daysLeft(m, doses, now, localNow) ?? 0) })}`);
        if (!rows.length && !asNeeded.length) lines.push(`- ${t('today.noMeds')}`);
        return {
          id: p.id,
          name: p.name,
          doses: rows.map((r) => ({ medicine: r.med.id, name: medLabel(r.med), dose: r.med.dose, time: r.slot.time, slot: r.slot.key, state: r.state, ...(r.log ? { by: r.log.by } : {}) })),
          as_needed: asNeeded.map(({ m, check }) => ({ medicine: m.id, name: medLabel(m), ok_now: check.ok, ...(check.ok ? {} : { next_ok_at: ctx.clock.isoLocal(check.nextAt) }), given_last_24h: check.inLastDay })),
          refills_due: low.map((m) => ({ medicine: m.id, name: medLabel(m), days_left: daysLeft(m, doses, now, localNow) })),
        };
      });
      if (!people.length) lines.push('', t(ctx.here.role === 'kid' ? 'health.noKids' : 'health.nobody'));
      return { text: lines.join('\n'), data: { date: today, time_zone: ctx.clock.timeZone, people: out } };
    });
  },
});

export const healthLogDose = defineTool({
  name: 'health_log_dose',
  title: 'Log a dose',
  description:
    "Records a dose of a person's medicine as given or skipped, as this person, as Health does. For a scheduled medicine it answers one dose time (default: the one due now, else the nearest missed one today). Before a dose is marked given, Health's guards run: a scheduled dose already given (or one within half the gap between doses), or an as-needed medicine too soon after the last or over its daily maximum. Then nothing is written: tell the person what the guard says and call again with `confirm: true` only if they still want to.",
  kind: 'write',
  health: true,
  input: {
    ...common,
    ...idempotency,
    person: personArg,
    medicine: medArg,
    status: z.enum(['given', 'skipped']).optional().describe('Default given.'),
    dose_time: z.string().max(20).optional().describe('Scheduled: which dose, "HH:MM" today or "YYYY-MM-DDTHH:MM" (local) for an earlier day this week.'),
    given_at: z.string().max(40).optional().describe('When it was taken, local "YYYY-MM-DDTHH:MM". Default now.'),
    note: z.string().max(200).optional(),
    confirm: z.boolean().optional().describe("Write it although a guard warned (the person said so)."),
  },
  async run(ctx, args) {
    const person = await choosePerson(ctx, args.person);
    const now = ctx.clock.now();
    const [meds, doses] = await Promise.all([loadMeds(ctx, person), loadDoses(ctx, person, now - 8 * DAY)]);
    const med = chooseMed(meds, args.medicine);
    const status = args.status ?? 'given';
    const when = args.given_at ? ctx.clock.parse(args.given_at) : { at: now, allDay: false };
    if (!when || when.allDay) throw new UserError('error.badTime', { value: args.given_at ?? '' });
    if (when.at > now + 60_000) throw new UserError('error.future');
    const today = ctx.clock.today();
    let slot: string | undefined;
    if (!med.asNeeded) {
      const rows = rowsBetween(ctx, [med], doses, addDays(today, -7), today);
      let row;
      if (args.dose_time) {
        const key = /^\d{2}:\d{2}$/.test(args.dose_time) ? `${today}T${args.dose_time}` : args.dose_time;
        row = rows.find((r) => r.slot.key === key);
        if (!row) throw new UserError('health.noSuchDose', { med: med.name, times: med.times.join(', ') || '-' });
      } else {
        const todays = rows.filter((r) => r.slot.date === today);
        row = todays.find((r) => r.state === 'due') ?? todays.filter((r) => r.state === 'missed').pop() ?? todays.find((r) => r.state === 'upcoming');
        if (!row) throw new UserError('health.noDoseToday', { med: med.name });
      }
      slot = row.slot.key;
    }
    const nameOf = await namesOf(ctx);
    const id = slot ? doseId(med.id, slot) : await recordId(ctx.session.props.connectionId, 'health_log_dose', args.idempotency_key);
    const path = `households/${ctx.here.id}/healthPeople/${person.id}/doses/${id}`;
    // A retry with the same key is the same dose, already written: no guard, no second dose.
    if (!slot && args.idempotency_key && doses.some((d) => d.id === id)) {
      return render(ctx.lang, () => ({ text: t('health.doseGiven', { med: medLabel(med), name: person.name, time: formatTime(ctx.clock.local(when.at)), url: personUrl(ctx, person.id) }), data: { written: true, id, person: person.id, medicine: med.id, status, repeated: true } }));
    }
    if (status === 'given' && !args.confirm) {
      const warning = render(ctx.lang, () => guardFor(ctx, med, doses, when.at, nameOf, slot));
      if (warning) {
        ctx.touched('health', `healthPeople/${person.id}/meds/${med.id}`);
        return { text: render(ctx.lang, () => t('health.guardAsk', { warning })), data: { written: false, needs_confirmation: true, warning } };
      }
    }
    const note = clip(args.note, 200);
    const doc = { personId: person.id, medId: med.id, ...(slot ? { slot } : {}), at: Math.round(when.at), status, ...(note ? { note } : {}), by: ctx.session.email, createdAt: now, via: 'assistant' };
    let repeated = false;
    try {
      // A slot's dose has the same id from every device, so marking it is idempotent by itself.
      await ctx.session.db.commit([slot ? { path, set: doc } : { path, create: doc }]);
    } catch (e) {
      if (alreadyThere(e)) repeated = true;
      else if (e instanceof FirestoreError && e.code === 'permission-denied' && slot && doses.some((d) => d.id === id)) throw new UserError('health.someoneElsesDose');
      else throw e;
    }
    ctx.touched('health', `healthPeople/${person.id}/doses/${id}`);
    return render(ctx.lang, () => ({
      text: t(status === 'given' ? 'health.doseGiven' : 'health.doseSkipped', { med: medLabel(med), name: person.name, time: formatTime(ctx.clock.local(when.at)), url: personUrl(ctx, person.id) }),
      data: { written: true, id, person: person.id, medicine: med.id, ...(slot ? { slot } : {}), status, at: ctx.clock.isoLocal(when.at), repeated },
    }));
  },
});

// ---- Adding and changing medicines (admins and member carers, as in Health) ----

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const medFields = {
  name: z.string().min(1).max(80).describe('"Lisinopril".'),
  strength: z.string().max(40).optional().describe('"10 mg".'),
  dose: z.string().max(80).optional().describe('One dose in words: "1 tablet", "5 ml".'),
  dose_amount: z.number().positive().max(1000).optional().describe('One dose as a number of `dose_unit`, to count the supply down: 1.'),
  dose_unit: z.string().max(20).optional().describe('"tablet", "ml".'),
  as_needed: z.boolean().optional().describe('Taken when needed rather than on a schedule. Default false.'),
  times: z.array(hhmm).max(6).optional().describe('Scheduled: dose times "HH:MM" (up to 6).'),
  every_days: z.number().int().min(1).max(31).optional().describe('Scheduled: every N days (2 = every other day). Default 1.'),
  weekdays: z.array(z.enum(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'])).max(7).optional().describe('Scheduled: only on these weekdays (instead of every_days).'),
  min_hours: z.number().min(0).max(72).optional().describe('As needed: at least this many hours between doses.'),
  max_per_day: z.number().int().min(1).max(24).optional().describe('As needed: at most this many in 24 hours.'),
  with_food: z.boolean().nullable().optional().describe('true with food, false on an empty stomach, null either.'),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('First day. Default today.'),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().describe('Last day (a course), or null for ongoing.'),
  prescriber: z.string().max(120).nullable().optional().describe('Prescriber: a household contact name or id (add one with contacts_add).'),
  pharmacy: z.string().max(120).nullable().optional().describe('Pharmacy: a household contact name or id.'),
  refills: z.number().int().min(0).max(99).nullable().optional(),
  supply: z.number().min(0).max(10000).nullable().optional().describe('Units on hand now (counted today), in dose units.'),
  reminders: z.boolean().optional().describe('Notifications at dose time. Default true for scheduled.'),
  escalate_minutes: z.number().int().min(0).max(240).optional().describe('Minutes after a dose time before the other carers hear it was not marked; 0 never. Default 30.'),
  notes: z.string().max(500).nullable().optional(),
};

type MedArgs = { [K in keyof typeof medFields]?: z.infer<(typeof medFields)[K]> };

/** The stored medicine (health src/lib/build.ts `medDoc`), from the old one and the changes. */
function medDoc(ctx: ToolContext, person: Person, old: Med | undefined, a: MedArgs, contacts: Map<string, Contact>): Record<string, unknown> {
  const now = ctx.clock.now();
  const today = ctx.clock.today();
  const pickContact = (wanted: string | null | undefined, current: string | undefined): string | undefined => {
    if (wanted === null) return undefined;
    if (wanted === undefined) return current;
    const { found } = pick([...contacts.values()], wanted, (c) => c.id, (c) => c.name);
    if (!found) throw new UserError('health.unknownContact', { name: wanted });
    return found.id;
  };
  const asNeeded = a.as_needed ?? old?.asNeeded ?? false;
  const times = asNeeded ? [] : [...new Set(a.times ?? old?.times ?? [])].sort().slice(0, 6);
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const start = a.start_date ?? old?.startDate ?? today;
  const rule = a.weekdays ? (a.weekdays.length ? cleanRule({ freq: 'week', every: 1, start, days: a.weekdays.map((d) => days.indexOf(d)) }) : undefined) : a.every_days !== undefined ? undefined : old?.rule;
  if (rule && !isEventRule(rule)) throw new UserError('health.badSchedule');
  if (!asNeeded && !times.length) throw new UserError('health.needsTimes');
  const endDate = a.end_date === null ? undefined : (a.end_date ?? old?.endDate);
  if (endDate && endDate < start) throw new UserError('error.rangeBackwards');
  const supplyChanged = a.supply !== undefined;
  const supply = a.supply === null ? undefined : (a.supply ?? old?.supply);
  const doseAmount = a.dose_amount ?? old?.doseAmount;
  const opt = <T>(k: string, v: T | undefined | null | '') => (v === undefined || v === null || v === '' || (typeof v === 'number' && !Number.isFinite(v)) ? {} : { [k]: v });
  const withFood = a.with_food === null ? undefined : (a.with_food ?? old?.withFood);
  const notes = a.notes === null ? undefined : a.notes !== undefined ? clip(a.notes, 500) : old?.notes;
  return {
    personId: person.id,
    name: clip(a.name ?? old?.name, 80),
    ...opt('strength', a.strength !== undefined ? clip(a.strength, 40) : old?.strength),
    ...opt('dose', a.dose !== undefined ? clip(a.dose, 80) : old?.dose),
    ...opt('doseAmount', doseAmount !== undefined && doseAmount > 0 ? Math.min(doseAmount, 1000) : undefined),
    ...opt('doseUnit', a.dose_unit !== undefined ? clip(a.dose_unit, 20) : old?.doseUnit),
    asNeeded,
    times,
    ...(!asNeeded && !rule ? { everyDays: Math.min(31, Math.max(1, Math.round(a.every_days ?? old?.everyDays ?? 1))) } : {}),
    ...(!asNeeded && rule ? { rule } : {}),
    ...(asNeeded ? opt('minHours', a.min_hours ?? old?.minHours) : {}),
    ...(asNeeded ? opt('maxPerDay', a.max_per_day ?? old?.maxPerDay) : {}),
    ...(withFood === undefined ? {} : { withFood }),
    startDate: start,
    ...opt('endDate', endDate),
    ...opt('prescriberId', pickContact(a.prescriber, old?.prescriberId)),
    ...opt('pharmacyId', pickContact(a.pharmacy, old?.pharmacyId)),
    ...opt('refills', a.refills === null ? undefined : (a.refills ?? old?.refills)),
    ...opt('supply', supply !== undefined ? Math.max(0, Math.min(10000, supply)) : undefined),
    ...(supply !== undefined ? { supplyAt: supplyChanged ? now : (old?.supplyAt ?? now) } : {}),
    ...opt('refillOrderedAt', old?.refillOrderedAt),
    escalateMinutes: a.escalate_minutes ?? old?.escalateMinutes ?? 30,
    remind: a.reminders ?? old?.remind ?? !asNeeded,
    ...opt('notes', notes),
    createdAt: old?.createdAt ?? now,
    ...(old ? { updatedAt: now } : {}),
    by: ctx.session.email,
    via: 'assistant',
  };
}

const keeperOnly = (e: unknown) => {
  if (e instanceof FirestoreError && e.code === 'permission-denied') throw new UserError('health.keepersOnly');
  throw e;
};

export const healthAddMedicine = defineTool({
  name: 'health_add_medicine',
  title: 'Add a medicine',
  description:
    "Adds a medicine for a person in Health, as this person (admins, and members who care for that person; helpers can't). Scheduled: give `times` and optionally `every_days` or `weekdays`. As needed: `as_needed: true` with `min_hours` and `max_per_day`. Health then reminds the carers at dose time when `reminders` is on.",
  kind: 'write',
  health: true,
  input: { ...common, ...idempotency, person: personArg, ...medFields, name: medFields.name },
  async run(ctx, args) {
    const person = await choosePerson(ctx, args.person);
    if (ctx.here.role !== 'admin' && ctx.here.role !== 'member') throw new UserError('health.keepersOnly');
    const contacts = await contactsById(ctx);
    const doc = medDoc(ctx, person, undefined, args, contacts);
    const id = await recordId(ctx.session.props.connectionId, 'health_add_medicine', args.idempotency_key);
    let repeated = false;
    await ctx.session.db.commit([{ path: `households/${ctx.here.id}/healthPeople/${person.id}/meds/${id}`, create: doc }]).catch((e) => {
      if (alreadyThere(e)) repeated = true;
      else keeperOnly(e);
    });
    ctx.touched('health', `healthPeople/${person.id}/meds/${id}`);
    const med = toMed(id, doc);
    return render(ctx.lang, () => ({
      text: t('health.medAdded', { med: medLabel(med), name: person.name, schedule: scheduleText(med), url: medUrl(ctx, med) }),
      data: { id, person: person.id, repeated, medicine: medFacts(ctx, med, [], contacts) },
    }));
  },
});

export const healthUpdateMedicine = defineTool({
  name: 'health_update_medicine',
  title: 'Change a medicine',
  description:
    "Changes a person's medicine in Health, as this person: any field of `health_add_medicine`, `stop: true` (ends it today, as Health's Stop), `restart: true`, `supply` (a new count, from today), or `refill_ordered: true` (any carer, helpers too, as Health's \"Ordered\"). Only the fields given change.",
  kind: 'write',
  health: true,
  input: {
    ...common,
    person: personArg,
    medicine: medArg,
    ...medFields,
    name: medFields.name.optional(),
    stop: z.boolean().optional().describe('Stop it today.'),
    restart: z.boolean().optional().describe('Take a stopped medicine up again (clears the end date).'),
    refill_ordered: z.boolean().optional().describe('A refill has been ordered.'),
  },
  async run(ctx, args) {
    const person = await choosePerson(ctx, args.person);
    const meds = await loadMeds(ctx, person);
    const old = chooseMed(meds, args.medicine);
    const path = `households/${ctx.here.id}/healthPeople/${person.id}/meds/${old.id}`;
    const now = ctx.clock.now();
    const today = ctx.clock.today();
    const { person: _p, medicine: _m, stop, restart, refill_ordered, household: _h, lang: _l, time_zone: _z, ...changes } = args;
    const changing = Object.values(changes).some((v) => v !== undefined) || stop || restart;
    if (refill_ordered && !changing) {
      // Any carer may mark a refill ordered (the rules allow exactly these two fields).
      await ctx.session.db.commit([{ path, merge: { refillOrderedAt: now, updatedAt: now } }]);
      ctx.touched('health', `healthPeople/${person.id}/meds/${old.id}`);
      return render(ctx.lang, () => ({ text: t('health.refillMarked', { med: medLabel(old), name: person.name }), data: { id: old.id, refill_ordered: today } }));
    }
    if (ctx.here.role !== 'admin' && ctx.here.role !== 'member') throw new UserError('health.keepersOnly');
    const contacts = await contactsById(ctx);
    const end = stop ? (old.startDate > today ? old.startDate : today) : restart ? null : changes.end_date;
    const doc = medDoc(ctx, person, old, { ...changes, end_date: end }, contacts);
    if (refill_ordered) doc.refillOrderedAt = now;
    await ctx.session.db.commit([{ path, set: doc }]).catch(keeperOnly);
    ctx.touched('health', `healthPeople/${person.id}/meds/${old.id}`);
    const med = toMed(old.id, doc);
    return render(ctx.lang, () => ({
      text: t(stop ? 'health.medStopped' : 'health.medUpdated', { med: medLabel(med), name: person.name, schedule: scheduleText(med), url: medUrl(ctx, med) }),
      data: { id: old.id, person: person.id, medicine: medFacts(ctx, med, [], contacts) },
    }));
  },
});

export const healthDoctorList = defineTool({
  name: 'health_doctor_list',
  title: 'Medicine list for the doctor',
  description:
    "Health's printable medicine list for a person, as Markdown: name and age, allergies, medicines taken regularly and when needed (dose, when, prescriber, since), those stopped in the last three months, doses given in the last 30 days, and the doctors and pharmacy. For a doctor's visit, a hospital form or a new carer.",
  kind: 'read',
  health: true,
  input: { ...common, person: personArg },
  async run(ctx, args) {
    const person = await choosePerson(ctx, args.person);
    const now = ctx.clock.now();
    const [meds, doses, contacts] = await Promise.all([loadMeds(ctx, person), loadDoses(ctx, person, now - 31 * DAY), contactsById(ctx)]);
    ctx.touched('health', `healthPeople/${person.id}`);
    const today = ctx.clock.today();
    return render(ctx.lang, () => {
      const mine = [...meds].sort((a, b) => Number(a.asNeeded) - Number(b.asNeeded) || medLabel(a).localeCompare(medLabel(b)));
      const since: Ymd = addDays(today, -90);
      const current = mine.filter((m) => !isStopped(m, today));
      const stopped = mine.filter((m) => isStopped(m, today) && m.endDate! >= since);
      const used = new Set(mine.flatMap((m) => [m.prescriberId, m.pharmacyId]).filter(Boolean) as string[]);
      const from = addDays(today, -29);
      let given = 0;
      let missed = 0;
      for (const m of current.filter((x) => !x.asNeeded)) {
        const a = adherenceOf(ctx, m, doses, from, today);
        given += a.given;
        missed += a.missed;
      }
      const percent = given + missed ? `${Math.round((given / (given + missed)) * 100)}%` : t('meds.noDoses');
      const age = ageOn(person.birthDate, today);
      const sub = [person.birthDate ? (age !== null ? t('print.bornAge', { date: longDate(person.birthDate), age }) : t('print.born', { date: longDate(person.birthDate) })) : '', t('print.asOf', { date: longDate(today) })].filter(Boolean).join(' · ');
      const table = (list: Med[]) => [
        `| ${t('health.medicine')} | ${t('print.dose')} | ${t('print.when')} | ${t('print.prescribedBy')} | ${t('print.sinceHeader')} |`,
        '|---|---|---|---|---|',
        ...list.map((m) => {
          const cell = (s: string) => s.replace(/\|/g, '/').replace(/\n/g, ' ');
          const when = [scheduleText(m), m.endDate ? t('print.until', { date: longDate(m.endDate) }) : ''].filter(Boolean).join(', ') + (m.notes ? `<br>${cell(m.notes)}` : '');
          return `| ${cell(medLabel(m))} | ${cell(doseText(m))} | ${when} | ${cell(m.prescriberId ? (contacts.get(m.prescriberId)?.name ?? '') : '')} | ${longDate(m.startDate)} |`;
        }),
      ];
      const regular = current.filter((m) => !m.asNeeded);
      const needed = current.filter((m) => m.asNeeded);
      const lines = [`# ${t('print.title', { name: person.name })}`, '', sub, '', person.allergies ? t('today.allergies', { allergies: person.allergies }) : t('print.noAllergies')];
      if (!current.length) lines.push('', t('today.noMeds'));
      if (regular.length) lines.push('', `## ${t('print.regular')}`, '', ...table(regular));
      if (needed.length) lines.push('', `## ${t('today.whenNeeded')}`, '', ...table(needed));
      if (stopped.length) lines.push('', `## ${t('print.stoppedTitle')}`, '', ...stopped.map((m) => `- ${t('print.stoppedItem', { med: medLabel(m), date: longDate(m.endDate!) })}`));
      lines.push('', t('print.adherence', { percent }));
      const docs = [...used].map((id) => contacts.get(id)).filter((c): c is Contact => !!c);
      if (docs.length) lines.push('', `## ${t('print.doctors')}`, '', ...docs.map((c) => `- ${c.name}${c.role ? ` (${c.role})` : ''}${c.phone ? `, ${c.phone}` : ''}${c.address ? `, ${c.address}` : ''}`));
      lines.push('', t('health.printLink', { url: printUrl(ctx, person.id) }));
      return { text: lines.join('\n'), data: { person: person.id, markdown: lines.join('\n'), url: printUrl(ctx, person.id) } };
    });
  },
});
