import type { User } from 'firebase/auth';

/**
 * Playwright-only auth stand-in.
 *
 * Enabled by `NEXT_PUBLIC_E2E_AUTH_BYPASS=1`, which is set in the Playwright
 * webServer config and nowhere else. The token it issues is only accepted by
 * the ingest service when *its* matching bypass is on, and that refuses to
 * start under NODE_ENV=production.
 *
 * The alternative was the Firebase Auth emulator, which needs a Java runtime
 * in CI to test a dependency we do not own. This tests our own plumbing —
 * token in an Authorization header, verified server-side, resolved to a User —
 * which is the part that can actually break.
 */
export function isE2EBypassEnabled(): boolean {
  return process.env.NEXT_PUBLIC_E2E_AUTH_BYPASS === '1';
}

const E2E_UID = 'e2e-test-user';
const E2E_EMAIL = 'e2e@pulse.test';
const STORAGE_KEY = 'pulse-e2e-signed-in';

export const E2E_TOKEN = `e2e:${E2E_UID}:${E2E_EMAIL}`;

/** Enough of a Firebase `User` for the parts of the UI that read one. */
export function makeE2EUser(): User {
  return {
    uid: E2E_UID,
    email: E2E_EMAIL,
    displayName: 'E2E Test User',
    emailVerified: true,
    isAnonymous: false,
    providerData: [],
    async getIdToken() {
      return E2E_TOKEN;
    },
  } as unknown as User;
}

/**
 * Sign-in state survives a page navigation, so the suite can sign in once and
 * then navigate around like a real session.
 */
export function readE2ESignedIn(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeE2ESignedIn(signedIn: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (signedIn) window.sessionStorage.setItem(STORAGE_KEY, '1');
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private browsing can refuse; the test would fail visibly anyway */
  }
}
