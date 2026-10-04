import { toAgendaItem, agendaWords, type AgendaItem } from '@huishouden/pwa-kit/agenda-core';
import { PERSONAL_TODOS, toTodoItem, todoWords, type TodoItem } from '@huishouden/pwa-kit/todo-core';
import { PERSONAL_AGENDA } from '@huishouden/pwa-kit/agenda-core';
import type { LocalClock } from '@huishouden/pwa-kit/local-clock';
import type { Here, Session } from '../context';
import { FirestoreError } from '@huishouden/pwa-kit/firestore-rest';

/** Collections the person may lack rules for (the personal lists, before they existed): an empty list then. */
async function orEmpty<T>(p: Promise<T[]>): Promise<T[]> {
  return p.catch((e) => {
    if (e instanceof FirestoreError && e.code === 'permission-denied') return [];
    throw e;
  });
}

/**
 * The household's agenda as the portal shows it to this person (shared items they may read and the
 * personal ones naming them), in the local frame (`../clock`): `start` and `end` moved so the kit's
 * day logic reads the person's calendar.
 */
export async function loadAgenda(session: Session, here: Here, clock: LocalClock): Promise<AgendaItem[]> {
  const [shared, personal] = await Promise.all([
    session.openRecords(here, 'agenda', true),
    orEmpty(session.db.query(`households/${here.id}`, PERSONAL_AGENDA, { where: [{ field: 'audience', op: 'ARRAY_CONTAINS', value: session.email }] })),
  ]);
  return [...shared, ...personal].map((d) => {
    const item = toAgendaItem(d.id, d.data);
    return { ...item, start: clock.local(item.start), ...(item.end !== undefined ? { end: clock.local(item.end) } : {}) };
  });
}

/** The to-do list as the portal shows it to this person: shared items they may read and their personal ones. Absolute times. */
export async function loadTodos(session: Session, here: Here): Promise<TodoItem[]> {
  const [shared, personal] = await Promise.all([
    session.openRecords(here, 'todos', true),
    orEmpty(session.db.query(`households/${here.id}`, PERSONAL_TODOS, { where: [{ field: 'audience', op: 'ARRAY_CONTAINS', value: session.email }] })),
  ]);
  return [...shared, ...personal].map((d) => toTodoItem(d.id, d.data));
}

/** An agenda item in the reader's language. Call inside `render`. */
export function agendaLine(item: AgendaItem, when: string): string {
  const { title, detail } = agendaWords(item);
  return `- ${when}: [${title}](${item.url})${detail ? ` (${detail})` : ''}`;
}

/** A to-do's words in the reader's language. Call inside `render`. */
export const todoText = (item: TodoItem) => todoWords(item);

/** Clips and tidies free text from the assistant to what the rules accept. */
export const clip = (s: string | undefined, max: number) => (s ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

/** Lowercase, accents off, for matching names the person said ("Nana" ~ "nana"). */
export const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/**
 * The one record whose id or name matches `wanted`: exact id, then exact name, then a unique name
 * that starts with or contains it. `undefined` when none; `'ambiguous'` with the candidates.
 */
export function pick<T>(items: T[], wanted: string, id: (x: T) => string, name: (x: T) => string): { found?: T; ambiguous?: T[] } {
  const w = fold(wanted);
  const byId = items.find((x) => id(x) === wanted);
  if (byId) return { found: byId };
  const exact = items.filter((x) => fold(name(x)) === w);
  if (exact.length === 1) return { found: exact[0] };
  if (exact.length > 1) return { ambiguous: exact };
  const starts = items.filter((x) => fold(name(x)).startsWith(w));
  if (starts.length === 1) return { found: starts[0] };
  const contains = starts.length ? starts : items.filter((x) => fold(name(x)).includes(w));
  if (contains.length === 1) return { found: contains[0] };
  return contains.length ? { ambiguous: contains } : {};
}

/** A FirestoreRest-safe id: a hash of the connection, the tool and the caller's idempotency key, or random. */
export async function recordId(connectionId: string, tool: string, key?: string): Promise<string> {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = key
    ? new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${connectionId}\u0000${tool}\u0000${key}`)))
    : crypto.getRandomValues(new Uint8Array(20));
  return [...bytes.slice(0, 20)].map((b) => alphabet[b % alphabet.length]).join('');
}

/** Whether a create failed because the record already exists (the same idempotency key, retried). */
export const alreadyThere = (e: unknown) => e instanceof FirestoreError && (e.code === 'already-exists' || e.code === 'failed-precondition');
