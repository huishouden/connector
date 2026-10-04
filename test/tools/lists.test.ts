import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ALICE, HELEN, KIM, NOW } from '../fixtures/household';
import { call, connect, owner, read, seed, type Connected } from '../helpers';

let alice: Connected, helen: Connected, kim: Connected;
beforeAll(async () => {
  await seed();
  [alice, helen, kim] = await Promise.all([ALICE, HELEN, KIM].map((e) => connect(e)));
});
afterAll(async () => {
  for (const c of [alice, helen, kim]) await c.close();
});

describe('groceries', () => {
  test('groceries_list shows what is not bought, by list', async () => {
    const r = await call(alice, 'groceries_list');
    expect(r.data.lists.map((l: { id: string }) => l.id)).toEqual(['groceries', 'costco']);
    expect(r.data.lists[0].items).toEqual([expect.objectContaining({ id: 'milk', name: 'Milk', category: 'Dairy & Eggs' })]);
    expect(r.text).not.toContain('gutters');
  });

  test("groceries_add writes the Groceries app's shape, as the person, once per idempotency key", async () => {
    const args = { name: 'Oat milk', quantity: '2', category: 'Dairy & Eggs', urgency: 'Need Today', idempotency_key: 'oat-1' };
    const r = await call(helen, 'groceries_add', args);
    expect(r.isError).toBe(false);
    const item = await read(`households/h1/items/${r.data.id}`);
    expect(item!.data).toEqual({
      listId: 'groceries', name: 'Oat milk', category: 'Dairy & Eggs', quantity: '2', notes: '', addedBy: 'Helen', by: HELEN, completed: false, urgency: 'Need Today', position: -NOW, createdAt: NOW, updatedAt: NOW, completedAt: null, via: 'assistant',
    });
    expect((await read('households/h1/staples/oat milk'))!.data).toMatchObject({ displayName: 'Oat milk', timesAdded: 1 });
    const again = await call(helen, 'groceries_add', args);
    expect(again.data).toMatchObject({ id: r.data.id, repeated: true });
    expect((await read('households/h1/staples/oat milk'))!.data.timesAdded).toBe(1);
    expect((await call(alice, 'groceries_add', { name: 'Paper towels', list: 'costco' })).data.list).toBe('costco');
    expect((await call(alice, 'groceries_add', { name: 'X', list: 'Nowhere' })).isError).toBe(true);
  });

  test('groceries_check ticks it off by name; a kid may tick', async () => {
    const r = await call(kim, 'groceries_check', { item: 'milk' });
    expect(r.isError).toBe(false);
    expect((await read('households/h1/items/milk'))!.data).toMatchObject({ completed: true, completedAt: NOW });
    expect((await call(kim, 'groceries_check', { item: 'milk', bought: false })).isError).toBe(false);
    expect((await read('households/h1/items/milk'))!.data).toMatchObject({ completed: false, completedAt: null });
  });
});

describe('tasks', () => {
  test("tasks_add with a due time lands on the chores list with the Tasks app's due fields", async () => {
    const r = await call(kim, 'tasks_add', { name: 'Feed the fish', due: '2031-01-08T17:00', by: true });
    expect(r.isError).toBe(false);
    const item = await read(`households/h1/items/${r.data.id}`);
    expect(item!.data).toMatchObject({ listId: 'chores', category: 'Chores & Tasks', by: 'kim@example.com', dueAt: Date.parse('2031-01-08T17:00:00-05:00'), allDay: false, dueBy: true, via: 'assistant' });
    const day = await call(alice, 'tasks_add', { name: 'Renew passport', due: '2031-02-01' });
    expect((await read(`households/h1/items/${day.data.id}`))!.data).toMatchObject({ dueAt: Date.parse('2031-02-01T00:00:00-05:00'), allDay: true });
    expect((await call(alice, 'tasks_add', { name: 'Bad', due: 'next week' })).isError).toBe(true);
  });
});

describe('bills', () => {
  test('admins and members see open bills; helpers are told bills are not for them', async () => {
    const r = await call(alice, 'bills_due');
    expect(r.data.bills).toEqual([expect.objectContaining({ id: 'b1', label: 'Electric', due: '2031-01-10', state: 'attention', amount: { amount: '84.20', currency: 'USD' } })]);
    expect(r.text).toContain('$84.20');
    const h = await call(helen, 'bills_due');
    expect(h.isError).toBe(true);
    expect(h.text).toContain('admins and members');
    void owner;
  });
});
