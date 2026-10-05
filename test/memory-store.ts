import type { ReadStore } from '../src/reads';

/** The day's reads in memory, for tests: the ReadBudget Durable Object's behaviour, without it. */
export function memoryStore(): ReadStore & { days: Map<string, Map<string, number>> } {
  const days = new Map<string, Map<string, number>>();
  const of = (day: string) => days.get(day) ?? days.set(day, new Map()).get(day)!;
  return {
    days,
    async used(day, connection) {
      const d = of(day);
      return { connector: d.get('*') ?? 0, connection: d.get(connection) ?? 0 };
    },
    async add(day, connection, reads) {
      for (const k of [...days.keys()]) if (k < day) days.delete(k);
      const d = of(day);
      d.set('*', (d.get('*') ?? 0) + reads);
      d.set(connection, (d.get(connection) ?? 0) + reads);
    },
  };
}
