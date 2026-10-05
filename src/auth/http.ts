import type { AuthRestOptions } from '@huishouden/pwa-kit/firebase-auth-rest';
import type { Env } from '../env';

export const authOptions = (env: Env): AuthRestOptions => ({
  projectId: env.FIREBASE_PROJECT_ID,
  apiKey: env.FIREBASE_API_KEY,
  ...(env.SECURETOKEN_URL ? { securetokenUrl: env.SECURETOKEN_URL } : {}),
  ...(env.IDENTITY_URL ? { identityUrl: env.IDENTITY_URL } : {}),
});

/** CORS for the portal's calls: its own origin only. */
export function cors(env: Env, request: Request): Headers | null {
  const origin = request.headers.get('Origin');
  if (!origin || origin !== new URL(env.SITE_URL).origin) return null;
  return new Headers({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600', Vary: 'Origin' });
}

/** A JSON answer that no cache keeps. */
export const json = (body: unknown, status = 200, headers = new Headers()) => {
  headers.set('Content-Type', 'application/json');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers });
};
