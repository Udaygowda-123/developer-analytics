import { cert, getApp, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';
import { getConfig } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('firebase');

const APP_NAME = 'pulse-ingest';

function buildApp(): App {
  const existing = getApps().find((a) => a.name === APP_NAME);
  if (existing) return getApp(APP_NAME);

  const cfg = getConfig();
  if (!cfg.FIREBASE_PROJECT_ID || !cfg.FIREBASE_CLIENT_EMAIL || !cfg.FIREBASE_PRIVATE_KEY) {
    throw new Error(
      'Firebase Admin is not configured. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and ' +
        'FIREBASE_PRIVATE_KEY (see .env.example).',
    );
  }

  return initializeApp(
    {
      credential: cert({
        projectId: cfg.FIREBASE_PROJECT_ID,
        clientEmail: cfg.FIREBASE_CLIENT_EMAIL,
        // Private keys are stored with literal "\n" in .env files; restore them.
        privateKey: cfg.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
      projectId: cfg.FIREBASE_PROJECT_ID,
    },
    APP_NAME,
  );
}

export interface TokenVerifier {
  verify(idToken: string): Promise<DecodedIdToken>;
}

let verifier: TokenVerifier | null = null;

export function getTokenVerifier(): TokenVerifier {
  verifier ??= {
    async verify(idToken: string) {
      // checkRevoked: true costs a round trip but means signing out on one
      // device actually ends the session everywhere, which is the whole point
      // of verifying server-side.
      return getAuth(buildApp()).verifyIdToken(idToken, true);
    },
  };
  return verifier;
}

/**
 * Tests (and the E2E harness) swap in a stub so they need no live Firebase
 * project. Production never calls this — the only other caller is the auth
 * middleware, which always goes through `getTokenVerifier`.
 */
export function setTokenVerifierForTesting(stub: TokenVerifier | null): void {
  if (stub && process.env.NODE_ENV === 'production') {
    log.warn('refusing to install a stub token verifier in production');
    return;
  }
  verifier = stub;
}
