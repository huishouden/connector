import type { FirestoreRest } from '@huishouden/pwa-kit/firestore-rest';
import type { AuditEntry, GrantProps } from './context';

/**
 * The person's record of a connected assistant, `households/{id}/connections/{connectionId}`, and
 * an audit entry for every tool call under it, both written as the person (the rules let only
 * them read or remove either). The portal's "Use with your AI assistant" page lists them.
 */

/** Connections known to exist in this isolate, so the first call in a household checks once. */
const known = new Set<string>();

export function connectionDoc(props: GrantProps, now: number) {
  return {
    email: props.email,
    client: props.client.slice(0, 80) || 'AI assistant',
    ...(props.clientUri && /^https:\/\/.{1,290}$/.test(props.clientUri) ? { clientUri: props.clientUri } : {}),
    createdAt: now,
    lastUsedAt: now,
    by: props.email,
  };
}

/** Makes sure the connection is recorded in `householdId` (creating it the first time). */
export async function ensureConnection(db: FirestoreRest, props: GrantProps, householdId: string, now: number): Promise<void> {
  const key = `${householdId}/${props.connectionId}`;
  if (known.has(key)) return;
  const path = `households/${householdId}/connections/${props.connectionId}`;
  // A missing record can't be read (the rules check whose it is), so create it and let an existing
  // one refuse the create.
  await db.commit([{ path, create: connectionDoc(props, now) }]).catch(() => {});
  known.add(key);
}

/** Writes one audit entry and marks the connection used. Failures are swallowed: the call already happened. */
export async function writeAudit(db: FirestoreRest, props: GrantProps, householdId: string, entry: AuditEntry, now: number): Promise<void> {
  try {
    await ensureConnection(db, props, householdId, now);
    const base = `households/${householdId}/connections/${props.connectionId}`;
    const id = `${now.toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
    await db.commit([
      { path: base, merge: { lastUsedAt: now } },
      {
        path: `${base}/audit/${id}`,
        create: { tool: entry.tool, kind: entry.kind, ok: entry.ok, ...(entry.app ? { app: entry.app.slice(0, 40) } : {}), ...(entry.ref ? { ref: entry.ref.slice(0, 300) } : {}), at: now, by: props.email },
      },
    ]);
  } catch {
    known.delete(`${householdId}/${props.connectionId}`);
  }
}

/** Records the connection in every household the person is in (right after they connect). */
export async function recordConnection(db: FirestoreRest, props: GrantProps, now: number): Promise<void> {
  const households = await db.query('', 'households', { where: [{ field: 'members', op: 'ARRAY_CONTAINS', value: props.email }] });
  await Promise.all(households.map((h) => ensureConnection(db, props, h.id, now).catch(() => {})));
}

export function forgetConnections(): void {
  known.clear();
}
