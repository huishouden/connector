import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { FirestoreError } from '@huishouden/pwa-kit/firestore-rest';
import { ALICE, BOB, CAROL, HELEN, KIM, MALLORY, NOW } from '../fixtures/household';
import { call, connect, owner, read, seed, type Connected } from '../helpers';

// Baby's settings under the household's rules: admins and members change them, helpers read them,
// kids have neither, another household nothing; a reminder time schedules the kick reminders the
// rules accept.
let alice: Connected, bob: Connected, carol: Connected, helen: Connected, kim: Connected, mallory: Connected;
beforeAll(async () => {
  await seed();
  [alice, bob, carol, helen, kim, mallory] = await Promise.all([ALICE, BOB, CAROL, HELEN, KIM, MALLORY].map((e) => connect(e)));
});
afterAll(async () => {
  for (const c of [alice, bob, carol, helen, kim, mallory]) await c.close();
});

const NOTE = 'households/h1/babyContractionSettings/main';
const KICKS = 'households/h1/babyKickSettings/main';
const kickReminders = async () =>
  (await owner.query('households/h1', 'reminders', { where: [{ field: 'app', op: 'EQUAL', value: 'baby' }] })).filter((d) => String(d.data.ref).startsWith('kicks:'));

/**
 * The rules themselves refuse `who` this write, past the tool's own role check, and only for who
 * they are: the same body signed by an admin and written by her is accepted (then put back).
 */
async function rulesRefuse(who: Connected, path: string, set: Record<string, unknown>): Promise<void> {
  const err = await who.db.commit([{ path, set }]).then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(FirestoreError);
  expect((err as FirestoreError).code).toBe('permission-denied');
  const before = await read(path);
  const signed = 'updatedBy' in set ? { ...set, updatedBy: ALICE } : set;
  await alice.db.commit([{ path, set: signed }]);
  await owner.commit([before ? { path, set: before.data } : { path, delete: true }]);
}

const readRefused = (who: Connected, path: string) => who.db.get(path).then(() => null, (e: unknown) => (e as FirestoreError).code);

describe('baby settings', () => {
  test('a member saves the instructions from the provider; a helper reads them; helpers and kids change nothing', async () => {
    const saved = await call(carol, 'baby_set_contraction_note', { note: 'Call L&D at 5-1-1, or if waters break' });
    expect(saved.isError).toBe(false);
    const stored = { note: 'Call L&D at 5-1-1, or if waters break', updatedAt: NOW, updatedBy: CAROL };
    expect((await read(NOTE))!.data).toEqual(stored);
    const seen = await call(helen, 'baby_settings');
    expect(seen.data).toMatchObject({ contraction_note: stored.note, contraction_note_updated_by: CAROL, kick_target: 10, kick_remind_at: null });
    for (const who of [helen, kim]) {
      expect((await call(who, 'baby_set_contraction_note', { note: 'x' })).isError).toBe(true);
      await rulesRefuse(who, NOTE, { note: 'x', updatedAt: NOW, updatedBy: who.props.email });
    }
    expect((await call(helen, 'baby_set_contraction_note', { note: 'x' })).text).toBe("Only admins and members can change Baby's settings.");
    expect((await call(kim, 'baby_settings')).text).toBe("Baby's settings aren't available to kids.");
    expect([await readRefused(kim, NOTE), await readRefused(kim, KICKS)]).toEqual(['permission-denied', 'permission-denied']);
    expect((await read(NOTE))!.data).toEqual(stored);
  });

  test("a reminder time schedules the next 7 days' kick reminders in the writer's language; only admins and members change it; off removes them", async () => {
    const r = await call(bob, 'baby_set_kick_settings', { target: 12, remind_at: '19:00' });
    expect(r.isError).toBe(false);
    const stored = { target: 12, remindAt: '19:00', updatedAt: NOW, updatedBy: BOB };
    expect((await read(KICKS))!.data).toEqual(stored);
    const scheduled = await kickReminders();
    expect(scheduled).toHaveLength(7);
    const first = scheduled.find((d) => d.data.ref === 'kicks:2031-01-07')!;
    expect(first.data).toMatchObject({ at: Date.UTC(2031, 0, 8, 0), private: true, recipients: 'all', sent: false, by: BOB, source: { checks: [{ doc: 'babyKickSessions/2031-01-07', absent: true }] } });
    expect(first.data).toMatchObject({ title: 'Tijd om bewegingen te tellen', url: 'https://huishouden-staging.web.app/baby/#kicks' });
    expect((await call(alice, 'baby_settings')).data).toMatchObject({ kick_target: 12, kick_remind_at: '19:00' });

    for (const who of [helen, kim]) {
      for (const args of [{ remind_at: 'off' }, { target: 3, remind_at: '08:00' }]) expect((await call(who, 'baby_set_kick_settings', args)).isError).toBe(true);
      await rulesRefuse(who, KICKS, { target: 3, remindAt: '08:00', updatedAt: NOW, updatedBy: who.props.email });
    }
    expect((await read(KICKS))!.data).toEqual(stored);
    expect(await kickReminders()).toHaveLength(7);

    expect((await call(alice, 'baby_set_kick_settings', { remind_at: 'off' })).isError).toBe(false);
    expect(await kickReminders()).toHaveLength(0);
    expect((await read(KICKS))!.data).toEqual({ target: 12, updatedAt: NOW, updatedBy: ALICE });
  });

  test('each is signed by the member who saves it: an admin cannot save them as someone else', async () => {
    for (const [path, set] of [[NOTE, { note: 'x', updatedAt: NOW, updatedBy: BOB }], [KICKS, { target: 10, updatedAt: NOW, updatedBy: BOB }]] as const) {
      const err = await alice.db.commit([{ path, set: { ...set } }]).then(() => null, (e: unknown) => e);
      expect((err as FirestoreError).code).toBe('permission-denied');
    }
  });

  test('another household gets nothing of these and changes nothing', async () => {
    const before = [(await read(NOTE))?.data, (await read(KICKS))?.data];
    expect((await call(mallory, 'baby_settings', { household: 'h1' })).isError).toBe(true);
    expect((await call(mallory, 'baby_set_contraction_note', { household: 'h1', note: 'x' })).isError).toBe(true);
    expect((await call(mallory, 'baby_set_kick_settings', { household: 'h1', target: 3 })).isError).toBe(true);
    expect((await call(mallory, 'baby_settings')).data).toMatchObject({ household: 'h2', contraction_note: '', kick_target: 10 });
    expect([await readRefused(mallory, NOTE), await readRefused(mallory, KICKS)]).toEqual(['permission-denied', 'permission-denied']);
    await rulesRefuse(mallory, NOTE, { note: 'x', updatedAt: NOW, updatedBy: MALLORY });
    await rulesRefuse(mallory, KICKS, { target: 3, updatedAt: NOW, updatedBy: MALLORY });
    expect([(await read(NOTE))?.data, (await read(KICKS))?.data]).toEqual(before);
  });
});
