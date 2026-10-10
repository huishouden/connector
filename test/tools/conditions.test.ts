import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ALICE, BOB, CAROL, HELEN, KIM, MALLORY, householdDocs } from '../fixtures/household';
import { call, connect, owner, read, seed, type Connected } from '../helpers';

// Health conditions through the tools, under the household's real rules: admins and member carers
// read and add them; a helper carer, a member who isn't a carer, a kid and an outsider get nothing.
const NAN = 'households/h1/healthPeople/nan';
const example = (over: Record<string, unknown> = {}) => ({
  personId: 'nan', name: 'Example condition', icd10: 'A00.0', specialty: 'primary', status: 'active', diagnosed: '2030-03', doctorId: 'doc1', medIds: ['m1'], notes: 'Example note.', createdAt: 1, by: ALICE, ...over,
});

let alice: Connected, bob: Connected, carol: Connected, helen: Connected, kim: Connected, mallory: Connected;
beforeAll(async () => {
  await seed({
    ...householdDocs(),
    [`${NAN}/conditions/k1`]: example(),
    [`${NAN}/conditions/k2`]: example({ name: 'Example asthma', icd10: 'J45.909', specialty: 'pulmonology', status: 'resolved', resolved: '2030-12', medIds: [] }),
  });
  [alice, bob, carol, helen, kim, mallory] = await Promise.all([ALICE, BOB, CAROL, HELEN, KIM, MALLORY].map((e) => connect(e, { lang: 'en' })));
});
afterAll(async () => {
  for (const c of [alice, bob, carol, helen, kim, mallory]) await c.close();
});

describe('health_conditions', () => {
  test('admins and member carers get them grouped by medical area, with the doctor and the medicine', async () => {
    for (const c of [alice, bob]) {
      const r = await call(c, 'health_conditions', { person: 'Nan' });
      expect(r.isError).toBeFalsy();
      const groups = r.data.people[0].groups as { specialty: string; conditions: { name: string; diagnosed_by?: { name: string }; medicines: { name: string }[] }[] }[];
      expect(groups.map((g) => g.specialty)).toEqual(['primary', 'pulmonology']);
      expect(groups[0].conditions[0]).toMatchObject({ name: 'Example condition', diagnosed_by: { name: 'Dr. Example' }, medicines: [{ name: 'Examplamine 10 mg' }] });
    }
    const only = await call(bob, 'health_conditions', { person: 'Nan', specialty: 'pulmonology', lang: 'en' });
    expect(only.text).toContain('Example asthma');
    expect(only.text).not.toContain('Example condition');
  });

  test('a helper carer, a non-carer member, a kid and an outsider get none', async () => {
    for (const c of [helen, carol, kim, mallory]) {
      const named = await call(c, 'health_conditions', { person: 'Nan' });
      expect(named.isError).toBe(true);
      expect(named.text).not.toContain('Example condition');
    }
    for (const c of [helen, carol, kim, mallory]) {
      const all = await call(c, 'health_conditions', {});
      expect(JSON.stringify(all.data ?? all.text)).not.toContain('Example condition');
      expect((await call(c, 'health_doctor_list', { person: 'Nan' })).text ?? '').not.toContain('Example condition');
    }
  });

  test("the rules refuse them straight from Firestore too, not only the tools", async () => {
    for (const c of [helen, carol, kim, mallory]) {
      await expect(c.db.get(`${NAN}/conditions/k1`)).rejects.toMatchObject({ code: 'permission-denied' });
      await expect(c.db.query(NAN, 'conditions')).rejects.toMatchObject({ code: 'permission-denied' });
    }
  });

  test('the doctor list has the current conditions for keepers', async () => {
    const list = await call(bob, 'health_doctor_list', { person: 'Nan', lang: 'en' });
    expect(list.text).toContain('## Conditions');
    expect(list.text).toContain('Example condition');
    expect(list.text).not.toContain('Example asthma');
  });
});

describe('health_add_condition', () => {
  test('a member carer adds one in their own name, filed under its code; the rules accept the document as written', async () => {
    const r = await call(bob, 'health_add_condition', { person: 'Nan', name: 'Example radiculopathy', icd10: 'M54.12', diagnosed: '2030', doctor: 'Dr. Example', medicines: ['Examplamine'], idempotency_key: 'cond-1' });
    expect(r.isError).toBeFalsy();
    const doc = await read(`${NAN}/conditions/${r.data.id}`);
    expect(doc!.data).toMatchObject({ personId: 'nan', name: 'Example radiculopathy', icd10: 'M54.12', specialty: 'neurology', status: 'active', diagnosed: '2030', doctorId: 'doc1', medIds: ['m1'], by: BOB, via: 'assistant' });
    const again = await call(bob, 'health_add_condition', { person: 'Nan', name: 'Example radiculopathy', idempotency_key: 'cond-1' });
    expect(again.data).toMatchObject({ id: r.data.id, repeated: true });
  });

  test('a helper carer and a non-carer member are refused; nothing is written', async () => {
    for (const c of [helen, carol, kim, mallory]) {
      const r = await call(c, 'health_add_condition', { person: 'Nan', name: 'Example refused' });
      expect(r.isError).toBe(true);
    }
    expect(JSON.stringify((await call(alice, 'health_conditions', { person: 'Nan' })).data)).not.toContain('Example refused');
  });

  test("add_appointment links a visit to a condition for a keeper; a helper can't", async () => {
    const r = await call(bob, 'add_appointment', { app: 'health', person: 'Nan', title: 'Example check', start: '2031-01-12T10:00', condition: 'Example condition', specialty: 'primary' });
    expect(r.isError).toBeFalsy();
    const visits = (await call(bob, 'health_appointments', { person: 'Nan' })).data.visits as { title: string; condition?: { name: string }; specialty?: string }[];
    expect(visits.find((v) => v.title === 'Example check')).toMatchObject({ condition: { name: 'Example condition' }, specialty: 'primary' });
    const forHelen = (await call(helen, 'health_appointments', { person: 'Nan' })).data.visits as { title: string; condition?: unknown }[];
    expect(forHelen.find((v) => v.title === 'Example check')!.condition).toBeUndefined();
    expect((await call(helen, 'add_appointment', { app: 'health', person: 'Nan', title: 'Example', start: '2031-01-12T11:00', condition: 'Example condition' })).isError).toBe(true);
    // What Helen reads straight from Firestore (the visit, the calendar item, the reminders) holds no condition.
    const id = (await call(bob, 'health_appointments', { person: 'Nan' })).data.visits.find((v: { title: string }) => v.title === 'Example check').id;
    const published = [
      await helen.db.get(`${NAN}/visits/${id}`),
      ...(await owner.query('households/h1', 'personalAgenda', { where: [{ field: 'ref', op: 'EQUAL', value: `visit:nan:${id}` }] })),
      ...(await owner.query('households/h1', 'personalReminders', { where: [{ field: 'ref', op: 'EQUAL', value: `health:visit:${id}` }] })),
    ];
    expect(JSON.stringify(published)).not.toMatch(/Example condition|A00\.0|Examplamine/);
  });

  test('the logs say which tool and how it went, never the diagnosis, code, area or person', async () => {
    await Promise.all([alice.settled(), bob.settled(), helen.settled(), carol.settled(), kim.settled()]);
    const logs = JSON.stringify([...alice.logs, ...bob.logs, ...helen.logs, ...carol.logs, ...kim.logs]);
    expect(logs).not.toMatch(/Example|M54|J45|A00|neurology|pulmonology|Nan|Dr\. Example|@/);
  });
});
