import { Suspense } from 'react';
import type { Metadata } from 'next';
import { AuthForm } from '@/components/AuthForm';

export const metadata: Metadata = { title: 'Create an account' };

export default function SignupPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <Suspense fallback={<div className="h-96 w-full max-w-sm skeleton" />}>
        <AuthForm mode="signup" />
      </Suspense>
    </div>
  );
}
