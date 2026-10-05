import OAuthProvider, { OAuthError } from '@cloudflare/workers-oauth-provider';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { exchangeRefreshToken, FirebaseAuthError, IdTokenCache } from '@huishouden/pwa-kit/firebase-auth-rest';
import { FirestoreRest } from '@huishouden/pwa-kit/firestore-rest';
import { firestoreBase, type Env } from './env';
import { Session, sessionProps, type GrantProps } from './context';
import { buildServer, type ToolCallLog } from './mcp';
import { writeAudit } from './audit';
import { authOptions, defaultHandler } from './auth/routes';

/**
 * Huishouden connector: a remote MCP server (Streamable HTTP at /mcp) people add to their own AI
 * assistant. OAuth 2.1 with dynamic client registration (workers-oauth-provider); the person signs
 * in on Huishouden's portal, and every tool call reads and writes Firestore as them, so the
 * household's rules decide everything.
 */

/** ID tokens per refresh token, for this isolate (`@huishouden/pwa-kit/firebase-auth-rest`). */
let tokens: IdTokenCache | null = null;
const tokenCache = (env: Env) => (tokens ??= new IdTokenCache((refresh) => exchangeRefreshToken(authOptions(env), refresh)));

/** Logs carry the tool, the outcome and the time only: never names, emails, ids or medicines. */
const log = (entry: ToolCallLog) => console.log(JSON.stringify({ event: 'tool', ...entry }));

async function mcp(request: Request, env: Env, ctx: ExecutionContext & { props: GrantProps; auth: { token: string } }): Promise<Response> {
  const props = ctx.props;
  const cache = tokenCache(env);
  const db = new FirestoreRest({ projectId: env.FIREBASE_PROJECT_ID, token: async () => (await cache.get(props.refreshToken)).token, baseUrl: firestoreBase(env) });
  const session = new Session(sessionProps(props), db, env.SITE_URL, Date.now, (householdId, entry) => ctx.waitUntil(writeAudit(db, props, householdId, entry, Date.now())));
  const server = buildServer(session, {
    log,
    allow: async (kind) => {
      const key = props.connectionId;
      const all = env.TOOL_LIMITER ? (await env.TOOL_LIMITER.limit({ key })).success : true;
      const writes = kind === 'write' && env.WRITE_LIMITER ? (await env.WRITE_LIMITER.limit({ key })).success : true;
      return all && writes;
    },
    onRevoked: async () => {
      // The Firebase sign-in is gone (signed out everywhere, account disabled): end this grant, so
      // the assistant asks the person to connect again.
      const token = await env.OAUTH_PROVIDER.unwrapToken(ctx.auth.token);
      if (token) await env.OAUTH_PROVIDER.revokeGrant(token.grantId, token.userId);
    },
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const response = await transport.handleRequest(request);
  ctx.waitUntil(server.close());
  return response;
}

const providers = new Map<string, OAuthProvider<Env>>();

/**
 * The provider for the origin the Worker was reached on (its workers.dev name, or localhost under
 * `wrangler dev`): the OAuth issuer and the MCP resource `${origin}/mcp`. Built once per isolate.
 */
function provider(origin: string): OAuthProvider<Env> {
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: { fetch: mcp as never },
      defaultHandler: { fetch: defaultHandler as never },
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      clientRegistrationEndpoint: '/register',
      scopesSupported: ['huishouden'],
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin], resource_name: 'Huishouden' },
      clientIdMetadataDocumentEnabled: true,
      // Fewer KV writes on the free plan: an access token lasts 12 hours; a grant lives while it is used.
      accessTokenTTL: 12 * 3600,
      refreshTokenIdleTTL: 90 * 24 * 3600,
      tokenExchangeCallback: async ({ grantType, props, env: e }) => {
        if (grantType !== 'refresh_token') return;
        // Each refresh checks the person's Firebase sign-in still stands.
        try {
          await exchangeRefreshToken(authOptions(e), (props as GrantProps).refreshToken);
        } catch (err) {
          if (err instanceof FirebaseAuthError && err.kind !== 'unavailable') throw new OAuthError('invalid_grant', { description: 'The Huishouden sign-in has ended' });
          throw new OAuthError('temporarily_unavailable', { description: 'Firebase Auth is unavailable', statusCode: 503 });
        }
      },
    });
    providers.set(origin, p);
  }
  return p;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return provider(new URL(request.url).origin).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
