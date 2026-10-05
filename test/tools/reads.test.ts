import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ALICE, NOW } from '../fixtures/household';
import { call, connect, read, seed, type Connected } from '../helpers';
import { memoryStore, pacificDay, ReadMeter, type ReadLimits } from '../../src/reads';

// The read budgets with the real tools, against the emulator: what a call costs, a call refused at
// the start, one cut off mid-way, and a write that went through before its budget ran out.
const DAY = pacificDay(NOW);
const opened: Connected[] = [];

async function connectWith(limits: ReadLimits, used: { connection?: number; connector?: number } = {}) {
  const store = memoryStore();
  if (used.connector) await store.add(DAY, 'others', used.connector);
  if (used.connection) await store.add(DAY, `test${ALICE.split('@')[0]}`, used.connection);
  const meter = new ReadMeter(store, limits, `test${ALICE.split('@')[0]}`, () => NOW);
  const c = await connect(ALICE, { reads: meter });
  opened.push(c);
  return { c, meter, store };
}

beforeAll(async () => {
  await seed();
});
afterAll(async () => {
  for (const c of opened) await c.close();
});

describe('read budgets with the tools', () => {
  test('every call is counted and logged with its reads; the day adds them up', async () => {
    const { c, store } = await connectWith({ connector: Infinity, connection: Infinity });
    for (const name of ['today', 'calendar', 'todos', 'groceries_list', 'bills_due', 'household_home']) {
      const r = await call(c, name);
      expect([name, r.isError]).toEqual([name, false]);
    }
    const reads = c.logs.map((l) => l.reads!);
    // household_home reads nothing here: this test's session already holds the household.
    expect(reads.slice(0, 5).every((n) => n > 0)).toBe(true);
    expect((await store.used(DAY, 'x')).connector).toBe(reads.reduce((a, b) => a + b, 0));
  });

  test("at the connection's budget: firestore-quota, no Firestore request, nothing else said", async () => {
    const { c, meter } = await connectWith({ connector: 5000, connection: 100 }, { connection: 100 });
    const r = await call(c, 'today');
    expect(r.isError).toBe(true);
    expect(r.data).toMatchObject({ error: 'firestore-quota', scope: 'connection' });
    expect(r.data.resetsAt).toBe(new Date(Date.UTC(2031, 0, 8, 8)).toISOString());
    expect(r.text).toContain('midnight Pacific');
    expect(meter.reads).toBe(0);
    expect(c.logs.at(-1)).toMatchObject({ tool: 'today', ok: false, error: 'firestore-quota', reads: 0 });
  });

  test("at all connections' budget, in the grant's language", async () => {
    const store = memoryStore();
    await store.add(DAY, 'others', 5000);
    const meter = new ReadMeter(store, { connector: 5000, connection: 1000 }, `test${ALICE.split('@')[0]}`, () => NOW);
    const c = await connect(ALICE, { reads: meter, lang: 'nl' });
    opened.push(c);
    const r = await call(c, 'groceries_list');
    expect(r.data).toMatchObject({ error: 'firestore-quota', scope: 'connector' });
    expect(r.text).toContain('middernacht');
  });

  test('met mid-call: the answer is the quota, never a partial list', async () => {
    // One read left: the call's first read goes, the rest are refused.
    const { c, meter } = await connectWith({ connector: 5000, connection: 1 });
    const r = await call(c, 'today');
    expect(r.data).toMatchObject({ error: 'firestore-quota', scope: 'connection' });
    expect(meter.refused).toBe('connection');
  });

  test('a write that was saved before its budget ran out keeps its own answer', async () => {
    // The budget met right after the commit, as when a tool reads again after writing.
    class MetAfterCommit extends ReadMeter {
      override fetch(inner: Parameters<ReadMeter['fetch']>[0]) {
        const metered = super.fetch(inner);
        return async (url: string, init?: RequestInit) => {
          const res = await metered(url, init);
          if (url.endsWith(':commit')) this.refused = 'connection';
          return res;
        };
      }
    }
    const meter = new MetAfterCommit(memoryStore(), { connector: 5000, connection: 1000 }, `test${ALICE.split('@')[0]}`, () => NOW);
    const c = await connect(ALICE, { reads: meter });
    opened.push(c);
    const r = await call(c, 'groceries_add', { name: 'Oat milk', idempotency_key: 'reads-oat' });
    expect(meter.wrote).toBe(true);
    expect(r.isError).toBe(false);
    expect(await read(`households/h1/items/${r.data.id}`)).not.toBeNull();
    expect(c.logs.at(-1)).toMatchObject({ ok: true, error: 'firestore-quota' });
  });

  test('a budget met before the write: nothing is written', async () => {
    const { c, meter } = await connectWith({ connector: 5000, connection: 1 });
    const r = await call(c, 'groceries_add', { name: 'Paper towels', idempotency_key: 'reads-towels' });
    expect(r.data).toMatchObject({ error: 'firestore-quota', scope: 'connection' });
    expect(meter.wrote).toBe(false);
  });
});
