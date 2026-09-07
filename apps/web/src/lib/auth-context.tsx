'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  onIdTokenChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
  updateProfile,
  type User,
} from 'firebase/auth';
import { getFirebaseAuth, googleProvider, isFirebaseConfigured } from './firebase';
import { SESSION_COOKIE } from './constants';
import {
  E2E_TOKEN,
  isE2EBypassEnabled,
  makeE2EUser,
  readE2ESignedIn,
  writeE2ESignedIn,
} from './e2e-auth';

/**
 * Auth state for the whole dashboard.
 *
 * The ID token is the only credential that ever leaves the browser, and it
 * goes in an Authorization header to the ingest service, which verifies it
 * against Firebase's public keys. We never send a uid — a client-asserted
 * identity is not a credential.
 *
 * A short-lived, non-httpOnly cookie mirrors "is someone signed in" purely so
 * `middleware.ts` can redirect without a flash of the wrong page. It is a
 * *navigation hint*, not authorization: nothing server-side trusts it, and
 * forging it gets you a dashboard shell whose every API call returns 401.
 */

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  configured: boolean;
  signUp(email: string, password: string, name: string): Promise<void>;
  signIn(email: string, password: string): Promise<void>;
  signInWithGoogle(): Promise<void>;
  signOut(): Promise<void>;
  getToken(): Promise<string | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function setSessionHint(active: boolean): void {
  if (typeof document === 'undefined') return;
  document.cookie = active
    ? `${SESSION_COOKIE}=1; path=/; max-age=3600; SameSite=Lax`
    : `${SESSION_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const e2e = isE2EBypassEnabled();
  const configured = e2e || isFirebaseConfigured();

  useEffect(() => {
    if (e2e) {
      // Restore the synthetic session across navigations.
      const signedIn = readE2ESignedIn();
      setUser(signedIn ? makeE2EUser() : null);
      setSessionHint(signedIn);
      setLoading(false);
      return;
    }

    if (!configured) {
      setLoading(false);
      return;
    }

    const auth = getFirebaseAuth();

    const unsubscribeAuth = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setSessionHint(Boolean(nextUser));
      setLoading(false);
    });

    // Firebase refreshes the ID token roughly hourly. Re-stamping the cookie
    // on refresh keeps the middleware hint alive for a session that is still
    // valid, rather than bouncing an active user to /login after an hour.
    const unsubscribeToken = onIdTokenChanged(auth, (nextUser) => {
      setSessionHint(Boolean(nextUser));
    });

    return () => {
      unsubscribeAuth();
      unsubscribeToken();
    };
  }, [configured, e2e]);

  const getToken = useCallback(async (): Promise<string | null> => {
    if (e2e) return E2E_TOKEN;
    if (!configured) return null;
    const current = getFirebaseAuth().currentUser;
    if (!current) return null;
    // `false` = use the cached token unless it has expired. Forcing a refresh
    // on every request would add a network round trip to every API call.
    return current.getIdToken(false);
  }, [configured, e2e]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      configured,
      async signUp(email, password, name) {
        if (e2e) return activateE2ESession();
        const credential = await createUserWithEmailAndPassword(getFirebaseAuth(), email, password);
        if (name.trim()) {
          await updateProfile(credential.user, { displayName: name.trim() });
        }
        setSessionHint(true);
      },
      async signIn(email, password) {
        if (e2e) return activateE2ESession();
        await signInWithEmailAndPassword(getFirebaseAuth(), email, password);
        setSessionHint(true);
      },
      async signInWithGoogle() {
        if (e2e) return activateE2ESession();
        await signInWithPopup(getFirebaseAuth(), googleProvider);
        setSessionHint(true);
      },
      async signOut() {
        if (e2e) {
          writeE2ESignedIn(false);
          setUser(null);
          setSessionHint(false);
          return;
        }
        await firebaseSignOut(getFirebaseAuth());
        setSessionHint(false);
      },
      getToken,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user, loading, configured, getToken, e2e],
  );

  function activateE2ESession(): void {
    writeE2ESignedIn(true);
    setUser(makeE2EUser());
    setSessionHint(true);
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return context;
}
