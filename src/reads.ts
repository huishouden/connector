import type { Fetch } from '@huishouden/pwa-kit/firestore-rest';

/**
 * Daily Firestore read budgets. The free plan's 50,000 reads a day are shared by every app and
 * Worker, and once they are used up every read fails until midnight Pacific (pwa-kit docs/one-site.md
 * "Budgets"). The connector has its own share (`FIRESTORE_CONNECTOR_READS`) and each connection a
 * share of that (`FIRESTORE_CONNECTION_READS`), counted per Pacific day in the ReadBudget Durable
 * Object. A tool call over either answers `firestore-quota`, as calendar's API does, and so does one
 * that meets Firestore's own daily quota.
 */

/** Which budget a refused call met: this connection's, all connections', or the project's own quota. */
export type QuotaScope = 'connection' | 'connector' | 'project';

export interface ReadLimits {
  /** Reads a day for every connection together (`FIRESTORE_CONNECTOR_READS`). */
  connector: number;
  /** Reads a day for one connection (`FIRESTORE_CONNECTION_READS`). */
  connection: number;
}

export interface ReadsUsed {
  connector: number;
  connection: number;
}

/** Where the day's reads are kept: the ReadBudget Durable Object, or memory in tests. */
export interface ReadStore {
  used(day: string, connection: string): Promise<ReadsUsed>;
  add(day: string, connection: string, reads: number): Promise<void>;
}

/** A budget from wrangler.toml [vars]: Infinity when unset or 0; a value that isn't a whole number throws. */
export function readLimit(name: string, value: string | undefined): number {
  if (value === undefined || value.trim() === '') return Infinity;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number of reads a day (wrangler.toml [vars]), not "${value}".`);
  return n === 0 ? Infinity : n;
}

export const readLimits = (env: { FIRESTORE_CONNECTOR_READS?: string; FIRESTORE_CONNECTION_READS?: string }): ReadLimits => ({
  connector: readLimit('FIRESTORE_CONNECTOR_READS', env.FIRESTORE_CONNECTOR_READS),
  connection: readLimit('FIRESTORE_CONNECTION_READS', env.FIRESTORE_CONNECTION_READS),
});

const PACIFIC = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });

/** The Pacific date `now` falls on (YYYY-MM-DD): Firestore's daily quotas reset at midnight Pacific. */
export const pacificDay = (now: number): string => PACIFIC.format(now);

/** The next midnight Pacific after `now`, in ms. */
export function nextPacificMidnight(now: number): number {
  const [y, m, d] = pacificDay(now).split('-').map(Number);
  const next = pacificDay(Date.UTC(y, m - 1, d + 1, 12));
  // Midnight Pacific is 07:00 or 08:00 UTC, by daylight saving time.
  for (const hour of [7, 8]) {
    const at = Date.UTC(y, m - 1, d + 1, hour);
    if (pacificDay(at) === next && pacificDay(at - 1) !== next) return at;
  }
  return Date.UTC(y, m - 1, d + 1, 8);
}

type Row = { document?: unknown; result?: { aggregateFields?: Record<string, { integerValue?: string }> }; found?: unknown; missing?: unknown };

/**
 * Reads Firestore bills for one REST response, as docs/one-site.md "Budgets" counts them: one per
 * document a `get`, query or `batchGet` returns (a `get` of a missing document too), at least one per
 * query and per aggregation, and one per 1,000 index entries an aggregation walks. Writes are 0.
 */
export function billedReads(method: string, url: string, status: number, body: unknown): number {
  const path = url.split('?')[0];
  if (path.endsWith(':commit') || path.endsWith(':beginTransaction') || path.endsWith(':rollback')) return 0;
  if (status === 429) return 0;
  const rows = Array.isArray(body) ? (body as Row[]) : [];
  if (path.endsWith(':runQuery')) return Math.max(1, rows.filter((r) => r.document).length);
  if (path.endsWith(':runAggregationQuery')) {
    const n = Number(rows.find((r) => r.result)?.result?.aggregateFields?.n?.integerValue ?? 0);
    return Math.max(1, Math.ceil(n / 1000));
  }
  if (path.endsWith(':batchGet')) return rows.filter((r) => r.found || r.missing).length;
  if (method === 'GET') {
    const listed = (body as { documents?: unknown[] } | null)?.documents;
    return Array.isArray(listed) ? Math.max(1, listed.length) : status === 200 || status === 404 ? 1 : 0;
  }
  return 0;
}

const isRead = (method: string, url: string): boolean => {
  const path = url.split('?')[0];
  return method === 'GET' || path.endsWith(':runQuery') || path.endsWith(':runAggregationQuery') || path.endsWith(':batchGet');
};

/** What Firestore answers at its daily quota; the meter answers the same when a budget is used up. */
const exhausted = () =>
  new Response(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Daily read budget used up' } }), { status: 429, headers: { 'Content-Type': 'application/json' } });

/**
 * One request's reads against the day's budgets. `begin` before each tool call says whether it may
 * start; the meter's `fetch` (FirestoreRest's) counts each response and, once a budget is reached
 * mid-call, answers further reads as Firestore does at its quota; `finish` adds the call's reads to
 * the day. Reads a call makes at once all go out before any is counted, and calls running at once
 * can each pass `begin`, so the day may end up over by those reads.
 */
export class ReadMeter {
  private used: ReadsUsed = { connector: 0, connection: 0 };
  private day = '';
  /** Reads in the current call. */
  reads = 0;
  /** The budget the current call met, if it met one. */
  refused: QuotaScope | null = null;
  /** The current call committed a write. */
  wrote = false;

  constructor(
    private readonly store: ReadStore | null,
    private readonly limits: ReadLimits,
    private readonly connection: string,
    readonly now: () => number = Date.now,
    private readonly onStoreError: (e: unknown) => void = () => {},
  ) {}

  private over(extra: number): QuotaScope | null {
    if (this.used.connection + extra >= this.limits.connection) return 'connection';
    if (this.used.connector + extra >= this.limits.connector) return 'connector';
    return null;
  }

  /** Loads the day's reads and says which budget is already used up (null: the call may start). */
  async begin(): Promise<QuotaScope | null> {
    this.reads = 0;
    this.refused = null;
    this.wrote = false;
    this.day = pacificDay(this.now());
    if (this.store) {
      try {
        this.used = await this.store.used(this.day, this.connection);
      } catch (e) {
        // The ledger unreachable: go ahead uncounted rather than stop every assistant; Firestore's
        // own quota still stands behind it.
        this.used = { connector: 0, connection: 0 };
        this.onStoreError(e);
      }
    }
    this.refused = this.over(0);
    return this.refused;
  }

  /** Adds the call's reads to the day. */
  async finish(): Promise<void> {
    if (!this.store || this.reads === 0) return;
    const reads = this.reads;
    this.used = { connector: this.used.connector + reads, connection: this.used.connection + reads };
    this.reads = 0;
    await this.store.add(this.day, this.connection, reads).catch(this.onStoreError);
  }

  /** `inner` metered: reads counted, and refused once a budget is reached. */
  fetch(inner: Fetch): Fetch {
    return async (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (!isRead(method, url)) {
        // A call that met a budget may have built its write from a refused read (a source record's
        // `private`, an audience): nothing of it is written after that.
        if (this.refused && url.split('?')[0].endsWith(':commit')) return exhausted();
        const res = await inner(url, init);
        if (res.ok && url.split('?')[0].endsWith(':commit')) this.wrote = true;
        return res;
      }
      const over = this.over(this.reads);
      if (over) {
        this.refused ??= over;
        return exhausted();
      }
      const res = await inner(url, init);
      if (res.status === 429) this.refused ??= 'project';
      const body = res.ok ? await res.clone().json().catch(() => null) : null;
      this.reads += billedReads(method, url, res.status, body);
      return res;
    };
  }
}
