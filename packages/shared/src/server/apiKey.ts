import { randomBytes } from 'node:crypto';

/** Ambiguity-free alphabet: no 0/O or 1/l/I, so a key can be read aloud. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const KEY_BODY_LENGTH = 32;
export const API_KEY_PREFIX = 'pk_live_';

/**
 * 32 characters from a 56-symbol alphabet ≈ 186 bits of entropy — far beyond
 * guessable, and the fixed prefix lets secret scanners recognise a leaked key.
 *
 * `randomBytes` is rejection-sampled rather than taken mod 56: a plain modulo
 * would make the first 8 symbols slightly more likely, which is exactly the
 * kind of quiet bias that makes a credential weaker than its length suggests.
 */
export function generateApiKey(): string {
  let out = '';
  while (out.length < KEY_BODY_LENGTH) {
    const buf = randomBytes(KEY_BODY_LENGTH);
    for (const byte of buf) {
      // 256 = 4*56 + 32; discard the unbalanced tail.
      if (byte >= 224) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === KEY_BODY_LENGTH) break;
    }
  }
  return API_KEY_PREFIX + out;
}

/** Display form for the dashboard: `pk_live_abcd…wxyz`. */
export function maskApiKey(key: string): string {
  if (!key.startsWith(API_KEY_PREFIX)) return '••••';
  const body = key.slice(API_KEY_PREFIX.length);
  return `${API_KEY_PREFIX}${body.slice(0, 4)}…${body.slice(-4)}`;
}

/** URL-safe slug for public status pages, with a random suffix to avoid collisions. */
export function generateSlug(name: string): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      // Strip the combining marks NFKD just split off, so "Café" -> "cafe".
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'project';
  const suffix = randomBytes(3).toString('hex');
  return `${base}-${suffix}`;
}
