import { z } from 'zod';
import { cleanContact, contactInput, toContact, type Contact } from '@huishouden/pwa-kit/contact-core';
import { cleanAudience } from '@huishouden/pwa-kit/audience';
import { householdRole } from '@huishouden/pwa-kit/role-core';
import { formatDateLong, formatTime } from '@huishouden/pwa-kit/time';
import { t } from '../i18n';
import { UserError } from '../context';
import { common, defineTool, idempotency, render, type ToolContext } from './registry';
import { clip, fold, pick, recordId } from './shared';
import { create } from './home';
import { loadPeople, personUrl } from './health-data';

// ---- Appointments: Pet, Baby, Car (their own collections) and Health (the person's carers' agenda) ----

const APPOINTMENT_APPS = ['pet', 'baby', 'car', 'health'] as const;

export const addAppointment = defineTool({
  name: 'add_appointment',
  title: 'Add an appointment',
  description:
    "Adds an appointment, as this person: `app: \"pet\"` (vet, grooming, boarding), `\"baby\"` (pediatrician, checkups), `\"car\"` (service, inspection) in that app's own list, or `\"health\"` (a doctor's or dentist's appointment for someone in Health), which goes on the calendar of only that person's carers and the admins. It shows on the household calendar. `private` hides a pet, baby or car appointment from helpers and kids (admins and members only can set it).",
  kind: 'write',
  input: {
    ...common,
    ...idempotency,
    app: z.enum(APPOINTMENT_APPS),
    title: z.string().min(1).max(120).describe('"Annual checkup", "Oil change", "Dr. Example, cardiology".'),
    start: z.string().max(40).describe('Local "YYYY-MM-DDTHH:MM" (or "YYYY-MM-DD" when the time is unknown).'),
    duration_minutes: z.number().int().min(5).max(24 * 60).optional().describe('Health only: how long. Default 60.'),
    location: z.string().max(200).optional(),
    notes: z.string().max(500).optional(),
    pets: z.array(z.string().max(60)).max(10).optional().describe('Pet: which pets, by name or id. Default all.'),
    pet_kind: z.enum(['vet', 'grooming', 'boarding', 'other']).optional().describe('Pet: default vet.'),
    vehicle: z.string().max(60).optional().describe('Car: which car, by name or id.'),
    person: z.string().max(60).optional().describe('Health: whose appointment, by name or id (required for health).'),
    private: z.boolean().optional().describe('Pet, baby, car: only admins and members see it. Default false.'),
  },
  async run(ctx, args) {
    const when = ctx.clock.parse(args.start);
    if (!when) throw new UserError('error.badDate', { value: args.start });
    if (args.private && ctx.here.restricted) throw new UserError('appointment.privateStaffOnly');
    const now = ctx.clock.now();
    const id = await recordId(ctx.session.props.connectionId, 'add_appointment', args.idempotency_key);
    const base = `households/${ctx.here.id}`;
    const title = clip(args.title, 120);
    const location = clip(args.location, 200);
    const notes = clip(args.notes, 500);
    const at = Math.round(when.at);
    const common = { title, at, ...(location ? { location } : {}), ...(notes ? { notes } : {}), private: args.private === true, createdAt: now, by: ctx.session.email, via: 'assistant' };
    const day = () => (when.allDay ? formatDateLong(ctx.clock.local(at)) : `${formatDateLong(ctx.clock.local(at))} ${formatTime(ctx.clock.local(at))}`);
    let path: string;
    let url: string;
    let who = '';
    if (args.app === 'pet') {
      const pets = (await ctx.session.db.query(base, 'petProfiles')).map((d) => ({ id: d.id, name: String(d.data.name ?? '') }));
      const chosen = args.pets?.length
        ? args.pets.map((p) => {
            const { found } = pick(pets, p, (x) => x.id, (x) => x.name);
            if (!found) throw new UserError('pet.unknown', { name: p, pets: pets.map((x) => x.name).join(', ') });
            return found;
          })
        : pets;
      who = chosen.map((p) => p.name).join(', ');
      path = `${base}/petAppointments/${id}`;
      url = ctx.session.link('pet', '?tab=appointments');
      const repeated = await create(ctx, path, { petIds: [...new Set(chosen.map((p) => p.id))].slice(0, 10), kind: args.pet_kind ?? 'vet', ...common });
      return done(ctx, 'pet', path, id, repeated, title, day, url, who);
    }
    if (args.app === 'baby') {
      path = `${base}/babyAppointments/${id}`;
      url = ctx.session.link('baby', '#appointments');
      const repeated = await create(ctx, path, common);
      return done(ctx, 'baby', path, id, repeated, title, day, url, who);
    }
    if (args.app === 'car') {
      let vehicleId: string | undefined;
      if (args.vehicle) {
        const cars = (await ctx.session.db.query(base, 'carVehicles')).map((d) => ({ id: d.id, name: String(d.data.name ?? '') }));
        const { found } = pick(cars, args.vehicle, (x) => x.id, (x) => x.name);
        if (!found) throw new UserError('car.unknown', { name: args.vehicle, cars: cars.map((c) => c.name).join(', ') || '-' });
        vehicleId = found.id;
        who = found.name;
      }
      path = `${base}/carAppointments/${id}`;
      url = ctx.session.link('car');
      const repeated = await create(ctx, path, { ...(vehicleId ? { vehicleId } : {}), ...common });
      return done(ctx, 'car', path, id, repeated, title, day, url, who);
    }
    // Health: an item on the calendars of the person's carers and the admins (personalAgenda), the
    // same people Health shows the person's doses to. Health has no appointments of its own.
    if (!args.person) throw new UserError('health.whichPerson');
    if (ctx.here.role === 'kid') throw new UserError('health.noKids');
    const people = await loadPeople(ctx);
    const { found: person } = pick(people, args.person, (p) => p.id, (p) => p.name);
    if (!person) throw new UserError('health.unknownPerson', { name: args.person, people: people.map((p) => p.name).join(', ') || '-' });
    const admins = ctx.here.members.filter((m) => householdRole(ctx.here, m) === 'admin');
    const audience = cleanAudience([...admins, ...person.readers.filter((r) => householdRole(ctx.here, r) !== 'kid'), ctx.session.email]);
    const end = when.allDay ? at + 24 * 3600_000 : at + (args.duration_minutes ?? 60) * 60_000;
    path = `${base}/personalAgenda/${id}`;
    url = personUrl(ctx, person.id);
    const repeated = await create(ctx, path, {
      app: 'assistant',
      ref: `appointment:${person.id}:${id}`,
      kind: 'appointment',
      title,
      start: at,
      end,
      allDay: when.allDay,
      ...(location || notes ? { detail: clip([location, notes].filter(Boolean).join(' · '), 200) } : {}),
      url,
      who: person.name.slice(0, 60),
      status: 'upcoming',
      private: true,
      audience,
      updatedAt: now,
      by: ctx.session.email,
    });
    return done(ctx, 'health', path, id, repeated, title, day, url, person.name);
  },
});

function done(ctx: ToolContext, app: string, path: string, id: string, repeated: boolean, title: string, day: () => string, url: string, who: string) {
  ctx.touched(app, path.split('/').slice(2).join('/'));
  return render(ctx.lang, () => ({
    text: t('appointment.added', { title, when: day(), who: who || '-', url }),
    data: { id, app, title, url, repeated },
  }));
}

// ---- Contacts: the household's shared address book ----

function contactLine(c: Contact): string {
  const bits = [c.role, c.phone, c.email, c.website, c.address].filter(Boolean);
  return `- **${c.name}**${bits.length ? ` · ${bits.join(' · ')}` : ''}${c.apps.length ? ` · ${c.apps.join(', ')}` : ''}${c.private ? ' · 🔒' : ''} · id \`${c.id}\``;
}

export const contactsSearch = defineTool({
  name: 'contacts_search',
  title: 'Search household contacts',
  description:
    "Searches the household's shared contacts (doctors, the vet, the pharmacy, the plumber, the school…) by name, role, phone, email, address or notes. Helpers and kids see only contacts not marked private.",
  kind: 'read',
  input: {
    ...common,
    query: z.string().max(100).optional().describe('Words to look for. Leave out to list all.'),
    app: z.enum(['tasks', 'groceries', 'pet', 'baby', 'home', 'car', 'bills', 'health']).optional().describe("Only contacts shown in this app."),
  },
  async run(ctx, args) {
    const docs = await ctx.session.openRecords(ctx.here, 'contacts', true);
    ctx.touched('contacts');
    const words = fold(args.query ?? '').split(/\s+/).filter(Boolean);
    const all = docs.map((d) => toContact(d.id, d.data));
    const found = all
      .filter((c) => (!args.app || c.apps.includes(args.app)) && words.every((w) => fold([c.name, c.role, c.phone, c.email, c.website, c.address, c.notes].filter(Boolean).join(' ')).includes(w)))
      .sort((a, b) => a.name.localeCompare(b.name));
    return render(ctx.lang, () => ({
      text: [`**${t('contacts.title', { count: found.length })}** · ${ctx.here.name}`, '', ...(found.length ? found.slice(0, 50).map(contactLine) : [t('contacts.none')])].join('\n'),
      data: { household: ctx.here.id, contacts: found.slice(0, 50).map(({ createdAt: _c, updatedAt: _u, by: _b, ...c }) => c) },
    }));
  },
});

export const contactsAdd = defineTool({
  name: 'contacts_add',
  title: 'Add a household contact',
  description:
    "Adds a person or business to the household's shared contacts, as this person, shown in the apps you name (a pediatrician in baby, a vet in pet, a pharmacy or doctor in health…). `private` keeps it from helpers and kids (admins and members only).",
  kind: 'write',
  input: {
    ...common,
    ...idempotency,
    name: z.string().min(1).max(120),
    role: z.string().max(60).optional().describe('"Pediatrician", "Vet", "Pharmacy", "Doctor", "Plumber".'),
    phone: z.string().max(40).optional(),
    email: z.string().max(120).optional(),
    website: z.string().max(300).optional(),
    address: z.string().max(300).optional(),
    notes: z.string().max(1000).optional(),
    apps: z.array(z.enum(['tasks', 'groceries', 'pet', 'baby', 'home', 'car', 'bills', 'health'])).min(1).max(8).describe('Apps that show it.'),
    private: z.boolean().optional(),
  },
  async run(ctx, args) {
    if (args.private && ctx.here.restricted) throw new UserError('appointment.privateStaffOnly');
    const input = cleanContact(contactInput({ name: args.name, role: args.role, phone: args.phone, email: args.email, website: args.website, address: args.address, notes: args.notes, private: args.private === true }, args.apps, args.apps[0]));
    if (input.website && !/^https?:\/\/.+/i.test(input.website)) throw new UserError('error.badLink');
    const id = await recordId(ctx.session.props.connectionId, 'contacts_add', args.idempotency_key);
    const repeated = await create(ctx, `households/${ctx.here.id}/contacts/${id}`, { ...input, createdAt: ctx.clock.now(), by: ctx.session.email, via: 'assistant' });
    ctx.touched('contacts', `contacts/${id}`);
    return render(ctx.lang, () => ({ text: t('contacts.added', { name: input.name, apps: input.apps.join(', ') }), data: { id, ...input, repeated } }));
  },
});
