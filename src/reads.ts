import type { Fetch } from '@huishouden/pwa-kit/firestore-rest';
import { readCap, ReadBudget, untilNextQuotaDay, type ReadLedger } from '@huishouden/pwa-kit/read-budget';

export { billedReads, quotaDay as pacificDay } from '@huishouden/pwa-kit/read-budget';

/**
 * Firestore read budgets, on the kit's `ReadBudget` (pwa-kit STANDARD.md "Read budgets"). The free
 * plan's 50,000 reads a day are shared by every app and Worker, and once they are used up every read
 * fails until midnight Pacific. The connector has its own share (`FIRESTORE_CONNECTOR_READS`), each
 * connection a share of that (`FIRESTORE_CONNECTION_READS`), counted per Pacific day in the
 * ReadBudget Durable Object (src/read-budget.ts), and each tool call a cap (CALL_READS). A tool call
 * over any of them answers `firestore-quota`, as calendar's API does, and so does one that meets
 * Firestore's own daily quota, which also pauses every call for 15 minutes.
 */

/** Which budget a refused call met: this call's, this connection's, all connections', or the project's own quota. */
export type QuotaScope = 'call' | 'connection' | 'connector' | 'project';

/** Firestore reads one tool call may be billed for: a month of Spending's transactions with room to spare. */
export const CALL_READS = 500;

export interface ReadLimits {
  /** Reads a day for every connection together (`FIRESTORE_CONNECTOR_READS`). */
  connector: number;
  /** Reads a day for one connection (`FIRESTORE_CONNECTION_READS`). */
  connection: number;
}

/** A budget from wrangler.toml [vars]: Infinity when unset or 0; a value that isn't a whole number throws. */
export const readLimit = readCap;

export const readLimits = (env: { FIRESTORE_CONNECTOR_READS?: string; FIRESTORE_CONNECTION_READS?: string }): ReadLimits => ({
  connector: readLimit('FIRESTORE_CONNECTOR_READS', env.FIRESTORE_CONNECTOR_READS),
  connection: readLimit('FIRESTORE_CONNECTION_READS', env.FIRESTORE_CONNECTION_READS),
});

/** The next midnight Pacific after `now`, in ms. */
export const nextPacificMidnight = (now: number): number => now + untilNextQuotaDay(now);

/**
 * A budget's refusal as the answer's scope: the kit's `run` is this call's cap, a pause or Firestore's
 * own refusal the project's quota, and the two daily shares by their names (`fresh`). Anything else
 * (a refusal a later kit adds) answers as the project's quota, never as a scope `quotaResult` has no
 * words for.
 */
export function scopeOf(refused: string): QuotaScope {
  switch (refused) {
    case 'run':
      return 'call';
    case 'connection':
    case 'connector':
      return refused;
    default:
      return 'project';
  }
}

/**
 * One request's tool calls against the budgets, a fresh kit `ReadBudget` per call. `begin` before
 * each call says whether it may start; `fetch` (FirestoreRest's) counts each response and, once a
 * budget is reached mid-call, answers further reads (and writes) as Firestore does at its quota;
 * `finish` adds the call's reads to the day. Calls running at once can each pass `begin`, so the day
 * may end up over by those reads.
 */
export class ReadMeter {
  private budget: ReadBudget;
  /** The current call committed a write. */
  wrote = false;

  constructor(
    private readonly ledger: ReadLedger | null,
    private readonly limits: ReadLimits,
    private readonly connection: string,
    readonly now: () => number = Date.now,
    private readonly onLedgerError: (e: unknown) => void = () => {},
  ) {
    this.budget = this.fresh();
  }

  private fresh(): ReadBudget {
    return new ReadBudget({
      run: CALL_READS,
      daily: [
        { name: 'connection', key: this.connection, cap: this.limits.connection },
        { name: 'connector', key: '*', cap: this.limits.connector },
      ],
      ledger: this.ledger,
      now: this.now,
      onLedgerError: this.onLedgerError,
    });
  }

  /** Reads in the current call. */
  get reads(): number {
    return this.budget.reads;
  }

  /** A refusal a subclass reports itself (a test standing in for a budget met at a chosen moment). */
  private met: QuotaScope | null = null;

  /** The budget the current call met, if it met one. */
  get refused(): QuotaScope | null {
    return this.met ?? (this.budget.refused ? scopeOf(this.budget.refused) : null);
  }

  protected set refused(scope: QuotaScope | null) {
    this.met = scope;
  }

  /** Starts a call: loads the day's reads and says which budget is already used up (null: the call may start). */
  async begin(): Promise<QuotaScope | null> {
    this.budget = this.fresh();
    this.wrote = false;
    this.met = null;
    const gate = await this.budget.begin();
    return gate ? scopeOf(gate.scope) : null;
  }

  /** Adds the call's reads to the day. */
  finish(): Promise<void> {
    return this.budget.finish();
  }

  /** `inner` metered: reads counted, and refused once a budget is reached. */
  fetch(inner: Fetch): Fetch {
    return async (url, init) => {
      const res = await this.budget.fetch(inner)(url, init);
      if (res.ok && url.split('?')[0].endsWith(':commit')) this.wrote = true;
      return res;
    };
  }
}
