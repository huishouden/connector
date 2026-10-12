import { memoryLedger, type ReadLedger } from '@huishouden/pwa-kit/read-budget';

/**
 * The day's reads in memory, for tests: the ReadBudget Durable Object's ledger (the kit's), without
 * it. `addFor` and `used` speak of one connection and all of them (`*`), as the meter counts.
 */
export function memoryStore(): ReadLedger & {
  days: Set<string>;
  used(day: string, connection: string): Promise<{ connector: number; connection: number }>;
  addFor(day: string, connection: string, reads: number): Promise<void>;
} {
  const ledger = memoryLedger();
  const days = new Set<string>();
  return {
    days,
    read: ledger.read,
    pause: ledger.pause,
    async add(day, keys, reads) {
      // As the Durable Object does: an earlier day goes when a new one is added to.
      for (const d of [...days]) if (d < day) {
        days.delete(d);
        for (const k of [...ledger.counts.keys()]) if (k.startsWith(`${d}|`)) ledger.counts.delete(k);
      }
      days.add(day);
      await ledger.add(day, keys, reads);
    },
    async used(day, connection) {
      const { used } = await ledger.read(day, ['*', connection]);
      return { connector: used['*'], connection: used[connection] };
    },
    async addFor(day, connection, reads) {
      await this.add(day, ['*', connection], reads);
    },
  };
}
