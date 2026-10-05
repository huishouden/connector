import type { SessionProps } from '@huishouden/pwa-kit/household-tools';

export { Session, UserError, type AuditEntry } from '@huishouden/pwa-kit/household-tools';

/** What the grant carries for the person (encrypted in KV by workers-oauth-provider). */
export interface GrantProps extends Omit<SessionProps, 'via'> {
  /** Firebase Auth refresh token from the portal's sign-in: buys ID tokens to act as the person. */
  refreshToken: string;
  /** The assistant's name as it registered ("Claude"), shown in the portal's list. */
  client: string;
  clientUri?: string;
}

/** The session's props for a grant: everything an assistant writes is marked `via: 'assistant'`. */
export const sessionProps = (props: GrantProps): SessionProps => ({ ...props, via: 'assistant' });
