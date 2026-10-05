import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ALICE, BOB, CAROL, HELEN, KIM, NOW } from '../fixtures/household';
import { call, connect, owner, read, seed, type Connected } from '../helpers';

let alice: Connected, helen: Connected, kim: Connected, carol: Connected, bob: Connected;
beforeAll(async () => {
  await seed();
  [alice, helen, kim, carol, bob] = await Promise.all([ALICE, HELEN, KIM, CAROL, BOB].map((e) => connect(e)));
});
afterAll(async () => {
  for (const c of [alice, helen, kim, carol, bob]) await c.close();
});

describe('pet', () => {
  test("pet_today: meals fed or due, the heartworm chew due today, today's ear drops", async () => {
    const r = await call(alice, 'pet_today');
    const biscuit = r.data.pets[0];
    expect(biscuit.meals).toEqual([
      expect.objectContaining({ name: 'Breakfast', state: 'fed', fed_by: HELEN }),
      expect.objectContaining({ name: 'Dinner', state: 'due' }),
    ]);
    expect(biscuit.reminders).toEqual([expect.objectContaining({ id: 'r1', state: 'today', medicine: true })]);
    expect(biscuit.courses[0].slots.map((s: { state: string }) => s.state)).toEqual(['missed', 'due']);
  });

  test("pet_log_feeding ticks the next unfed meal as the person", async () => {
    const r = await call(kim, 'pet_log_feeding', { pet: 'biscuit' });
    expect(r.isError).toBe(false);
    expect(r.data.meal).toBe('p1-pm');
    expect((await read(`households/h1/petFeedings/${r.data.id}`))!.data).toMatchObject({ petId: 'p1', mealId: 'p1-pm', by: 'kim@example.com', via: 'assistant', at: NOW });
  });

  test('pet_log_dose: the reminder moves on a month; a course slot once; kids never', async () => {
    expect((await call(kim, 'pet_log_dose', { pet: 'Biscuit', medicine: 'Heartworm chew' })).isError).toBe(true);
    const r = await call(helen, 'pet_log_dose', { pet: 'Biscuit', medicine: 'heartworm' });
    expect(r.isError).toBe(false);
    expect((await read('households/h1/petReminders/r1'))!.data).toMatchObject({ due: '2031-02-07', lastDoneAt: NOW });
    expect((await read(`households/h1/petDoses/${r.data.id}`))!.data).toMatchObject({ reminderId: 'r1', by: HELEN, via: 'assistant' });
    const drops = await call(helen, 'pet_log_dose', { pet: 'Biscuit', medicine: 'Ear drops', time: '08:00' });
    expect(drops.data).toMatchObject({ course: 'c1', slot: 0 });
    const again = await call(helen, 'pet_log_dose', { pet: 'Biscuit', medicine: 'Ear drops', time: '08:00' });
    expect(again.data).toMatchObject({ written: false, needs_confirmation: true });
  });
});

describe('home', () => {
  test('home_upkeep_due: the overdue filter and this week\'s trash pickup', async () => {
    const r = await call(carol, 'home_upkeep_due', { days: 7 });
    expect(r.data.jobs).toEqual([expect.objectContaining({ id: 'j1', overdue: true, todo_id: 'home:job:j1' })]);
    expect(r.data.events.map((e: { date: string }) => e.date)).toEqual(['2031-01-09']);
  });

  test('home_add_event: a regular event on a rule, and a booked visit', async () => {
    const r = await call(helen, 'home_add_event', { type: 'regular', title: 'Recycling', kind: 'recycling', start: '2031-01-07', frequency: 'week', every: 2, weekdays: ['tuesday'] });
    expect(r.isError).toBe(false);
    expect((await read(`households/h1/homeEvents/${r.data.id}`))!.data).toMatchObject({ title: 'Recycling', kind: 'recycling', rule: { freq: 'week', every: 2, start: '2031-01-07' }, by: HELEN, via: 'assistant' });
    const m = await call(alice, 'home_add_event', { type: 'regular', title: 'HOA meeting', kind: 'hoa', start: '2031-01-27', frequency: 'month', nth_weekday: { nth: -1, weekday: 'monday' }, time: '19:00' });
    expect(m.data.rule).toMatchObject({ freq: 'month', nth: -1, weekday: 1 });
    const v = await call(alice, 'home_add_event', { type: 'visit', title: 'Plumber: kitchen sink', start: '2031-01-14', who: 'Example Plumbing', cost: 180 });
    expect((await read(`households/h1/homeServiceLog/${v.data.id}`))!.data).toMatchObject({ date: '2031-01-14', who: 'Example Plumbing', costCents: 18000 });
  });
});

describe('appointments and contacts', () => {
  test('pet, baby and car appointments in their apps; private only for admins and members', async () => {
    const p = await call(helen, 'add_appointment', { app: 'pet', title: 'Grooming', start: '2031-01-12T10:30', pet_kind: 'grooming' });
    expect((await read(`households/h1/petAppointments/${p.data.id}`))!.data).toMatchObject({ petIds: ['p1'], kind: 'grooming', at: Date.parse('2031-01-12T10:30:00-05:00'), private: false, by: HELEN });
    expect((await call(helen, 'add_appointment', { app: 'baby', title: 'Checkup', start: '2031-01-12T10:30', private: true })).isError).toBe(true);
    const b = await call(alice, 'add_appointment', { app: 'baby', title: 'Checkup', start: '2031-01-12', private: true });
    expect((await read(`households/h1/babyAppointments/${b.data.id}`))!.data).toMatchObject({ private: true });
    const c = await call(alice, 'add_appointment', { app: 'car', title: 'Oil change', start: '2031-01-20T09:00', vehicle: 'blue wagon', location: 'Example Garage' });
    expect((await read(`households/h1/carAppointments/${c.data.id}`))!.data).toMatchObject({ vehicleId: 'v1', location: 'Example Garage' });
  });

  test("a health appointment is a visit in Health, on the calendars and reminders of the person's carers and the admins only", async () => {
    const r = await call(alice, 'add_appointment', { app: 'health', person: 'Nan', title: 'Cardiology follow-up', start: '2031-01-15T11:00', location: 'Example Heart Center', notes: 'Bring the ECG', doctor: 'Dr. Example', prep: ['Fasting from midnight'], bring_medicine_list: true, follow_up: { every: 3, unit: 'month' } });
    expect(r.isError).toBe(false);
    const at = Date.parse('2031-01-15T11:00:00-05:00');
    expect((await read(`households/h1/healthPeople/nan/visits/${r.data.id}`))!.data).toMatchObject({ personId: 'nan', kind: 'specialist', title: 'Cardiology follow-up', at, contactId: 'doc1', location: 'Example Heart Center', prep: ['Fasting from midnight'], medList: true, remindBefore: [1440, 120], followUp: { every: 3, unit: 'month' }, by: ALICE, via: 'assistant' });
    expect((await read(`households/h1/healthPeople/nan/visitNotes/${r.data.id}`))!.data).toMatchObject({ text: 'Bring the ECG', by: ALICE, via: 'assistant' });
    const agenda = await owner.query('households/h1', 'personalAgenda', { where: [{ field: 'ref', op: 'EQUAL', value: `visit:nan:${r.data.id}` }] });
    expect(agenda).toHaveLength(1);
    expect(agenda[0].data).toMatchObject({ app: 'health', kind: 'appointment', title: 'Appointment for Nan', start: at, audience: [ALICE, 'bob@example.com', HELEN], private: true, who: 'Nan' });
    expect(agenda[0].data.calendarDetail).toBe('Specialist: Cardiology follow-up with Dr. Example · Example Heart Center · Fasting from midnight · bring the medicine list');
    expect(JSON.stringify(agenda[0].data)).not.toContain('ECG');
    const reminders = await owner.query('households/h1', 'personalReminders', { where: [{ field: 'ref', op: 'EQUAL', value: `health:visit:${r.data.id}` }] });
    expect(reminders.map((x) => x.data.at).sort()).toEqual([at - 86_400_000, at - 2 * 3_600_000]);
    expect(reminders[0].data).toMatchObject({ app: 'health', recipients: ['bob@example.com', HELEN], title: 'Appointment for Nan' });
    expect(JSON.stringify(reminders.map((x) => x.data))).not.toContain('ECG');
    // A helper carer adds one without notes; with notes, refused. Others, never.
    expect((await call(helen, 'add_appointment', { app: 'health', person: 'Nan', title: 'Dentist', start: '2031-01-20T09:00' })).isError).toBe(false);
    expect((await call(helen, 'add_appointment', { app: 'health', person: 'Nan', title: 'Refused dentist', start: '2031-01-21T09:00', notes: 'x' })).isError).toBe(true);
    expect((await call(carol, 'add_appointment', { app: 'health', person: 'Nan', title: 'Refused X', start: '2031-01-22T09:00' })).isError).toBe(true);
    expect((await call(kim, 'add_appointment', { app: 'health', person: 'Nan', title: 'Refused X', start: '2031-01-23T09:00' })).isError).toBe(true);
    // A refused call leaves nothing behind: no visit, no calendar item, no reminder.
    const visits = await owner.query('households/h1/healthPeople/nan', 'visits');
    expect(visits.filter((v) => String(v.data.title).startsWith('Refused'))).toEqual([]);
    // Every calendar item and reminder for Nan's visits belongs to a visit that exists.
    const ids = new Set(visits.map((v) => v.id));
    for (const a of await owner.query('households/h1', 'personalAgenda', { where: [{ field: 'app', op: 'EQUAL', value: 'health' }] })) expect(ids.has(String(a.data.ref).split(':')[2])).toBe(true);
    for (const x of await owner.query('households/h1', 'personalReminders', { where: [{ field: 'app', op: 'EQUAL', value: 'health' }] })) {
      if (String(x.data.ref).startsWith('health:visit:')) expect(ids.has(String(x.data.ref).split(':')[2])).toBe(true);
    }
    // The logs say which tool and how it went, never who, what or where.
    await Promise.all([alice.settled(), helen.settled()]);
    const logs = JSON.stringify([...alice.logs, ...helen.logs, ...carol.logs, ...kim.logs]);
    expect(logs).not.toMatch(/Cardiology|ECG|Heart Center|Fasting|Nan|Dr\. Example|Dentist|@/);
    for (const l of [...alice.logs, ...helen.logs]) expect(['read', 'write']).toContain(l.kind);
  });

  test('a private doctor is named only where no helper carer reads', async () => {
    await owner.commit([{ path: 'households/h1/contacts/doc2', set: { name: 'Dr. Private', role: 'Doctor', apps: ['health'], private: true, createdAt: 1, by: ALICE } }]);
    const r = await call(alice, 'add_appointment', { app: 'health', person: 'Nan', title: 'Skin check', start: '2031-01-28T10:00', doctor: 'Dr. Private' });
    expect(r.isError).toBe(false);
    // Helen, a helper carer, reads Nan's calendar item and reminders: the doctor isn't in them.
    const published = [
      ...(await owner.query('households/h1', 'personalAgenda', { where: [{ field: 'ref', op: 'EQUAL', value: `visit:nan:${r.data.id}` }] })),
      ...(await owner.query('households/h1', 'personalReminders', { where: [{ field: 'ref', op: 'EQUAL', value: `health:visit:${r.data.id}` }] })),
    ];
    expect(published.length).toBeGreaterThan(0);
    expect(JSON.stringify(published.map((d) => d.data))).not.toContain('Dr. Private');
    expect(JSON.stringify(await call(helen, 'health_appointments', { person: 'Nan' }))).not.toContain('Dr. Private');
    // Alice and Bob may read private contacts, so their answers name the doctor.
    for (const c of [alice, bob]) {
      const visit = (await call(c, 'health_appointments', { person: 'Nan' })).data.visits.find((v: { id: string }) => v.id === r.data.id);
      expect(visit.doctor).toMatchObject({ name: 'Dr. Private' });
    }
  });

  test('health_appointments: the visits, notes only for keepers', async () => {
    await call(alice, 'add_appointment', { app: 'health', person: 'Nan', title: 'Eye exam', start: '2031-01-16T14:00', notes: 'Drops: no driving after', idempotency_key: 'eye-1' });
    const forAlice = await call(alice, 'health_appointments', { person: 'Nan' });
    const eye = forAlice.data.visits.find((v: { title: string }) => v.title === 'Eye exam');
    expect(eye).toMatchObject({ kind: 'eye', state: 'upcoming', notes: 'Drops: no driving after', person: { id: 'nan', name: 'Nan' } });
    const forHelen = await call(helen, 'health_appointments', {});
    const seen = forHelen.data.visits.find((v: { title: string }) => v.title === 'Eye exam');
    expect(seen).toBeTruthy();
    expect(seen.notes).toBeUndefined();
    expect(forHelen.text).not.toContain('no driving');
    // The rules, not just the tool: Helen, a helper carer, can't read the notes directly; Carol and Kim not even the visit.
    await expect(helen.db.get(`households/h1/healthPeople/nan/visitNotes/${eye.id}`)).rejects.toMatchObject({ code: 'permission-denied' });
    for (const c of [carol, kim]) await expect(c.db.get(`households/h1/healthPeople/nan/visits/${eye.id}`)).rejects.toMatchObject({ code: 'permission-denied' });
    // Bob, a member who cares for Nan, keeps the notes.
    const forBob = await call(bob, 'health_appointments', { person: 'Nan' });
    expect(forBob.data.visits.find((v: { id: string }) => v.id === eye.id)).toMatchObject({ notes: 'Drops: no driving after' });
    expect((await call(kim, 'health_appointments', {})).isError).toBe(true);
    expect((await call(carol, 'health_appointments', {})).data.visits).toEqual([]);
  });

  test("contacts: pay details reach admins and members only, and contacts_add never writes them", async () => {
    await owner.commit([{ path: 'households/h1/contactPay/doc1', set: { zelle: 'doctor@example.com', updatedAt: 1, by: ALICE } }]);
    const mine = (await call(alice, 'contacts_search', { query: 'example' })).data.contacts.find((c: { id: string }) => c.id === 'doc1');
    expect(mine.pay).toEqual({ zelle: 'doctor@example.com' });
    const theirs = await call(helen, 'contacts_search', { query: 'example' });
    expect(theirs.isError).toBeFalsy();
    expect(theirs.data.contacts.find((c: { id: string }) => c.id === 'doc1').pay).toBeUndefined();
    expect(JSON.stringify(theirs)).not.toContain('doctor@example.com');
    const r = await call(alice, 'contacts_add', { name: 'Example Rentals', apps: ['home'], pay: { zelle: 'x@example.com' } } as never);
    expect('pay' in ((await read(`households/h1/contacts/${r.data.id}`))?.data ?? {})).toBe(false);
  });

  test('contacts: helpers search only open contacts and add open ones', async () => {
    expect((await call(alice, 'contacts_search', { query: 'lawyer' })).data.contacts).toHaveLength(1);
    expect((await call(helen, 'contacts_search', { query: 'lawyer' })).data.contacts).toHaveLength(0);
    expect((await call(helen, 'contacts_search', { app: 'health' })).data.contacts.map((c: { name: string }) => c.name)).toEqual(['Corner Pharmacy', 'Dr. Example']);
    const r = await call(helen, 'contacts_add', { name: 'Example Vet Clinic', role: 'Vet', phone: '555-0123', website: 'example.com', apps: ['pet'] });
    expect((await read(`households/h1/contacts/${r.data.id}`))!.data).toMatchObject({ name: 'Example Vet Clinic', website: 'https://example.com', apps: ['pet'], private: false, by: HELEN, via: 'assistant' });
    expect((await call(helen, 'contacts_add', { name: 'Secret', apps: ['home'], private: true })).isError).toBe(true);
  });
});
