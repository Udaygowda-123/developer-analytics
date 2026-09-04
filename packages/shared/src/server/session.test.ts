import { describe, expect, it } from 'vitest';
import { computeSessionId, sessionDateKey } from './session.js';
import { API_KEY_PREFIX, generateApiKey, generateSlug, maskApiKey } from './apiKey.js';

const base = {
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0',
  projectId: '65f0000000000000000000aa',
  secret: 'test-secret',
  date: new Date('2024-06-15T12:00:00Z'),
};

describe('sessionDateKey', () => {
  it('is the UTC calendar day', () => {
    expect(sessionDateKey(new Date('2024-06-15T23:59:59Z'))).toBe('2024-06-15');
    expect(sessionDateKey(new Date('2024-06-16T00:00:00Z'))).toBe('2024-06-16');
  });
});

describe('computeSessionId', () => {
  it('is deterministic for the same visitor within a day', () => {
    const a = computeSessionId(base);
    const b = computeSessionId({ ...base, date: new Date('2024-06-15T23:00:00Z') });
    expect(a).toBe(b);
  });

  it('rotates at the UTC day boundary', () => {
    const today = computeSessionId(base);
    const tomorrow = computeSessionId({ ...base, date: new Date('2024-06-16T00:00:01Z') });
    expect(tomorrow).not.toBe(today);
  });

  it('differs per project, so visitors cannot be correlated across customers', () => {
    const a = computeSessionId(base);
    const b = computeSessionId({ ...base, projectId: '65f0000000000000000000bb' });
    expect(a).not.toBe(b);
  });

  it('differs per IP and per user agent', () => {
    expect(computeSessionId({ ...base, ip: '198.51.100.1' })).not.toBe(computeSessionId(base));
    expect(computeSessionId({ ...base, userAgent: 'curl/8.4.0' })).not.toBe(computeSessionId(base));
  });

  it('changes entirely when the secret is rotated', () => {
    expect(computeSessionId({ ...base, secret: 'other-secret' })).not.toBe(computeSessionId(base));
  });

  it('cannot be confused by shifting the delimiter between fields', () => {
    // Without an unambiguous delimiter, ("1.2.3.4|x", "ua") and ("1.2.3.4", "x|ua")
    // would hash identically. The UA's pipes are normalised away, so they must not.
    const a = computeSessionId({ ...base, ip: '1.2.3.4', userAgent: 'x|Mozilla' });
    const b = computeSessionId({ ...base, ip: '1.2.3.4', userAgent: 'x/Mozilla' });
    // Pipes are rewritten to slashes, so these two *do* collide by design;
    // what must hold is that no UA can inject a field boundary.
    expect(a).toBe(b);
    expect(computeSessionId({ ...base, ip: '1.2.3.4|x', userAgent: 'Mozilla' })).not.toBe(a);
  });

  it('contains no trace of the raw inputs', () => {
    const id = computeSessionId(base);
    expect(id).not.toContain('203.0.113');
    expect(id).not.toContain('Mozilla');
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('refuses to run without a secret', () => {
    expect(() => computeSessionId({ ...base, secret: '' })).toThrow(/PULSE_SESSION_SECRET/);
  });
});

describe('generateApiKey', () => {
  it('produces a prefixed 40-character key', () => {
    const key = generateApiKey();
    expect(key).toMatch(/^pk_live_[A-Za-z0-9]{32}$/);
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
  });

  it('avoids visually ambiguous characters', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateApiKey().slice(API_KEY_PREFIX.length)).not.toMatch(/[0O1lI]/);
    }
  });

  it('does not repeat', () => {
    const keys = new Set(Array.from({ length: 500 }, generateApiKey));
    expect(keys.size).toBe(500);
  });
});

describe('maskApiKey', () => {
  it('shows only the first and last four characters of the body', () => {
    expect(maskApiKey('pk_live_ABCDefgh23456789ABCDefgh23456789')).toBe('pk_live_ABCD…6789');
  });

  it('reveals nothing for a malformed key', () => {
    expect(maskApiKey('nonsense')).toBe('••••');
  });
});

describe('generateSlug', () => {
  it('slugifies and suffixes', () => {
    expect(generateSlug('My Cool Site')).toMatch(/^my-cool-site-[0-9a-f]{6}$/);
  });

  it('strips accents', () => {
    expect(generateSlug('Café Ünïcode')).toMatch(/^cafe-unicode-[0-9a-f]{6}$/);
  });

  it('falls back for names with no usable characters', () => {
    expect(generateSlug('!!!')).toMatch(/^project-[0-9a-f]{6}$/);
  });
});
