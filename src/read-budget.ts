import { DurableObject } from 'cloudflare:workers';
import type { ReadStore, ReadsUsed } from './reads';

/**
 * The day's Firestore reads, for every connection and for each (src/reads.ts): one instance,
 * SQLite-backed (the only kind on the free plan). A row per Pacific day and connection, `*` for all
 * of them; earlier days are dropped as a new one starts. Two requests per tool call (`used`, `add`),
 * within the free plan's 100,000 a day.
 */
export class ReadBudget extends DurableObject {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS reads (day TEXT NOT NULL, key TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, key))');
  }

  used(day: string, connection: string): ReadsUsed {
    const out: ReadsUsed = { connector: 0, connection: 0 };
    for (const row of this.sql.exec<{ key: string; n: number }>('SELECT key, n FROM reads WHERE day = ? AND key IN (?, ?)', day, '*', connection)) {
      if (row.key === '*') out.connector = row.n;
      else out.connection = row.n;
    }
    return out;
  }

  add(day: string, connection: string, reads: number): void {
    if (!(reads > 0)) return;
    this.sql.exec('DELETE FROM reads WHERE day < ?', day);
    for (const key of ['*', connection]) {
      this.sql.exec('INSERT INTO reads (day, key, n) VALUES (?, ?, ?) ON CONFLICT (day, key) DO UPDATE SET n = n + excluded.n', day, key, reads);
    }
  }
}

/** The ledger for `wrangler.toml`'s READ_BUDGET binding. */
export function durableStore(ns: DurableObjectNamespace<ReadBudget>): ReadStore {
  const stub = () => ns.get(ns.idFromName('reads'));
  return {
    used: async (day, connection) => stub().used(day, connection),
    add: async (day, connection, reads) => stub().add(day, connection, reads),
  };
}
