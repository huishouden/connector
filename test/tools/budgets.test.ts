import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { TOOLS } from '@huishouden/pwa-kit/household-tools';
import { expectReads } from '@huishouden/pwa-kit/read-test';
import { ALICE } from '../fixtures/household';
import { call, connect, seed, type Connected } from '../helpers';

// Read budgets (pwa-kit STANDARD.md "Read budgets"): what each read tool is billed for on the
// fixture household (invented), from a fresh connection (its first call also finds the household).
// A new read tool fails here until it has a budget; a change that raises one says why in its PR.
const BUDGETS: Record<string, number> = {
  households: 2,
  household_home: 2,
  today: 8,
  calendar: 5,
  todos: 5,
  groceries_list: 7,
  bills_due: 3,
  pet_today: 11,
  pet_routines: 5,
  home_upkeep_due: 4,
  baby_settings: 4,
  contacts_search: 6,
  health_people: 10,
  health_medicines: 10,
  health_history: 12,
  health_due: 12,
  health_doctor_list: 11,
  health_appointments: 9,
  health_conditions: 9,
};
const ARGS: Record<string, Record<string, unknown>> = { contacts_search: { query: 'a' }, health_medicines: { person: 'Nan' }, health_history: { person: 'Nan' }, health_doctor_list: { person: 'Nan' } };

const opened: Connected[] = [];
beforeAll(async () => {
  await seed();
});
afterAll(async () => {
  for (const c of opened) await c.close();
});

describe('each read tool within its budget', () => {
  test('every read tool has a budget', () => {
    expect(TOOLS.filter((t) => t.kind === 'read').map((t) => t.name).sort()).toEqual(Object.keys(BUDGETS).sort());
  });

  for (const [name, max] of Object.entries(BUDGETS)) {
    test(name, async () => {
      await expectReads(
        async (meter) => {
          const c = await connect(ALICE, { fetch: meter });
          opened.push(c);
          const r = await call(c, name, ARGS[name] ?? {});
          expect(r.isError).toBe(false);
        },
        { max, label: name },
      );
    });
  }
});

// Write tools that find an item first: what finding it is billed for. By name, the open items on the
// shopping lists only, not Tasks' to-dos (an id costs one read; the kit's own test counts that).
// A miss reads no more than a hit, and a name that is only one of Tasks' to-dos isn't found.
const FINDING: [string, Record<string, unknown>, number, 'found' | 'missing'][] = [
  ['groceries_update', { item: 'Milk', need_by: '2031-01-09' }, 6, 'found'],
  ['groceries_check', { item: 'Milk' }, 6, 'found'],
  ['groceries_check', { item: 'Saffron' }, 6, 'missing'],
  ['groceries_check', { item: 'Clean the gutters' }, 6, 'missing'],
];

describe('write tools that find an item, within their budget', () => {
  for (const [name, args, max, outcome] of FINDING) {
    test(`${name} ${JSON.stringify(args)}`, async () => {
      await expectReads(
        async (meter) => {
          const c = await connect(ALICE, { fetch: meter });
          opened.push(c);
          const r = await call(c, name, args);
          expect(r.isError).toBe(outcome === 'missing');
        },
        { max, label: name },
      );
    });
  }
});
