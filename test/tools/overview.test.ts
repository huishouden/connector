import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ALICE, BOB, HELEN, HOME, KIM, MALLORY, CAROL, NOW } from '../fixtures/household';
import { LocalClock } from '@huishouden/pwa-kit/local-clock';
import { toolNamed, type ToolContext } from '@huishouden/pwa-kit/household-tools';
import { call, connect, owner, read, seed, type Connected } from '../helpers';
import { TOOLS } from '../../src/mcp';

let alice: Connected, bob: Connected, helen: Connected, kim: Connected, mallory: Connected, carol: Connected;
beforeAll(async () => {
  await seed();
  [alice, bob, helen, kim, mallory, carol] = await Promise.all([ALICE, BOB, HELEN, KIM, MALLORY, CAROL].map((e) => connect(e)));
});
afterAll(async () => {
  for (const c of [alice, bob, helen, kim, mallory, carol]) await c.close();
});

describe('tools/list', () => {
  test('every tool is listed with a description and an input schema', async () => {
    const { tools } = await alice.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(tools).toHaveLength(32);
    for (const t of tools) {
      expect(t.description!.length).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe('object');
    }
    expect(tools.find((t) => t.name === 'groceries_add')!.annotations).toMatchObject({ readOnlyHint: false });
    expect(tools.find((t) => t.name === 'today')!.annotations).toMatchObject({ readOnlyHint: true });
  });
});

describe('households', () => {
  test('who is signed in and their households with their role', async () => {
    const a = await call(alice, 'households');
    expect(a.isError).toBe(false);
    expect(a.data.households).toEqual([{ id: 'h1', name: 'Maple Street', role: 'admin', default: true }]);
    expect(a.data.time_zone).toBe('America/New_York');
    expect((await call(helen, 'households')).data.role).toBe('helper');
  });

  test('someone in another household sees only theirs and cannot reach this one', async () => {
    expect((await call(mallory, 'households')).data.households.map((h: { id: string }) => h.id)).toEqual(['h2']);
    const r = await call(mallory, 'today', { household: 'h1' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('not in that household');
  });
});

describe('household_home', () => {
  test('every member reads the address and the household time zone: admin, member, helper and kid', async () => {
    for (const c of [alice, carol, helen, kim]) {
      const r = await call(c, 'household_home');
      expect(r.isError).toBe(false);
      expect(r.text).toContain('Address: 12 Example Lane, Springfield, Illinois 62701');
      expect(r.text).toContain('Household time zone: America/Chicago');
      expect(r.data.home).toMatchObject({ address: HOME.address, approximate: false, time_zone: 'America/Chicago', lat: HOME.lat, lng: HOME.lng });
    }
  });

  test("in the person's language", async () => {
    expect((await call(bob, 'household_home')).text).toContain('Adres: 12 Example Lane');
    expect((await call(alice, 'household_home', { lang: 'es' })).text).toContain('Dirección: 12 Example Lane');
  });

  test('a non-member never gets it: not through the tool, not from Firestore', async () => {
    const r = await call(mallory, 'household_home', { household: 'h1' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('not in that household');
    expect(r.text).not.toContain('Example Lane');
    expect(r.data.home).toBeUndefined();
    await expect(mallory.db.get('households/h1')).rejects.toMatchObject({ code: 'permission-denied' });
  });

  test('the tool refuses a household the person is not a member of, whatever it was handed', async () => {
    const ctx = {
      session: { email: MALLORY, link: () => 'https://example.test/' },
      here: { id: 'h1', name: 'Maple Street', members: [ALICE], joined: [ALICE], createdAt: 1, home: { ...HOME }, role: 'member', restricted: false },
      clock: new LocalClock('UTC', () => NOW),
      lang: 'en',
      touched: () => {},
    } as unknown as ToolContext;
    await expect(toolNamed('household_home')!.run(ctx, {})).rejects.toMatchObject({ key: 'error.noSuchHousehold' });
  });

  test('an approximate home says so, and a household without one says how to add it', async () => {
    const none = await call(mallory, 'household_home');
    expect(none.isError).toBe(false);
    expect(none.data.home).toBeNull();
    expect(none.text).toContain('No home is set yet');
    await owner.commit([{ path: 'households/h2', set: { name: 'Elsewhere', members: [MALLORY], joined: [MALLORY], createdAt: 1, home: { address: 'Riverside, Springfield, Illinois', lat: 39.78, lng: -89.65, approximate: true, setBy: MALLORY, updatedAt: NOW } } }]);
    const fresh = await connect(MALLORY);
    try {
      const r = await call(fresh, 'household_home');
      expect(r.data.home).toMatchObject({ address: 'Riverside, Springfield, Illinois', approximate: true, time_zone: null });
      expect(r.text).toContain('Approximate');
      expect(r.text).not.toContain('time zone');
    } finally {
      await fresh.close();
      await owner.commit([{ path: 'households/h2', set: { name: 'Elsewhere', members: [MALLORY], joined: [MALLORY], createdAt: 1 } }]);
    }
  });
});

describe('today', () => {
  test("an admin's day: the vet today, the bill coming up, the overdue tasks", async () => {
    const r = await call(alice, 'today');
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Today, Tuesday, January 7');
    expect(r.text).toContain('Vet: annual checkup');
    expect(r.text).toContain('2:00');
    expect(r.data.todos.map((t: { id: string }) => t.id).sort()).toEqual(['bills:bill:b1', 'tasks:item:t1']);
    expect(r.data.agenda.find((a: { app: string }) => a.app === 'pet').start).toBe('2031-01-07T14:00');
  });

  test('a helper never sees private items or money', async () => {
    const r = await call(helen, 'today');
    expect(r.isError).toBe(false);
    expect(r.text).not.toContain('Electric');
    expect(r.data.todos.map((t: { id: string }) => t.id)).toEqual(['tasks:item:t1']);
  });

  test("in the person's language from their profile (Bob reads Dutch)", async () => {
    const r = await call(bob, 'today');
    expect(r.text).toContain('Vandaag');
    expect((await call(bob, 'today', { lang: 'es' })).text).toContain('Hoy');
  });
});

describe('calendar', () => {
  test('days in a range, by day', async () => {
    const r = await call(alice, 'calendar', { from: '2031-01-07', to: '2031-01-12' });
    expect(r.data.days.map((d: { day: string }) => d.day)).toEqual(['2031-01-07', '2031-01-10']);
    expect((await call(alice, 'calendar', { from: '2031-01-07', to: '2031-06-12' })).isError).toBe(true);
  });
});

describe('todos', () => {
  test('filters and says who may act', async () => {
    const old = await call(carol, 'todos', { filter: 'older_than_30_days' });
    expect(old.data.todos).toEqual([expect.objectContaining({ id: 'tasks:item:t1', can_done: true, can_cancel: true })]);
    const k = await call(kim, 'todos');
    expect(k.data.todos).toEqual([expect.objectContaining({ id: 'tasks:item:t1', can_done: true, can_cancel: false })]);
  });

  test("todo_cancel is refused for a kid (the action names admins, members and the owner); todo_done runs the app's own write", async () => {
    const refused = await call(kim, 'todo_cancel', { id: 'tasks:item:t1' });
    expect(refused.isError).toBe(true);
    const done = await call(helen, 'todo_done', { id: 'tasks:item:t1' });
    expect(done.isError).toBe(false);
    expect(done.text).toContain('Clean the gutters');
    const item = await read('households/h1/items/t1');
    expect(item!.data).toMatchObject({ completed: true });
    expect(await read('households/h1/todos/tasks:item:t1')).toBeNull();
    expect((await call(helen, 'todo_done', { id: 'tasks:item:t1' })).text).toContain("isn't on the list");
  });

  test('a helper cannot mark a bill paid; an admin can', async () => {
    expect((await call(helen, 'todo_done', { id: 'bills:bill:b1' })).isError).toBe(true);
    const r = await call(alice, 'todo_done', { id: 'bills:bill:b1' });
    expect(r.isError).toBe(false);
    expect((await read('households/h1/bills/b1'))!.data).toMatchObject({ status: 'paid', paidBy: ALICE, paidVia: 'member' });
  });
});

describe('audit', () => {
  test("each call is in the connection's audit log, the connection recorded for its person only", async () => {
    await alice.settled();
    const conn = await read(`households/h1/connections/${alice.props.connectionId}`);
    expect(conn!.data).toMatchObject({ email: ALICE, client: 'Test assistant', by: ALICE });
    const { owner } = await import('../helpers');
    const audit = await owner.query(`households/h1/connections/${alice.props.connectionId}`, 'audit');
    expect(audit.map((a) => a.data.tool)).toContain('todo_done');
    expect(audit.find((a) => a.data.tool === 'todo_done')!.data).toMatchObject({ kind: 'write', ok: true, app: 'bills', ref: 'bill:b1' });
    expect(alice.logs.every((l) => !JSON.stringify(l).includes('@'))).toBe(true);
  });
});
