import type { Lang } from '@huishouden/pwa-kit/i18n';
import type { SessionProps } from '@huishouden/pwa-kit/household-tools';

export { Session, UserError, type AuditEntry } from '@huishouden/pwa-kit/household-tools';

/**
 * What a grant carries for the person, kept encrypted in KV by workers-oauth-provider for as long as
 * the grant is used: a persisted shape, declared here so a kit change can't alter what old grants
 * are said to hold.
 */
export interface GrantProps {
  uid: string;
  email: string;
  /** Firebase Auth refresh token from the portal's sign-in: buys ID tokens to act as the person. */
  refreshToken: string;
  /** This connection's id: the `connections/{id}` record and its audit log. */
  connectionId: string;
  /** The assistant's name as it registered ("Claude"), shown in the portal's list. */
  client: string;
  clientUri?: string;
  /** The language and time zone the portal's device had at sign-in, until the profile says otherwise. */
  lang?: Lang;
  timeZone?: string;
}

/**
 * The tools' session for a grant: who, their language and zone, and `via: 'assistant'` on every
 * write. Only those: the refresh token stays with the token cache in index.ts.
 */
export const sessionProps = (p: GrantProps): SessionProps => ({
  uid: p.uid,
  email: p.email,
  connectionId: p.connectionId,
  ...(p.lang ? { lang: p.lang } : {}),
  ...(p.timeZone ? { timeZone: p.timeZone } : {}),
  via: 'assistant',
});
