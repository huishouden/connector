import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { exchangeRefreshToken, IdTokenCache, type AuthRestOptions } from '@huishouden/pwa-kit/firebase-auth-rest';
import { FirestoreRest, type Doc } from '@huishouden/pwa-kit/firestore-rest';
import { Session, sessionProps, type GrantProps } from '../src/context';
import { buildServer, type ToolCallLog } from '../src/mcp';
import { writeAudit, forgetConnections } from '../src/audit';
import { householdDocs, NOW, PROJECT } from './fixtures/household';
import type { ReadMeter } from '../src/reads';

/** The emulators `firebase emulators:exec` starts (firebase.json). */
export const FIRESTORE_URL = 'http://127.0.0.1:8080/v1';
export const AUTH_HOST = 'http://127.0.0.1:9099';
export const AUTH: AuthRestOptions = {
  projectId: PROJECT,
  apiKey: 'emulator-key',
  securetokenUrl: `${AUTH_HOST}/securetoken.googleapis.com/v1`,
  identityUrl: `${AUTH_HOST}/identitytoolkit.googleapis.com/v1`,
};

/** Rules bypassed: the emulator's owner token. */
export const owner = new FirestoreRest({ projectId: PROJECT, token: async () => 'owner', baseUrl: FIRESTORE_URL });

export async function resetFirestore(): Promise<void> {
  // The emulator answers 409 while a write is still finishing: wait and clear again.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
    if (res.ok) return;
    if (attempt >= 20) throw new Error(`clear firestore: ${res.status}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

export async function seed(docs = householdDocs()): Promise<void> {
  await resetFirestore();
  forgetConnections();
  const entries = Object.entries(docs);
  for (let i = 0; i < entries.length; i += 200) await owner.commit(entries.slice(i, i + 200).map(([path, set]) => ({ path, set })));
}

export async function resetAuth(): Promise<void> {
  await fetch(`${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
}

const accounts = new Map<string, { uid: string; refreshToken: string }>();

/** A Firebase account in the Auth emulator with a verified email, and its refresh token. */
export async function signIn(email: string, { verified = true } = {}): Promise<{ uid: string; refreshToken: string }> {
  const key = `${email}:${verified}`;
  const known = accounts.get(key);
  if (known) return known;
  const api = `${AUTH_HOST}/identitytoolkit.googleapis.com/v1`;
  let res = await fetch(`${api}/accounts:signUp?key=k`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'not-a-real-password', returnSecureToken: true }) });
  if (!res.ok) res = await fetch(`${api}/accounts:signInWithPassword?key=k`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'not-a-real-password', returnSecureToken: true }) });
  const body = (await res.json()) as { localId: string; refreshToken: string };
  if (verified) {
    const up = await fetch(`${api}/projects/${PROJECT}/accounts:update`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' }, body: JSON.stringify({ localId: body.localId, emailVerified: true }) });
    if (!up.ok) throw new Error(`verify ${email}: ${up.status} ${await up.text()}`);
  }
  const out = { uid: body.localId, refreshToken: body.refreshToken };
  accounts.set(key, out);
  return out;
}

export interface Connected {
  client: Client;
  props: GrantProps;
  db: FirestoreRest;
  logs: ToolCallLog[];
  /** Waits for the audit writes made so far. */
  settled: () => Promise<void>;
  close: () => Promise<void>;
}

/** An MCP client talking to the connector's server as `email`, through the emulators, at NOW. */
export async function connect(email: string, { now = NOW, lang, timeZone, reads }: { now?: number; lang?: GrantProps['lang']; timeZone?: string; reads?: ReadMeter } = {}): Promise<Connected> {
  const { uid, refreshToken } = await signIn(email);
  const props: GrantProps = { uid, email, refreshToken, connectionId: `test${email.split('@')[0]}`, client: 'Test assistant', ...(lang ? { lang } : {}), ...(timeZone ? { timeZone } : {}) };
  const cache = new IdTokenCache((r) => exchangeRefreshToken(AUTH, r));
  const db = new FirestoreRest({ projectId: PROJECT, token: async () => (await cache.get(refreshToken)).token, baseUrl: FIRESTORE_URL, ...(reads ? { fetch: reads.fetch((url, init) => fetch(url, init)) } : {}) });
  const pending: Promise<void>[] = [];
  const session = new Session(sessionProps(props), db, 'https://huishouden-staging.web.app', () => now, (h, entry) => pending.push(writeAudit(db, props, h, entry, now)));
  const logs: ToolCallLog[] = [];
  const server = buildServer(session, { log: (e) => logs.push(e), ...(reads ? { reads } : {}) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(b);
  return { client, props, db, logs, settled: async () => void (await Promise.all(pending)), close: async () => {
      await Promise.all(pending);
      await client.close();
    },
  };
}

export interface Answer {
  text: string;
  data: Record<string, any>;
  isError: boolean;
}

export async function call(c: Connected, name: string, args: Record<string, unknown> = {}): Promise<Answer> {
  const res = (await c.client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; structuredContent?: Record<string, any>; isError?: boolean };
  return { text: res.content.map((x) => x.text).join('\n'), data: res.structuredContent ?? {}, isError: res.isError === true };
}

export const read = (path: string): Promise<Doc | null> => owner.get(path);
