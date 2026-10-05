import { exchangeRefreshToken, FirebaseAuthError } from '@huishouden/pwa-kit/firebase-auth-rest';
import { isTimeZone } from '@huishouden/pwa-kit/local-clock';
import { isCliHandoffRequest, storeCliHandoff, takeCliHandoff } from '@huishouden/pwa-kit/signin-handoff';
import type { Env } from '../env';
import { authOptions, cors, json } from './http';

/**
 * `hh login` (huishouden/cli): the portal hands a sign-in over at /cli/hand-off and `hh` collects it
 * at /cli/token with its PKCE verifier (`@huishouden/pwa-kit/signin-handoff`, "Signing in from a
 * command line" in the kit's docs/server.md).
 */

/** The portal hands a command-line sign-in over: kept two minutes under a one-time code. */
export async function cliHandoff(request: Request, env: Env): Promise<Response> {
  const headers = cors(env, request);
  if (!headers) return json({ error: 'origin' }, 403);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return json({ error: 'method' }, 405, headers);
  const body = await request.json().catch(() => null);
  if (!isCliHandoffRequest(body)) return json({ error: 'invalid_request' }, 400, headers);
  try {
    const who = await exchangeRefreshToken(authOptions(env), body.refreshToken);
    const code = await storeCliHandoff(env.OAUTH_KV, { ...body, ...(body.timeZone && !isTimeZone(body.timeZone) ? { timeZone: undefined } : {}) }, who);
    return json({ code }, 200, headers);
  } catch (e) {
    if (e instanceof FirebaseAuthError) return json({ error: e.kind }, e.kind === 'unavailable' ? 503 : 401, headers);
    throw e;
  }
}


/**
 * `hh` collects its sign-in: the code, once, with the state, redirect and PKCE verifier it was made
 * for. Not for browsers (no CORS, and a request with an Origin is refused), so no web page can
 * spend a code. Every refusal is `invalid_grant`; the reason goes to the log only.
 */
export async function cliToken(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'method' }, 405);
  if (request.headers.get('Origin')) return json({ error: 'origin' }, 403);
  const body = await request.json().catch(() => null);
  const taken = await takeCliHandoff(env.OAUTH_KV, body);
  if (!taken.ok) {
    console.log(JSON.stringify({ event: 'cli_token', ok: false, reason: taken.reason }));
    return json({ error: 'invalid_grant' }, 400);
  }
  const h = taken.handoff;
  console.log(JSON.stringify({ event: 'cli_token', ok: true }));
  return json({
    refresh_token: h.refreshToken,
    uid: h.uid,
    email: h.email,
    // Public, like every app's web config: what `hh` needs to turn the refresh token into ID tokens.
    project_id: env.FIREBASE_PROJECT_ID,
    api_key: env.FIREBASE_API_KEY,
    site_url: env.SITE_URL,
    ...(h.lang ? { lang: h.lang } : {}),
    ...(h.timeZone ? { time_zone: h.timeZone } : {}),
  });
}

