import { DurableObject } from 'cloudflare:workers';
import { readLedgerObject, type ReadLedger } from '@huishouden/pwa-kit/read-budget';

/**
 * The day's Firestore reads, for every connection (`*`) and for each, and the quota pause
 * (src/reads.ts): one instance of the kit's ledger, SQLite-backed (the only kind on the free plan).
 * A row per Pacific day and key; earlier days are dropped as a new one starts. Two requests per tool
 * call (read, add), within the free plan's 100,000 a day.
 */
export class ReadBudget extends readLedgerObject(DurableObject) {}

/** The ledger for `wrangler.toml`'s READ_BUDGET binding. */
export function durableStore(ns: DurableObjectNamespace<ReadBudget>): ReadLedger {
  const stub = () => ns.get(ns.idFromName('reads'));
  return {
    read: async (day, keys) => stub().read(day, keys),
    add: async (day, keys, reads) => stub().add(day, keys, reads),
    pause: async (until) => stub().pause(until),
  };
}
