import { createHmac } from 'node:crypto';

/**
 * Cookieless, daily-rotating session identity.
 *
 * sessionId = HMAC-SHA256(secret, ip | userAgent | projectId | YYYY-MM-DD)
 *
 * Why this shape:
 *
 * - **No cookie, no localStorage.** Nothing is written to the visitor's device,
 *   so the snippet needs no consent banner under the ePrivacy "strictly
 *   necessary" carve-out, and there is nothing for another site to read.
 *
 * - **The raw IP is never stored.** It goes into the HMAC and is discarded; the
 *   Event document holds only the digest. A dump of our database therefore
 *   contains no IP addresses and no user agents.
 *
 * - **The date component makes it rotate.** The same visitor on the same
 *   network gets a different `sessionId` tomorrow, so identifiers cannot be
 *   chained into a long-term profile. This is also why "unique visitors" is
 *   really "unique visitors per day" — a deliberate accuracy-for-privacy trade,
 *   and the reason we do not claim cross-day uniqueness anywhere in the UI.
 *
 * - **The projectId component scopes it.** The same person visiting two
 *   different customers' sites hashes to two unrelated values, so no customer
 *   can correlate visitors with another, and neither can we.
 *
 * - **HMAC, not a bare hash.** The input space (IPv4 × common UA strings) is
 *   small enough to brute-force offline. With a server-side secret that the
 *   database never contains, a leaked Event collection cannot be reversed to
 *   recover who visited. Rotating `PULSE_SESSION_SECRET` invalidates all
 *   existing identifiers, which is the intended emergency lever.
 *
 * The cost of all this is that a visitor switching networks mid-day counts
 * twice, and two people behind one NAT with identical user agents count once.
 * For product analytics that error is acceptable; for anything requiring exact
 * identity it would not be, and this is the wrong tool.
 */

export interface SessionHashInput {
  ip: string;
  userAgent: string;
  projectId: string;
  /** Injected so callers (and tests) control the rotation boundary explicitly. */
  date: Date;
  secret: string;
}

/** `YYYY-MM-DD` in UTC — the rotation bucket. */
export function sessionDateKey(date: Date): string {
  const iso = date.toISOString();
  // ISO is always `YYYY-MM-DDTHH:...`; slicing is faster than re-formatting and
  // there is no locale involved, so it is safe.
  return iso.slice(0, 10);
}

export function computeSessionId({
  ip,
  userAgent,
  projectId,
  date,
  secret,
}: SessionHashInput): string {
  if (!secret) {
    throw new Error('PULSE_SESSION_SECRET is required to derive session identifiers');
  }
  // `|` cannot appear in an IP or an ObjectId, and we normalise it out of the
  // UA, so the delimiter is unambiguous — without that, ("a|b", "c") and
  // ("a", "b|c") would collide.
  const material = [
    ip.trim(),
    userAgent.replace(/\|/g, '/').slice(0, 512),
    projectId,
    sessionDateKey(date),
  ].join('|');

  return createHmac('sha256', secret).update(material).digest('base64url').slice(0, 22);
}
