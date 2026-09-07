import { Suspense } from 'react';
import type { Metadata } from 'next';
import { AuthForm } from '@/components/AuthForm';

export const metadata: Metadata = { title: 'Sign in' };

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      {/* AuthForm reads useSearchParams, which needs a Suspense boundary so the
          rest of the page can still be statically rendered. */}
      <Suspense fallback={<div className="h-96 w-full max-w-sm skeleton" />}>
        <AuthForm mode="signin" />
      </Suspense>
    </div>
  );
}
