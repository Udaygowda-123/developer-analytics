import type { Metadata, Viewport } from 'next';
import { AuthProvider } from '@/lib/auth-context';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Pulse — privacy-friendly analytics and uptime monitoring',
    template: '%s · Pulse',
  },
  description:
    'Self-hostable web analytics and uptime monitoring. Cookieless, no consent banner, one lightweight script.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Never `maximumScale: 1` — it disables pinch zoom, which people with low
  // vision rely on and which iOS Safari honours to the letter.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0b0f19' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* First tab stop on every page: lets keyboard users skip the nav
            rather than tabbing through it on each navigation. */}
        <a
          href="#main"
          className="sr-only-focusable absolute left-4 top-4 z-50 rounded-lg px-3 py-2 text-sm font-medium"
          style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
        >
          Skip to main content
        </a>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
