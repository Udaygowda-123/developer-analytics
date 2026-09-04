import type { Request } from 'express';

/**
 * Country comes from a CDN/proxy header, never from a GeoIP database of our own.
 *
 * Cloudflare, Vercel and Fastly all resolve the country at the edge and forward
 * it; using that avoids shipping (and licensing, and keeping current) a MaxMind
 * database, and more importantly means the raw IP never has to be retained long
 * enough to look up. We read the first header present, in order of how much we
 * trust it.
 *
 * A caller can of course forge these headers — but a forged country only
 * pollutes the forger's own project's dashboard, so it is not worth defending
 * against beyond validating the shape.
 */
const COUNTRY_HEADERS = [
  'cf-ipcountry', // Cloudflare
  'x-vercel-ip-country', // Vercel
  'fastly-client-country', // Fastly
  'x-geo-country', // generic / self-hosted proxy
] as const;

/** ISO 3166-1 alpha-2, uppercased. `XX`/`T1` (Tor) are treated as unknown. */
export function countryFromRequest(req: Request): string | null {
  for (const header of COUNTRY_HEADERS) {
    const value = req.header(header);
    if (!value) continue;
    const code = value.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(code) && code !== 'XX' && code !== 'T1') {
      return code;
    }
  }
  return null;
}

/**
 * Client IP for the session hash only — it is hashed immediately and never
 * stored. Behind a proxy, `x-forwarded-for` is a comma-separated chain; the
 * left-most entry is the original client.
 *
 * This trusts the header, which is correct *only* when the app sits behind a
 * proxy that overwrites it. `app.set('trust proxy', ...)` in index.ts is what
 * makes that assumption explicit.
 */
export function ipFromRequest(req: Request): string {
  const forwarded = req.header('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.ip ?? req.socket.remoteAddress ?? '0.0.0.0';
}

/**
 * Referrers are reduced to their origin before storage.
 *
 * A full referrer URL can carry query strings with session tokens, email
 * addresses or search terms — data we have no reason to hold and every reason
 * not to. The hostname is all the "top referrers" widget needs.
 */
export function normaliseReferrer(referrer: string | null | undefined, ownDomain: string): string | null {
  if (!referrer) return null;
  try {
    const url = new URL(referrer);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    if (!host) return null;
    // Self-referrals are internal navigation, not an acquisition source.
    if (host === ownDomain.replace(/^www\./, '').toLowerCase()) return null;
    return host;
  } catch {
    return null;
  }
}

/** Strip query and fragment: same reasoning as the referrer. */
export function normalisePath(path: string): string {
  const withoutQuery = path.split('?')[0]?.split('#')[0] ?? '/';
  const trimmed = withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, '') : withoutQuery;
  const normalised = trimmed || '/';
  return normalised.startsWith('/') ? normalised.slice(0, 2048) : `/${normalised}`.slice(0, 2048);
}
