import { beforeAll, describe, expect, test } from 'bun:test';
import { exchangeRefreshToken, FirebaseAuthError, verifyIdToken } from '@huishouden/pwa-kit/firebase-auth-rest';
import { AUTH, AUTH_HOST, signIn } from '../helpers';
import { PROJECT } from '../fixtures/household';

// Firebase Auth over REST against the Auth emulator: what the connector does with the refresh token
// the portal hands it, at sign-in, on every token refresh and before each tool call.
describe('Firebase Auth as the person', () => {
  let verified: { uid: string; refreshToken: string };
  beforeAll(async () => {
    verified = await signIn('verified@example.com');
  });

  test('a verified sign-in becomes an ID token with the uid and lowercase email', async () => {
    const t = await exchangeRefreshToken(AUTH, verified.refreshToken);
    expect(t).toMatchObject({ uid: verified.uid, email: 'verified@example.com' });
    expect(await verifyIdToken(AUTH, t.token)).toEqual({ uid: verified.uid, email: 'verified@example.com' });
  });

  test('an unverified email is refused (the rules would refuse every call)', async () => {
    const u = await signIn('unverified@example.com', { verified: false });
    const e = await exchangeRefreshToken(AUTH, u.refreshToken).catch((x) => x);
    expect(e).toBeInstanceOf(FirebaseAuthError);
    expect(e.kind).toBe('unverified');
  });

  test('a disabled account or a made-up token is revoked', async () => {
    const d = await signIn('disabled@example.com');
    await fetch(`${AUTH_HOST}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
      body: JSON.stringify({ localId: d.uid, disableUser: true }),
    });
    expect((await exchangeRefreshToken(AUTH, d.refreshToken).catch((x) => x)).kind).toBe('revoked');
    expect((await exchangeRefreshToken(AUTH, 'not-a-refresh-token-at-all').catch((x) => x)).kind).toBe('revoked');
  });

  test('a token for another project is refused', async () => {
    const e = await exchangeRefreshToken({ ...AUTH, projectId: 'another-project' }, verified.refreshToken).catch((x) => x);
    expect(e.kind).toBe('revoked');
  });
});
