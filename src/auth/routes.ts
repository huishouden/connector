import { AuthorizationError, CimdFetchError, authorizationErrorRedirect, type ConsentDescription, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { CALLBACK_PATH, HANDOFF_PATH, connectUrl, isHandoffRequest, storeHandoff, takeHandoff, type HandoffRequest } from '@huishouden/pwa-kit/signin-handoff';
import { exchangeRefreshToken, verifyIdToken, FirebaseAuthError, type AuthRestOptions } from '@huishouden/pwa-kit/firebase-auth-rest';
import { FirestoreRest } from '@huishouden/pwa-kit/firestore-rest';
import { isTimeZone } from '@huishouden/pwa-kit/local-clock';
import { loadLang, matchLang, withLang, type Lang } from '@huishouden/pwa-kit/i18n';
import { firestoreBase, type Env } from '../env';
import type { GrantProps } from '../context';
import { recordConnection } from '../audit';
import { t } from '../i18n';

/**
 * The connector's sign-in, as MCP clients expect it (OAuth 2.1, dynamic client registration and
 * PKCE, served by workers-oauth-provider), with the person signing in on Huishouden's own portal:
 *
 * 1. GET /authorize: the client and where access goes, on this Worker's consent page (no framing,
 *    a form bound to this browser).
 * 2. POST /authorize: approved; the browser goes to the portal's /connect page with a state bound
 *    to this browser (`@huishouden/pwa-kit/signin-handoff`).
 * 3. The portal signs the person in with Google as in every app, asks them to confirm, posts their
 *    Firebase refresh token to /connect/hand-off and sends the browser to /connect/callback.
 * 4. /connect/callback completes the grant: the refresh token goes into the grant's props, which
 *    workers-oauth-provider keeps encrypted in KV with a key only the client's tokens unwrap.
 */

export const authOptions = (env: Env): AuthRestOptions => ({
  projectId: env.FIREBASE_PROJECT_ID,
  apiKey: env.FIREBASE_API_KEY,
  ...(env.SECURETOKEN_URL ? { securetokenUrl: env.SECURETOKEN_URL } : {}),
  ...(env.IDENTITY_URL ? { identityUrl: env.IDENTITY_URL } : {}),
});

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function langOf(request: Request): Promise<Lang> {
  const header = request.headers.get('Accept-Language') ?? '';
  const lang = matchLang(header.split(',').map((p) => p.split(';')[0].trim()).filter(Boolean));
  await loadLang(lang);
  return lang;
}

const PAGE_CSS = `
:root{color-scheme:light dark;--bg:#f5f5f4;--card:#fff;--ink:#1c1917;--muted:#57534e;--line:#e7e5e4;--brand:#2d6a4f;--brand-ink:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--card:#1c1917;--ink:#f5f5f4;--muted:#d6d3d1;--line:#44403c;--brand:#52b788;--brand-ink:#0c0a09}}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:24px}
main{max-width:480px;width:100%;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px}
h1{font-size:22px;line-height:28px;margin:0 0 12px}p{margin:0 0 12px;color:var(--muted)}strong{color:var(--ink)}
.warn{border-left:4px solid #b45309;padding-left:12px;color:var(--ink)}
.row{display:flex;gap:12px;flex-wrap:wrap;margin-top:20px}
button{min-height:44px;padding:0 20px;border-radius:999px;font:inherit;font-weight:600;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--ink)}
button.primary{background:var(--brand);color:var(--brand-ink);border-color:var(--brand)}
.brand{font-weight:700;color:var(--brand);margin-bottom:8px;letter-spacing:.02em}`;

function page(lang: Lang, title: string, body: string, headers = new Headers(), status = 200): Response {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; frame-ancestors 'none'; base-uri 'none'");
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Cache-Control', 'no-store');
  return new Response(
    `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>${PAGE_CSS}</style></head><body><main><div class="brand">Huishouden</div>${body}</main></body></html>`,
    { status, headers },
  );
}

function consentPage(lang: Lang, d: ConsentDescription, handle: string, headers: Headers): Response {
  return withLang(lang, () => {
    const body = `<h1>${escape(t('consent.title', { client: d.clientName }))}</h1>
<p>${escape(t('consent.body', { client: d.clientName }))}</p>
<p>${d.clientDomain ? escape(t('consent.verified', { domain: d.clientDomain })) : escape(t('consent.unverified'))} <strong>${escape(t('consent.redirect', { host: d.redirectHost }))}</strong></p>
${d.redirectIsLoopback ? `<p class="warn">${escape(t('consent.loopback'))}</p>` : ''}
<p>${escape(t('consent.revoke'))}</p>
<form method="post" action="/authorize"><input type="hidden" name="handle" value="${escape(handle)}">
<div class="row"><button class="primary" name="decision" value="approve">${escape(t('consent.continue'))}</button><button name="decision" value="deny">${escape(t('consent.cancel'))}</button></div></form>`;
    return page(lang, t('consent.title', { client: d.clientName }), body, headers);
  });
}

const errorPage = (lang: Lang, message: string) => page(lang, 'Huishouden', `<p>${escape(message)}</p>`, new Headers(), 400);

/** What `beginUpstream` keeps for the callback: who the client is, for the grant's record. */
interface UpstreamData {
  client: string;
  clientUri?: string;
}

async function authorizeGet(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const lang = await langOf(request);
  const authRequest = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  return consentPage(lang, details, consent.handle, consent.headers);
}

async function authorizePost(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handle = String(form.get('handle') ?? '');
  if (form.get('decision') !== 'approve') {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(request, handle);
  const details = await oauth.describeConsent(approved.request);
  const data: UpstreamData = { client: details.clientName.slice(0, 80), ...(details.clientUri ? { clientUri: details.clientUri } : {}) };
  const { state, headers } = await oauth.beginUpstream(approved.request, { data, headers: approved.headers });
  const origin = new URL(request.url).origin;
  headers.set('Location', connectUrl(env.SITE_URL, { service: origin, state, client: details.clientName, redirectHost: details.redirectHost, purpose: 'assistant' }));
  return new Response(null, { status: 302, headers });
}

/** CORS for the portal's calls: its own origin only. */
function cors(env: Env, request: Request): Headers | null {
  const origin = request.headers.get('Origin');
  if (!origin || origin !== new URL(env.SITE_URL).origin) return null;
  return new Headers({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600', Vary: 'Origin' });
}

const json = (body: unknown, status = 200, headers = new Headers()) => {
  headers.set('Content-Type', 'application/json');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers });
};

/** Who signed in on the portal, kept for the callback. */
type Handoff = HandoffRequest & { uid: string; email: string };

async function handoff(request: Request, env: Env): Promise<Response> {
  const headers = cors(env, request);
  if (!headers) return json({ error: 'origin' }, 403);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  const body = await request.json().catch(() => null);
  if (!isHandoffRequest(body)) return json({ error: 'invalid_request' }, 400, headers);
  try {
    const who = await exchangeRefreshToken(authOptions(env), body.refreshToken);
    const code = await storeHandoff<Handoff>(env.OAUTH_KV, { ...body, ...(body.timeZone && !isTimeZone(body.timeZone) ? { timeZone: undefined } : {}), uid: who.uid, email: who.email });
    return json({ code }, 200, headers);
  } catch (e) {
    if (e instanceof FirebaseAuthError) return json({ error: e.kind }, e.kind === 'unavailable' ? 503 : 401, headers);
    throw e;
  }
}

async function callback(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const url = new URL(request.url);
  const resumed = await oauth.finishUpstream<UpstreamData>(request);
  const original = resumed.request;
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? '';
  const signedIn = code ? await takeHandoff<Handoff>(env.OAUTH_KV, code, state) : null;
  if (!signedIn) {
    resumed.headers.set('Location', authorizationErrorRedirect(original, 'access_denied'));
    return new Response(null, { status: 302, headers: resumed.headers });
  }
  const connectionId = crypto.randomUUID().replace(/-/g, '');
  const props: GrantProps = {
    uid: signedIn.uid,
    email: signedIn.email,
    refreshToken: signedIn.refreshToken,
    connectionId,
    client: resumed.data.client,
    ...(resumed.data.clientUri ? { clientUri: resumed.data.clientUri } : {}),
    ...(signedIn.lang ? { lang: signedIn.lang } : {}),
    ...(signedIn.timeZone ? { timeZone: signedIn.timeZone } : {}),
  };
  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: signedIn.uid,
    // Not encrypted (the provider lists grants by it): only ids and the client's own name.
    metadata: { connectionId, client: props.client },
    scope: original.scope,
    props,
  });
  // The portal's list shows the connection at once, in each household the person is in.
  ctx.waitUntil(
    (async () => {
      const token = (await exchangeRefreshToken(authOptions(env), props.refreshToken)).token;
      await recordConnection(new FirestoreRest({ projectId: env.FIREBASE_PROJECT_ID, token: async () => token, baseUrl: firestoreBase(env) }), props, Date.now());
    })().catch(() => {}),
  );
  resumed.headers.set('Location', redirectTo);
  return new Response(null, { status: 302, headers: resumed.headers });
}

/** The person's own grants, found by the portal's Firebase ID token. */
async function connections(request: Request, env: Env): Promise<Response> {
  const headers = cors(env, request);
  if (!headers) return json({ error: 'origin' }, 403);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  const idToken = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!idToken) return json({ error: 'unauthenticated' }, 401, headers);
  let person;
  try {
    person = await verifyIdToken(authOptions(env), idToken);
  } catch (e) {
    return json({ error: e instanceof FirebaseAuthError ? e.kind : 'unauthenticated' }, 401, headers);
  }
  const grants = (await listGrants(env.OAUTH_PROVIDER, person.uid)).map((g) => ({
    connectionId: String(g.metadata?.connectionId ?? ''),
    client: String(g.metadata?.client ?? ''),
    createdAt: g.createdAt * (g.createdAt < 1e12 ? 1000 : 1),
  }));
  if (request.method === 'GET') return json({ connections: grants }, 200, headers);
  const body = (await request.json().catch(() => ({}))) as { connectionId?: unknown };
  const wanted = typeof body.connectionId === 'string' ? body.connectionId : '';
  const matching = (await listGrants(env.OAUTH_PROVIDER, person.uid)).filter((g) => g.metadata?.connectionId === wanted);
  for (const g of matching) await env.OAUTH_PROVIDER.revokeGrant(g.id, person.uid);
  // The person's own records of it go too, written away as them (the portal removes them as well).
  const db = new FirestoreRest({ projectId: env.FIREBASE_PROJECT_ID, token: async () => idToken, baseUrl: firestoreBase(env) });
  if (/^[A-Za-z0-9_-]{1,64}$/.test(wanted)) {
    const households = await db.query('', 'households', { where: [{ field: 'members', op: 'ARRAY_CONTAINS', value: person.email }] }).catch(() => []);
    await Promise.all(households.map((h) => db.commit([{ path: `households/${h.id}/connections/${wanted}`, delete: true }]).catch(() => {})));
  }
  return json({ revoked: matching.length }, 200, headers);
}

async function listGrants(oauth: OAuthHelpers, uid: string) {
  const out = [];
  let cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(uid, { cursor, limit: 100 });
    out.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return out;
}

function home(request: Request, env: Env): Response {
  const origin = new URL(request.url).origin;
  return json({
    name: 'Huishouden connector',
    mcp: `${origin}/mcp`,
    howTo: `${new URL('/assistant', env.SITE_URL).href}`,
    source: 'https://github.com/huishouden/connector',
  });
}

/** Everything that isn't the MCP endpoint or the provider's own (token, register, metadata). */
export async function defaultHandler(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname === '/authorize') return request.method === 'POST' ? await authorizePost(request, env) : await authorizeGet(request, env);
    if (url.pathname === HANDOFF_PATH) return await handoff(request, env);
    if (url.pathname === CALLBACK_PATH) return await callback(request, env, ctx);
    if (url.pathname === '/connections' || url.pathname === '/connections/revoke') return await connections(request, env);
    if (url.pathname === '/' && request.method === 'GET') return home(request, env);
    return new Response('Not found', { status: 404 });
  } catch (e) {
    if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
    if (e instanceof AuthorizationError || e instanceof CimdFetchError) {
      const lang = await langOf(request);
      return errorPage(lang, withLang(lang, () => (e instanceof AuthorizationError && /expired|used|browser|binding|state/i.test(e.description ?? '') ? t('consent.expired') : t('consent.error', { reason: e instanceof AuthorizationError ? (e.description ?? e.code) : 'client metadata' }))));
    }
    throw e;
  }
}
