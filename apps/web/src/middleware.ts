import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from './lib/constants';

/**
 * Route protection — a *navigation* concern, not an authorization one.
 *
 * This only reads a non-httpOnly hint cookie set by the client after Firebase
 * sign-in, and its entire job is to avoid rendering the dashboard shell for
 * someone who is obviously signed out (and vice versa). Forging the cookie
 * gets you an empty shell whose every API call returns 401, because the real
 * check is the Firebase ID token verified server-side in `apps/ingest`.
 *
 * Verifying the token here instead would mean running firebase-admin in the
 * Edge runtime and holding service-account credentials in the web app — a
 * larger attack surface for a redirect.
 */

const PROTECTED_PREFIXES = ['/projects'];
const AUTH_ROUTES = ['/login', '/signup'];

export function middleware(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const hasSession = request.cookies.get(SESSION_COOKIE)?.value === '1';

  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

  if (isProtected && !hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    // Preserve where they were headed so sign-in can return them there.
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  if (AUTH_ROUTES.includes(pathname) && hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = '/projects';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  /*
   * Skip Next internals, static files and the public status pages. Status
   * pages must stay reachable without auth — running middleware on them would
   * only add latency to the page most likely to be hit during an incident.
   */
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|status|.*\\.).*)'],
};
