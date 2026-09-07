'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

const SIZES: Record<Size, string> = {
  sm: 'px-2.5 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  children: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  children,
  className = '',
  ...rest
}: ButtonProps) {
  const style: Record<string, string> =
    variant === 'primary'
      ? { backgroundColor: 'var(--accent)', color: '#ffffff', borderColor: 'var(--accent)' }
      : variant === 'danger'
        ? { backgroundColor: 'transparent', color: 'var(--negative)', borderColor: 'var(--border-strong)' }
        : variant === 'ghost'
          ? { backgroundColor: 'transparent', color: 'var(--ink-muted)', borderColor: 'transparent' }
          : { backgroundColor: 'var(--surface-raised)', color: 'var(--ink)', borderColor: 'var(--border-strong)' };

  return (
    <button
      type="button"
      // `loading` also disables: a double-submitted form is the most common way
      // to create two of something the user wanted one of.
      disabled={disabled || loading}
      // Communicates the busy state to assistive tech, which cannot see a spinner.
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center gap-2 rounded-lg border font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-50 ${SIZES[size]} ${className}`}
      style={style}
      {...rest}
    >
      {loading ? (
        <span
          className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
          aria-hidden="true"
        />
      ) : null}
      {children}
    </button>
  );
}
