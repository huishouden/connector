import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { AuthRestOptions } from '@huishouden/pwa-kit/firebase-auth-rest';
import type { ReadBudget } from './read-budget';

/** Bindings and settings (wrangler.toml). Everything here is public except the KV contents. */
export interface Env {
  /** Grants, tokens and clients (workers-oauth-provider), and the one-minute sign-in hand-offs. */
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  /** Tool calls per connected assistant per minute. */
  TOOL_LIMITER?: RateLimit;
  /** Writing tool calls per connected assistant per minute. */
  WRITE_LIMITER?: RateLimit;
  /** The day's Firestore reads, every connection's and each one's (src/read-budget.ts). */
  READ_BUDGET?: DurableObjectNamespace<ReadBudget>;
  /** Firestore reads a day for every connection together; unset or 0: no limit (src/reads.ts). */
  FIRESTORE_CONNECTOR_READS?: string;
  /** Firestore reads a day for one connection; unset or 0: no limit. */
  FIRESTORE_CONNECTION_READS?: string;
  /** The Firebase project the household's data lives in. */
  FIREBASE_PROJECT_ID: string;
  /** The project's public web API key (it ships in every app), for Firebase Auth's token service. */
  FIREBASE_API_KEY: string;
  /** The suite's site: the portal's sign-in page (`/connect`) and every app's deep links. */
  SITE_URL: string;
  /** Overrides for the emulators in tests; production leaves them unset. */
  FIRESTORE_URL?: string;
  SECURETOKEN_URL?: string;
  IDENTITY_URL?: string;
}

export const firestoreBase = (env: Pick<Env, 'FIRESTORE_URL'>) => (env.FIRESTORE_URL ?? 'https://firestore.googleapis.com/v1').replace(/\/$/, '');

/** Firebase Auth over REST for this project (the emulators when the test overrides are set). */
export const authOptions = (env: Env): AuthRestOptions => ({
  projectId: env.FIREBASE_PROJECT_ID,
  apiKey: env.FIREBASE_API_KEY,
  ...(env.SECURETOKEN_URL ? { securetokenUrl: env.SECURETOKEN_URL } : {}),
  ...(env.IDENTITY_URL ? { identityUrl: env.IDENTITY_URL } : {}),
});
