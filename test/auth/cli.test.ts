import { afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { CLI_HANDOFF_PATH, CLI_TOKEN_PATH, pkceChallenge } from '@huishouden/pwa-kit/signin-handoff';
import { cliHandoff, cliToken } from '../../src/auth/cli';
import type { Env } from '../../src/env';
import { AUTH, signIn } from '../helpers';
import { PROJECT } from '../fixtures/household';

// `hh login`'s two endpoints, with the Auth emulator: the portal hands a sign-in over, `hh`
// collects it once with its PKCE verifier.

const SITE = 'https://huishouden-staging.web.app';
const WORKER = 'https://connector.example.workers.dev';
const STATE = 'state-abcdefghijklmnop';
const VERIFIER = 'verifier-' + 'a'.repeat(40);
const REDIRECT = 'http://127.0.0.1:49152/callback';

function env(): Env {
  const map = new Map<string, string>();
  return {
    OAUTH_KV: { get: async (k: string) => map.get(k) ?? null, put: async (k: string, v: string) => void map.set(k, v), delete: async (k: string) => void map.delete(k) } as unknown as KVNamespace,
    OAUTH_PROVIDER: undefined as never,
    FIREBASE_PROJECT_ID: PROJECT,
    FIREBASE_API_KEY: AUTH.apiKey,
    SITE_URL: SITE,
    SECURETOKEN_URL: AUTH.securetokenUrl,
    IDENTITY_URL: AUTH.identityUrl,
  };
}

const send = (e: Env, path: string, body: unknown, headers: Record<string, string> = {}) =>
  (path === CLI_HANDOFF_PATH ? cliHandoff : cliToken)(new Request(`${WORKER}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }), e);
const fromPortal = { Origin: SITE };

let refreshToken: string;
let challenge: string;
beforeAll(async () => {
  refreshToken = (await signIn('cli@example.com')).refreshToken;
  challenge = await pkceChallenge(VERIFIER);
});
afterEach(() => setSystemTime());

async function handOff(e: Env, over: Record<string, unknown> = {}): Promise<Response> {
  return send(e, CLI_HANDOFF_PATH, { state: STATE, refreshToken, codeChallenge: challenge, redirect: REDIRECT, lang: 'nl', ...over }, fromPortal);
}

const collect = (e: Env, code: string, over: Record<string, unknown> = {}) => send(e, CLI_TOKEN_PATH, { code, state: STATE, code_verifier: VERIFIER, redirect_uri: REDIRECT, ...over });

describe('hh login', () => {
  test('the portal hands over; hh collects the refresh token once, with what it needs to use it', async () => {
    const e = env();
    const res = await handOff(e);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(SITE);
    const { code } = (await res.json()) as { code: string };
    const got = await collect(e, code);
    expect(got.status).toBe(200);
    expect(got.headers.get('Cache-Control')).toBe('no-store');
    expect((await got.json()) as object).toEqual({ refresh_token: refreshToken, uid: expect.any(String), email: 'cli@example.com', project_id: PROJECT, api_key: AUTH.apiKey, site_url: SITE, lang: 'nl' });
    const again = await collect(e, code);
    expect(again.status).toBe(400);
    expect((await again.json()) as object).toEqual({ error: 'invalid_grant' });
  });

  test('a non-loopback redirect is refused before anything is kept', async () => {
    for (const redirect of ['http://localhost:49152/callback', 'https://evil.example/callback', 'http://127.0.0.1:80/callback', 'http://127.0.0.1:49152/callback?x=1']) {
      const res = await handOff(env(), { redirect });
      expect([redirect, res.status]).toEqual([redirect, 400]);
    }
  });

  test('only the portal may hand over, and only a real sign-in', async () => {
    expect((await send(env(), CLI_HANDOFF_PATH, { state: STATE, refreshToken, codeChallenge: challenge, redirect: REDIRECT }, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await send(env(), CLI_HANDOFF_PATH, { state: STATE, refreshToken, codeChallenge: challenge, redirect: REDIRECT })).status).toBe(403);
    expect((await handOff(env(), { refreshToken: 'not-a-refresh-token-at-all' })).status).toBe(401);
  });

  test('a state mismatch gets nothing, and the code is gone', async () => {
    const e = env();
    const { code } = (await (await handOff(e)).json()) as { code: string };
    expect((await collect(e, code, { state: 'state-other-0123456789' })).status).toBe(400);
    expect((await collect(e, code)).status).toBe(400);
  });

  test('a challenge mismatch (the wrong verifier) gets nothing, and the code is gone', async () => {
    const e = env();
    const { code } = (await (await handOff(e)).json()) as { code: string };
    expect((await collect(e, code, { code_verifier: 'wrong-' + 'b'.repeat(40) })).status).toBe(400);
    expect((await collect(e, code)).status).toBe(400);
  });

  test('an expired code gets nothing', async () => {
    const e = env();
    const { code } = (await (await handOff(e)).json()) as { code: string };
    setSystemTime(new Date(Date.now() + 121_000));
    expect((await collect(e, code)).status).toBe(400);
  });

  test('a replayed code gets nothing', async () => {
    const e = env();
    const { code } = (await (await handOff(e)).json()) as { code: string };
    expect((await collect(e, code)).status).toBe(200);
    expect((await collect(e, code)).status).toBe(400);
  });

  test('a web page cannot spend a code', async () => {
    const e = env();
    const { code } = (await (await handOff(e)).json()) as { code: string };
    expect((await send(e, CLI_TOKEN_PATH, { code, state: STATE, code_verifier: VERIFIER, redirect_uri: REDIRECT }, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await collect(e, code)).status).toBe(200);
  });
});
