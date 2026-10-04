import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type Subprocess } from 'bun';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { exchangeRefreshToken } from '@huishouden/pwa-kit/firebase-auth-rest';
import { ALICE, BOB, CAROL, PROJECT } from '../fixtures/household';
import { AUTH, AUTH_HOST, FIRESTORE_URL, read, seed, signIn } from '../helpers';

/**
 * End to end: the Worker under `wrangler dev` against the emulators, an MCP SDK client doing the
 * whole sign-in (dynamic registration, PKCE, the consent page, the portal's hand-off), then tools.
 * The real household's data is never touched: everything is the invented household in the emulator.
 */

const PORT = 8788;
const ORIGIN = `http://localhost:${PORT}`;
const SITE = 'http://127.0.0.1:5999';
const REDIRECT = 'http://127.0.0.1:5998/callback';
let worker: Subprocess;

beforeAll(async () => {
  await seed();
  const vars = {
    FIREBASE_PROJECT_ID: PROJECT,
    FIREBASE_API_KEY: 'emulator-key',
    SITE_URL: SITE,
    FIRESTORE_URL,
    SECURETOKEN_URL: `${AUTH_HOST}/securetoken.googleapis.com/v1`,
    IDENTITY_URL: `${AUTH_HOST}/identitytoolkit.googleapis.com/v1`,
  };
  worker = spawn(['bunx', 'wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--env', '', ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])], {
    stdout: 'ignore',
    stderr: 'ignore',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  for (let i = 0; i < 120; i++) {
    const up = await fetch(`${ORIGIN}/`).then((r) => r.ok).catch(() => false);
    if (up) return;
    await Bun.sleep(500);
  }
  throw new Error('wrangler dev did not start');
}, 90_000);

afterAll(() => {
  worker?.kill();
});

const cookiesOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(';')[0]);

/**
 * What a person does in the browser: the consent page (Continue), the portal's /connect page (signed
 * in, confirms: it posts the hand-off and goes to the callback), back to the assistant with a code.
 */
async function browserSignIn(authorizationUrl: URL, email: string, { origin = SITE } = {}): Promise<string> {
  const jar: string[] = [];
  const consent = await fetch(authorizationUrl, { redirect: 'manual' });
  expect(consent.status).toBe(200);
  expect(consent.headers.get('X-Frame-Options')).toBe('DENY');
  jar.push(...cookiesOf(consent));
  const html = await consent.text();
  expect(html).toContain('E2E assistant');
  expect(html).toContain('127.0.0.1');
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1];
  const approve = await fetch(`${ORIGIN}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.join('; ') },
    body: new URLSearchParams({ handle, decision: 'approve' }),
  });
  expect(approve.status).toBe(302);
  jar.push(...cookiesOf(approve));
  const portal = new URL(approve.headers.get('Location')!);
  expect(portal.origin + portal.pathname).toBe(`${SITE}/connect`);
  expect(portal.searchParams.get('service')).toBe(ORIGIN);
  expect(portal.searchParams.get('client')).toBe('E2E assistant');
  const state = portal.searchParams.get('state')!;
  // The portal: the signed-in person's refresh token, posted from the portal's origin only.
  const { refreshToken } = await signIn(email);
  const handoff = await fetch(`${ORIGIN}/connect/hand-off`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ state, refreshToken, lang: 'en', timeZone: 'America/New_York' }),
  });
  if (handoff.status !== 200) throw new Error(`hand-off ${handoff.status}`);
  const { code } = (await handoff.json()) as { code: string };
  const back = await fetch(`${ORIGIN}/connect/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`, { redirect: 'manual', headers: { Cookie: jar.join('; ') } });
  expect(back.status).toBe(302);
  const toClient = new URL(back.headers.get('Location')!);
  expect(toClient.origin + toClient.pathname).toBe(REDIRECT);
  return toClient.searchParams.get('code')!;
}

class TestProvider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  saved?: OAuthTokens;
  verifier = '';
  authorizationUrl?: URL;
  get redirectUrl() {
    return REDIRECT;
  }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: 'E2E assistant', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
}

/** An MCP SDK client signed in as `email`, through the whole OAuth flow. */
async function connectAs(email: string): Promise<{ client: Client; provider: TestProvider }> {
  const provider = new TestProvider();
  const url = new URL(`${ORIGIN}/mcp`);
  let transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
  let client = new Client({ name: 'e2e', version: '1.0.0' });
  await expect(client.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
  const code = await browserSignIn(provider.authorizationUrl!, email);
  await transport.finishAuth(code);
  transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
  client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(transport);
  return { client, provider };
}

const text = (r: unknown) => ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text).join('\n');

describe('discovery', () => {
  test('protected resource and authorization server metadata, dynamic registration', async () => {
    const unauth = await fetch(`${ORIGIN}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('WWW-Authenticate')).toContain('resource_metadata=');
    const resource = (await (await fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`)).json()) as { resource: string; authorization_servers: string[] };
    expect(resource.resource).toBe(`${ORIGIN}/mcp`);
    const as = (await (await fetch(`${ORIGIN}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as).toMatchObject({ authorization_endpoint: `${ORIGIN}/authorize`, token_endpoint: `${ORIGIN}/token`, registration_endpoint: `${ORIGIN}/register` });
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
  });
});

describe('the hand-off refuses', () => {
  test('another origin, a made-up token, a missing code', async () => {
    const body = JSON.stringify({ state: 'x'.repeat(32), refreshToken: 'y'.repeat(40) });
    expect((await fetch(`${ORIGIN}/connect/hand-off`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body })).status).toBe(403);
    expect((await fetch(`${ORIGIN}/connect/hand-off`, { method: 'POST', headers: { Origin: SITE, 'Content-Type': 'application/json' }, body })).status).toBe(401);
    const back = await fetch(`${ORIGIN}/connect/callback?state=${'x'.repeat(32)}&code=nothing`, { redirect: 'manual' });
    expect(back.status).toBe(400);
  });
});

describe('an assistant signed in as a member', () => {
  let alice: Awaited<ReturnType<typeof connectAs>>;
  beforeAll(async () => {
    alice = await connectAs(ALICE);
  }, 60_000);

  test('lists the tools', async () => {
    const { tools } = await alice.client.listTools();
    expect(tools.length).toBe(27);
    expect(tools.map((t) => t.name)).toContain('health_medicines');
  });

  test("what's on today?", async () => {
    const r = await alice.client.callTool({ name: 'today', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('Today,');
    expect(text(r)).toContain('Clean the gutters');
    // The invented household lives in 2031; its calendar is there.
    const day = await alice.client.callTool({ name: 'calendar', arguments: { from: '2031-01-07', to: '2031-01-07' } });
    expect(text(day)).toContain('Vet: annual checkup');
  });

  test('adds a grocery, as Alice, from the assistant', async () => {
    const r = (await alice.client.callTool({ name: 'groceries_add', arguments: { name: 'Coffee beans', category: 'Beverages & Coffee', idempotency_key: 'e2e-coffee' } })) as unknown as { structuredContent: { id: string } };
    const item = await read(`households/h1/items/${r.structuredContent.id}`);
    expect(item!.data).toMatchObject({ name: 'Coffee beans', by: ALICE, via: 'assistant' });
  });

  test('the connection is recorded in the household, with an audit entry, for Alice only', async () => {
    await Bun.sleep(500);
    const { owner } = await import('../helpers');
    const conns = await owner.query('households/h1', 'connections');
    const mine = conns.find((c) => c.data.email === ALICE)!;
    expect(mine.data).toMatchObject({ client: 'E2E assistant', by: ALICE });
    const audit = await owner.query(mine.path, 'audit');
    expect(audit.map((a) => a.data.tool)).toEqual(expect.arrayContaining(['today', 'groceries_add']));
  });

  test('revoking from the portal ends the grant: the next call is refused', async () => {
    const { refreshToken } = await signIn(ALICE);
    const idToken = (await exchangeRefreshToken(AUTH, refreshToken)).token;
    const list = (await (await fetch(`${ORIGIN}/connections`, { headers: { Origin: SITE, Authorization: `Bearer ${idToken}` } })).json()) as { connections: { connectionId: string; client: string }[] };
    expect(list.connections).toEqual([expect.objectContaining({ client: 'E2E assistant' })]);
    const revoke = await fetch(`${ORIGIN}/connections/revoke`, {
      method: 'POST',
      headers: { Origin: SITE, Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId: list.connections[0].connectionId }),
    });
    expect((await revoke.json()) as unknown).toEqual({ revoked: 1 });
    const after = await fetch(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.provider.saved!.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(after.status).toBe(401);
    const { owner } = await import('../helpers');
    expect((await owner.query('households/h1', 'connections')).filter((c) => c.data.email === ALICE)).toEqual([]);
  });
});

describe('Health through the assistant', () => {
  test('a carer gets Nan\'s medicines; a member who is not a carer gets nothing', async () => {
    const bob = await connectAs(BOB);
    const r = await bob.client.callTool({ name: 'health_medicines', arguments: { person: 'Nan', lang: 'en' } });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('Examplamine 10 mg');
    expect(text(r)).toContain('not medical advice');
    const carol = await connectAs(CAROL);
    const c = await carol.client.callTool({ name: 'health_medicines', arguments: { person: 'Nan' } });
    expect(c.isError).toBe(true);
    expect(text(c)).not.toContain('Examplamine');
  }, 60_000);
});
