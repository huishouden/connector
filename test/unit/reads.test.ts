import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FirestoreError, FirestoreRest } from '@huishouden/pwa-kit/firestore-rest';
import { billedReads, memoryStore, nextPacificMidnight, pacificDay, ReadMeter, readLimit, readLimits, type ReadStore } from '../../src/reads';
import { overQuota, quotaResult } from '../../src/mcp';

const ROOT = 'https://firestore.example/v1/projects/p/databases/(default)/documents';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('budgets from wrangler.toml', () => {
  test('a whole number; unset, empty or 0 is no limit; anything else is refused by name', () => {
    expect(readLimit('X', '5000')).toBe(5000);
    expect(readLimit('X', undefined)).toBe(Infinity);
    expect(readLimit('X', '')).toBe(Infinity);
    expect(readLimit('X', '0')).toBe(Infinity);
    for (const bad of ['-1', '1.5', 'lots']) expect(() => readLimit('FIRESTORE_CONNECTOR_READS', bad)).toThrow(/FIRESTORE_CONNECTOR_READS must be a whole number/);
  });

  test("wrangler.toml's production and staging budgets are valid, and a connection's is under the connector's", () => {
    const toml = readFileSync(resolve(import.meta.dir, '../../wrangler.toml'), 'utf8');
    const values = (name: string) => [...toml.matchAll(new RegExp(`^${name} = "([^"]*)"`, 'gm'))].map((m) => m[1]);
    for (const name of ['FIRESTORE_CONNECTOR_READS', 'FIRESTORE_CONNECTION_READS']) expect(values(name)).toHaveLength(2);
    values('FIRESTORE_CONNECTOR_READS').forEach((connector, i) => {
      const limits = readLimits({ FIRESTORE_CONNECTOR_READS: connector, FIRESTORE_CONNECTION_READS: values('FIRESTORE_CONNECTION_READS')[i] });
      expect(limits.connector).toBeLessThan(50_000);
      expect(limits.connection).toBeLessThan(limits.connector);
    });
  });
});

describe('the Pacific day', () => {
  test('the date in Los Angeles, which is when Firestore resets', () => {
    expect(pacificDay(Date.UTC(2031, 0, 7, 7, 59))).toBe('2031-01-06');
    expect(pacificDay(Date.UTC(2031, 0, 7, 8, 0))).toBe('2031-01-07');
    expect(pacificDay(Date.UTC(2031, 6, 7, 6, 59))).toBe('2031-07-06');
    expect(pacificDay(Date.UTC(2031, 6, 7, 7, 0))).toBe('2031-07-07');
  });

  test('the next midnight, in winter, summer and either side of the clock change', () => {
    expect(nextPacificMidnight(Date.UTC(2031, 0, 7, 15))).toBe(Date.UTC(2031, 0, 8, 8));
    expect(nextPacificMidnight(Date.UTC(2031, 6, 7, 15))).toBe(Date.UTC(2031, 6, 8, 7));
    // 2031: daylight time starts Sunday 9 March, ends Sunday 2 November.
    expect(nextPacificMidnight(Date.UTC(2031, 2, 8, 20))).toBe(Date.UTC(2031, 2, 9, 8));
    expect(nextPacificMidnight(Date.UTC(2031, 2, 9, 20))).toBe(Date.UTC(2031, 2, 10, 7));
    expect(nextPacificMidnight(Date.UTC(2031, 10, 1, 20))).toBe(Date.UTC(2031, 10, 2, 7));
    expect(nextPacificMidnight(Date.UTC(2031, 10, 2, 20))).toBe(Date.UTC(2031, 10, 3, 8));
  });
});

describe('billed reads', () => {
  test('a get is one, a missing document too', () => {
    expect(billedReads('GET', `${ROOT}/households/h`, 200, { name: 'x' })).toBe(1);
    expect(billedReads('GET', `${ROOT}/households/h`, 404, null)).toBe(1);
    expect(billedReads('GET', `${ROOT}/households/h`, 403, null)).toBe(0);
  });

  test('a query is one per document, at least one', () => {
    expect(billedReads('POST', `${ROOT}/households/h:runQuery`, 200, [{ document: {} }, { document: {} }, { readTime: 'x' }])).toBe(2);
    expect(billedReads('POST', `${ROOT}:runQuery`, 200, [{ readTime: 'x' }])).toBe(1);
  });

  test('an aggregation is one per 1,000 entries, at least one', () => {
    const agg = (n: number) => [{ result: { aggregateFields: { n: { integerValue: String(n) } } } }];
    expect(billedReads('POST', `${ROOT}/h:runAggregationQuery`, 200, agg(0))).toBe(1);
    expect(billedReads('POST', `${ROOT}/h:runAggregationQuery`, 200, agg(2500))).toBe(3);
  });

  test('a batchGet is one per document asked for; a listing one per document; writes and refusals none', () => {
    expect(billedReads('POST', `${ROOT}:batchGet`, 200, [{ found: {} }, { missing: 'x' }, { transaction: 't' }])).toBe(2);
    expect(billedReads('GET', `${ROOT}/households/h/items?pageSize=50`, 200, { documents: [{}, {}, {}] })).toBe(3);
    expect(billedReads('POST', `${ROOT}:commit`, 200, {})).toBe(0);
    expect(billedReads('POST', `${ROOT}/h:runQuery`, 429, null)).toBe(0);
  });
});

/** A Firestore stand-in: every query answers `docs` documents; commits succeed. */
function firestore(docs: number, { status = 200 } = {}) {
  const calls: string[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (status !== 200) return json([{ error: { code: status, status: 'RESOURCE_EXHAUSTED', message: 'quota' } }], status);
    if (url.endsWith(':commit')) return json({ writeResults: [] });
    if ((init?.method ?? 'GET') === 'GET') return json({ name: url.replace('https://firestore.example/v1/', ''), fields: {} });
    return json([...Array(docs)].map((_, i) => ({ document: { name: `${ROOT}/x/${i}`, fields: {} } })));
  };
  return { calls, fetch };
}

const NOW = Date.UTC(2031, 0, 7, 15);
const DAY = pacificDay(NOW);

async function meterWith(used: { connector?: number; connection?: number }, limits: { connector: number; connection: number }, store = memoryStore()) {
  if (used.connector) await store.add(DAY, 'other', used.connector - (used.connection ?? 0));
  if (used.connection) await store.add(DAY, 'c1', used.connection);
  return { store, meter: new ReadMeter(store, limits, 'c1', () => NOW) };
}

describe('the meter', () => {
  test('counts a call and adds it to the day, for the connection and for all', async () => {
    const { store, meter } = await meterWith({}, { connector: 100, connection: 50 });
    const fs = firestore(3);
    const db = new FirestoreRest({ projectId: 'p', token: async () => 't', baseUrl: 'https://firestore.example/v1', fetch: meter.fetch(fs.fetch) });
    expect(await meter.begin()).toBeNull();
    await db.query('households/h', 'todos');
    await db.get('households/h');
    await db.commit([{ path: 'households/h/todos/a', set: { title: 'x' } }]);
    expect(meter.reads).toBe(4);
    expect(meter.wrote).toBe(true);
    await meter.finish();
    expect(await store.used(DAY, 'c1')).toEqual({ connector: 4, connection: 4 });
    expect(await store.used(DAY, 'c2')).toEqual({ connector: 4, connection: 0 });
  });

  test("refuses to start at the connection's budget, then at the connector's", async () => {
    expect(await (await meterWith({ connector: 50, connection: 50 }, { connector: 100, connection: 50 })).meter.begin()).toBe('connection');
    expect(await (await meterWith({ connector: 100, connection: 10 }, { connector: 100, connection: 50 })).meter.begin()).toBe('connector');
    expect(await (await meterWith({ connector: 99, connection: 49 }, { connector: 100, connection: 50 })).meter.begin()).toBeNull();
  });

  test('met mid-call: later reads are refused as Firestore refuses at its quota, writes still go', async () => {
    const { store, meter } = await meterWith({ connector: 40, connection: 40 }, { connector: 100, connection: 50 });
    const fs = firestore(8);
    const db = new FirestoreRest({ projectId: 'p', token: async () => 't', baseUrl: 'https://firestore.example/v1', fetch: meter.fetch(fs.fetch) });
    expect(await meter.begin()).toBeNull();
    await db.query('households/h', 'todos');
    await db.query('households/h', 'todos');
    const refused = await db.query('households/h', 'todos').catch((e: unknown) => e);
    expect(overQuota(refused)).toBe(true);
    expect(fs.calls).toHaveLength(2);
    expect(meter.refused).toBe('connection');
    await db.commit([{ path: 'households/h/todos/a', set: { title: 'x' } }]);
    expect(fs.calls).toHaveLength(3);
    await meter.finish();
    expect((await store.used(DAY, 'c1')).connection).toBe(56);
  });

  test("Firestore's own quota is the project's", async () => {
    const { meter } = await meterWith({}, { connector: Infinity, connection: Infinity });
    const db = new FirestoreRest({ projectId: 'p', token: async () => 't', baseUrl: 'https://firestore.example/v1', fetch: meter.fetch(firestore(1, { status: 429 }).fetch) });
    await meter.begin();
    const e = await db.get('households/h').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(FirestoreError);
    expect(overQuota(e)).toBe(true);
    expect(meter.refused).toBe('project');
    expect(meter.reads).toBe(0);
  });

  test('an earlier day is forgotten; a new day starts at nothing', async () => {
    const store = memoryStore();
    await store.add('2031-01-06', 'c1', 50);
    await store.add(DAY, 'c1', 1);
    expect([...store.days.keys()]).toEqual([DAY]);
    expect(await new ReadMeter(store, { connector: 100, connection: 50 }, 'c1', () => NOW).begin()).toBeNull();
  });

  test('the ledger unreachable: the call goes ahead, and the failure is reported', async () => {
    const broken: ReadStore = { used: async () => Promise.reject(new Error('down')), add: async () => Promise.reject(new Error('down')) };
    const errors: unknown[] = [];
    const meter = new ReadMeter(broken, { connector: 10, connection: 5 }, 'c1', () => NOW, (e) => errors.push(e));
    expect(await meter.begin()).toBeNull();
    meter.reads = 3;
    await meter.finish();
    expect(errors).toHaveLength(2);
  });
});

describe('the answer', () => {
  test('`firestore-quota`, which budget, when it resets, in the person\'s language', async () => {
    const en = await quotaResult('connection', 'en', NOW);
    expect(en).toMatchObject({ error: true, data: { error: 'firestore-quota', scope: 'connection', resetsAt: '2031-01-08T08:00:00.000Z' } });
    expect(en.text).toContain('midnight Pacific');
    expect((await quotaResult('connector', 'nl', NOW)).text).toContain('middernacht');
    expect((await quotaResult('project', 'es', NOW)).text).toContain('medianoche');
  });
});
