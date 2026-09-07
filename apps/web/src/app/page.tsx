import Link from 'next/link';

/**
 * Landing page. A server component — it has no interactivity and no auth
 * dependency, so there is no reason to ship it as JavaScript.
 */
export default function HomePage() {
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-4 py-5 sm:px-6">
        <span className="flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--ink)' }}>
          <span
            aria-hidden="true"
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: 'var(--accent)' }}
          />
          Pulse
        </span>
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/login" style={{ color: 'var(--ink-muted)' }}>
            Sign in
          </Link>
          <Link
            href="/signup"
            className="rounded-lg px-3 py-1.5 font-medium"
            style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
          >
            Get started
          </Link>
        </nav>
      </header>

      <main id="main" className="mx-auto max-w-5xl px-4 pb-20 pt-10 sm:px-6 sm:pt-20">
        <h1
          className="max-w-2xl text-3xl font-semibold leading-tight sm:text-5xl"
          style={{ color: 'var(--ink)' }}
        >
          Analytics and uptime monitoring that respect your visitors.
        </h1>
        <p className="mt-4 max-w-xl text-base leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
          One 2&nbsp;KB script, no cookies, no consent banner. Watch traffic in real time, and get
          told the moment something goes down — not two hundred times after.
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/signup"
            className="rounded-lg px-4 py-2.5 text-sm font-medium"
            style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
          >
            Create a free project
          </Link>
          <Link
            href="/login"
            className="rounded-lg border px-4 py-2.5 text-sm font-medium"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--ink)' }}
          >
            Sign in
          </Link>
        </div>

        <dl className="mt-16 grid gap-6 sm:grid-cols-3">
          {[
            {
              term: 'Cookieless by design',
              detail:
                'Visitors are identified by a daily-rotating hash that never stores an IP address. Nothing is written to their device.',
            },
            {
              term: 'Built to absorb traffic',
              detail:
                'Events are buffered in memory and written in batches of 500, so ingestion never waits on the database.',
            },
            {
              term: 'Alerting you will not mute',
              detail:
                'Three consecutive failures before we email you, and at most one alert per monitor per hour.',
            },
          ].map((item) => (
            <div key={item.term}>
              <dt className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
                {item.term}
              </dt>
              <dd className="mt-1.5 text-sm leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
                {item.detail}
              </dd>
            </div>
          ))}
        </dl>
      </main>
    </div>
  );
}
