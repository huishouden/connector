import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ALICE, BOB, CAROL, HELEN, KIM, MALLORY, NOW, ny } from '../fixtures/household';
import { call, connect, read, seed, type Connected } from '../helpers';

let alice: Connected, bob: Connected, carol: Connected, helen: Connected, kim: Connected, mallory: Connected;
beforeAll(async () => {
  await seed();
  [alice, bob, carol, helen, kim, mallory] = await Promise.all([ALICE, BOB, CAROL, HELEN, KIM, MALLORY].map((e) => connect(e, { lang: 'en' })));
});
afterAll(async () => {
  for (const c of [alice, bob, carol, helen, kim, mallory]) await c.close();
});

const HEALTH_TOOLS: [string, Record<string, unknown>][] = [
  ['health_medicines', { person: 'Nan' }],
  ['health_history', { person: 'Nan' }],
  ['health_due', { person: 'Nan' }],
  ['health_doctor_list', { person: 'Nan' }],
  ['health_log_dose', { person: 'Nan', medicine: 'Paracetamol' }],
  ['health_update_medicine', { person: 'Nan', medicine: 'Examplamine', refill_ordered: true }],
];

describe('who sees Health', () => {
  test('admins and carers see Nan; a member who is not a carer, a kid and a non-member get nothing', async () => {
    for (const c of [alice, bob, helen]) expect((await call(c, 'health_people')).data.people.map((p: { name: string }) => p.name)).toEqual(['Nan']);
    expect((await call(carol, 'health_people')).data.people).toEqual([]);
    expect((await call(kim, 'health_people')).text).toContain("isn't available to kids");
    expect((await call(mallory, 'health_people')).data.people).toEqual([]);
  });

  for (const [tool, args] of HEALTH_TOOLS) {
    test(`${tool}: nothing about Nan for a non-carer, a kid or a non-member`, async () => {
      for (const c of [carol, kim, mallory]) {
        const r = await call(c, tool, args);
        expect(r.isError).toBe(true);
        expect(r.text).not.toContain('Examplamine');
        expect(r.text).not.toContain('Penicillin');
      }
    });
  }

  test('every Health answer carries the not-medical-advice note', async () => {
    expect((await call(bob, 'health_people', { lang: 'en' })).text).toContain('not medical advice');
    expect((await call(bob, 'health_people', { lang: 'nl' })).text).toContain('geen medisch advies');
  });
});

describe('reading', () => {
  test('health_medicines: strength, dose, schedule, prescriber, pharmacy, supply, refills, notes, allergies', async () => {
    const r = await call(bob, 'health_medicines', { person: 'nan', lang: 'en' });
    expect(r.data.person).toMatchObject({ name: 'Nan', allergies: 'Penicillin' });
    const m1 = r.data.medicines.find((m: { id: string }) => m.id === 'm1');
    expect(m1).toMatchObject({
      name: 'Examplamine', strength: '10 mg', dose: '1 tablet', times: ['08:00', '20:00'], with_food: true, refills: 2,
      prescriber: { name: 'Dr. Example', phone: '555-0100' }, pharmacy: { name: 'Corner Pharmacy' }, notes: 'Take with a full glass of water',
    });
    // 12 counted five days ago, two doses given since, one a day... at two a day: 10 left, 5 days.
    expect(m1).toMatchObject({ supply_left: 10, days_left: 5, refill_due: true });
    expect(r.text).toContain('Every day at 8 AM and 8 PM');
    expect(r.data.medicines.find((m: { id: string }) => m.id === 'm2')).toMatchObject({ as_needed: true, min_hours: 4, max_per_day: 4 });
  });

  test("health_due: this morning's dose given by Helen, tonight's later, paracetamol fine now", async () => {
    const r = await call(helen, 'health_due', { lang: 'en' });
    const nan = r.data.people[0];
    expect(nan.doses).toEqual([
      expect.objectContaining({ slot: '2031-01-07T08:00', state: 'given', by: HELEN }),
      expect.objectContaining({ slot: '2031-01-07T20:00', state: 'upcoming' }),
    ]);
    expect(nan.as_needed).toEqual([expect.objectContaining({ medicine: 'm2', ok_now: true })]);
    expect(nan.refills_due).toEqual([expect.objectContaining({ medicine: 'm1', days_left: 5 })]);
  });

  test('health_history: adherence over the range', async () => {
    const r = await call(bob, 'health_history', { person: 'Nan', from: '2031-01-06', to: '2031-01-07', lang: 'en' });
    const m1 = r.data.medicines.find((m: { id: string }) => m.id === 'm1');
    // Jan 6: 08:00 missed, 20:00 given; Jan 7: 08:00 given (20:00 not yet).
    expect(m1).toMatchObject({ given: 2, missed: 1 });
    expect(r.data.adherence_percent).toBe(67);
  });

  test("health_doctor_list: Health's printable list as Markdown", async () => {
    const r = await call(bob, 'health_doctor_list', { person: 'Nan', lang: 'en' });
    expect(r.text).toContain('# Medicines for Nan');
    expect(r.text).toContain('Allergies: Penicillin');
    expect(r.text).toContain('## Taken regularly');
    expect(r.text).toContain('| Examplamine 10 mg | 1 tablet, with food |');
    expect(r.text).toContain('## When needed');
    expect(r.text).toContain('Corner Pharmacy (Pharmacy), 555-0199');
    expect(r.text).toContain('Born Thursday, March 2, 1950 (80)');
  });
});

describe('logging doses with the guards', () => {
  test('a scheduled dose already given warns and writes nothing; someone else\'s dose stays theirs', async () => {
    const r = await call(bob, 'health_log_dose', { person: 'Nan', medicine: 'Examplamine', dose_time: '08:00', lang: 'en' });
    expect(r.data).toMatchObject({ written: false, needs_confirmation: true });
    expect(r.text).toContain('was already given');
    expect(r.text).toContain('Helen Example');
    const forced = await call(bob, 'health_log_dose', { person: 'Nan', medicine: 'Examplamine', dose_time: '08:00', confirm: true });
    expect(forced.isError).toBe(true);
    expect((await read('households/h1/healthPeople/nan/doses/m1_2031-01-07T0800'))!.data.by).toBe(HELEN);
  });

  test("tonight's dose, logged as given by a helper carer, with Health's id for the slot", async () => {
    const at = await call(helen, 'health_log_dose', { person: 'Nan', medicine: 'Examplamine', dose_time: '20:00', given_at: '2031-01-07T09:55' });
    // 09:55 is within half the gap (6 hours) of this morning's: the guard asks first.
    expect(at.data.needs_confirmation).toBe(true);
    const ok = await call(helen, 'health_log_dose', { person: 'Nan', medicine: 'Examplamine', dose_time: '20:00', given_at: '2031-01-07T09:55', confirm: true, note: 'Asked for it early' });
    expect(ok.isError).toBe(false);
    expect((await read('households/h1/healthPeople/nan/doses/m1_2031-01-07T2000'))!.data).toEqual({
      personId: 'nan', medId: 'm1', slot: '2031-01-07T20:00', at: ny('09:55'), status: 'given', note: 'Asked for it early', by: HELEN, createdAt: NOW, via: 'assistant',
    });
  });

  test('as needed: the minimum hours between doses guard, then the daily maximum', async () => {
    const first = await call(bob, 'health_log_dose', { person: 'Nan', medicine: 'Paracetamol', given_at: '2031-01-07T07:00', idempotency_key: 'p-1' });
    expect(first.data.written).toBe(true);
    const tooSoon = await call(bob, 'health_log_dose', { person: 'Nan', medicine: 'Paracetamol', lang: 'en' });
    expect(tooSoon.data.needs_confirmation).toBe(true);
    expect(tooSoon.text).toContain('needs 4 hours between doses');
    expect(tooSoon.text).toContain('The next dose is fine from 11 AM');
    const repeat = await call(bob, 'health_log_dose', { person: 'Nan', medicine: 'Paracetamol', given_at: '2031-01-07T07:00', idempotency_key: 'p-1' });
    expect(repeat.data).toMatchObject({ id: first.data.id, repeated: true });
  });

  test('skipped needs no guard', async () => {
    const r = await call(bob, 'health_log_dose', { person: 'Nan', medicine: 'Examplamine', dose_time: '2031-01-06T08:00', status: 'skipped', note: 'Asleep' });
    expect(r.data).toMatchObject({ written: true, status: 'skipped', slot: '2031-01-06T08:00' });
  });
});

describe('adding and changing medicines', () => {
  test('a member carer adds a medicine; a helper carer cannot', async () => {
    const r = await call(bob, 'health_add_medicine', { person: 'Nan', name: 'Examplazole', strength: '20 mg', dose: '1 capsule', times: ['07:30'], with_food: false, prescriber: 'Dr. Example', supply: 30, dose_amount: 1, refills: 5, idempotency_key: 'add-1' });
    expect(r.isError).toBe(false);
    const doc = (await read(`households/h1/healthPeople/nan/meds/${r.data.id}`))!.data;
    expect(doc).toMatchObject({ personId: 'nan', name: 'Examplazole', strength: '20 mg', times: ['07:30'], everyDays: 1, withFood: false, prescriberId: 'doc1', supply: 30, supplyAt: NOW, startDate: '2031-01-07', escalateMinutes: 30, remind: true, by: BOB, via: 'assistant' });
    expect((await call(helen, 'health_add_medicine', { person: 'Nan', name: 'Nope', times: ['09:00'] })).text).toContain('Only admins');
    expect((await call(bob, 'health_add_medicine', { person: 'Nan', name: 'No times' })).isError).toBe(true);
  });

  test('a helper carer marks a refill ordered; a member carer stops a medicine', async () => {
    expect((await call(helen, 'health_update_medicine', { person: 'Nan', medicine: 'Examplamine', refill_ordered: true })).isError).toBe(false);
    expect((await read('households/h1/healthPeople/nan/meds/m1'))!.data.refillOrderedAt).toBe(NOW);
    expect((await call(helen, 'health_update_medicine', { person: 'Nan', medicine: 'Examplamine', stop: true })).isError).toBe(true);
    const stop = await call(bob, 'health_update_medicine', { person: 'Nan', medicine: 'paracetamol', stop: true });
    expect(stop.isError).toBe(false);
    const doc = (await read('households/h1/healthPeople/nan/meds/m2'))!.data;
    expect(doc).toMatchObject({ endDate: '2031-01-07', asNeeded: true, minHours: 4, maxPerDay: 4, createdAt: 1, by: BOB });
    const weekly = await call(alice, 'health_update_medicine', { person: 'Nan', medicine: 'Examplamine', weekdays: ['monday', 'thursday'], supply: 20 });
    expect((await read('households/h1/healthPeople/nan/meds/m1'))!.data).toMatchObject({ rule: { freq: 'week', every: 1, days: [1, 4] }, supply: 20, supplyAt: NOW, refillOrderedAt: NOW, prescriberId: 'doc1' });
    expect(weekly.text).toContain('Monday and Thursday');
  });
});
