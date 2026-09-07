'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';
import { useAuth } from '@/lib/auth-context';
import { describeAuthError } from '@/lib/firebase';
import { Button } from '@/components/ui/Button';

/**
 * Sign-in and sign-up share this component: the fields differ by one, and
 * keeping the error handling, the Google button and the redirect logic in one
 * place is what stops the two forms drifting apart.
 */
export function AuthForm({ mode }: { mode: 'signin' | 'signup' }) {
  const { signIn, signUp, signInWithGoogle, configured } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const ids = { email: useId(), password: useId(), name: useId(), error: useId() };

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<'form' | 'google' | null>(null);

  // Only accept a same-origin relative path: an open redirect on a login form
  // is a phishing primitive.
  const rawNext = searchParams.get('next');
  const next = rawNext && rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/projects';

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending('form');
    try {
      if (mode === 'signup') {
        await signUp(email, password, name);
      } else {
        await signIn(email, password);
      }
      router.push(next);
    } catch (err) {
      setError(describeAuthError(err));
      setPending(null);
    }
  }

  async function handleGoogle() {
    setError(null);
    setPending('google');
    try {
      await signInWithGoogle();
      router.push(next);
    } catch (err) {
      setError(describeAuthError(err));
      setPending(null);
    }
  }

  const inputClass =
    'w-full rounded-lg border px-3 py-2 text-sm outline-none transition-colors';
  const inputStyle = {
    backgroundColor: 'var(--surface)',
    borderColor: 'var(--border-strong)',
    color: 'var(--ink)',
  };

  return (
    <div className="w-full max-w-sm">
      <div className="mb-6 text-center">
        <h1 className="text-xl font-semibold" style={{ color: 'var(--ink)' }}>
          {mode === 'signup' ? 'Create your account' : 'Sign in to Pulse'}
        </h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--ink-subtle)' }}>
          {mode === 'signup'
            ? 'Start collecting privacy-friendly analytics in minutes.'
            : 'Welcome back.'}
        </p>
      </div>

      {!configured ? (
        <div
          role="alert"
          className="mb-4 rounded-lg border px-3 py-2 text-xs"
          style={{ borderColor: 'var(--warning)', color: 'var(--warning)' }}
        >
          Firebase is not configured. Set the <code>NEXT_PUBLIC_FIREBASE_*</code> variables in{' '}
          <code>.env</code> — see <code>.env.example</code>.
        </div>
      ) : null}

      <form onSubmit={handleSubmit} className="space-y-3" noValidate>
        {mode === 'signup' ? (
          <div>
            <label htmlFor={ids.name} className="mb-1 block text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
              Name
            </label>
            <input
              id={ids.name}
              type="text"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
              style={inputStyle}
              placeholder="Ada Lovelace"
            />
          </div>
        ) : null}

        <div>
          <label htmlFor={ids.email} className="mb-1 block text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
            Email
          </label>
          <input
            id={ids.email}
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            // Points assistive tech at the error message when one is showing.
            aria-describedby={error ? ids.error : undefined}
            aria-invalid={error ? true : undefined}
            className={inputClass}
            style={inputStyle}
            placeholder="you@example.com"
          />
        </div>

        <div>
          <label htmlFor={ids.password} className="mb-1 block text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
            Password
          </label>
          <input
            id={ids.password}
            type="password"
            required
            minLength={6}
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-describedby={error ? ids.error : undefined}
            className={inputClass}
            style={inputStyle}
            placeholder="••••••••"
          />
        </div>

        {error ? (
          <p id={ids.error} role="alert" className="text-xs" style={{ color: 'var(--negative)' }}>
            {error}
          </p>
        ) : null}

        <Button type="submit" className="w-full" loading={pending === 'form'} disabled={!configured}>
          {mode === 'signup' ? 'Create account' : 'Sign in'}
        </Button>
      </form>

      <div className="my-4 flex items-center gap-3" aria-hidden="true">
        <span className="h-px flex-1" style={{ backgroundColor: 'var(--border)' }} />
        <span className="text-xs" style={{ color: 'var(--ink-subtle)' }}>
          or
        </span>
        <span className="h-px flex-1" style={{ backgroundColor: 'var(--border)' }} />
      </div>

      <Button
        variant="secondary"
        className="w-full"
        onClick={handleGoogle}
        loading={pending === 'google'}
        disabled={!configured}
      >
        Continue with Google
      </Button>

      <p className="mt-6 text-center text-xs" style={{ color: 'var(--ink-subtle)' }}>
        {mode === 'signup' ? 'Already have an account? ' : "Don't have an account? "}
        <Link
          href={mode === 'signup' ? '/login' : '/signup'}
          className="font-medium underline"
          style={{ color: 'var(--accent)' }}
        >
          {mode === 'signup' ? 'Sign in' : 'Sign up'}
        </Link>
      </p>
    </div>
  );
}
