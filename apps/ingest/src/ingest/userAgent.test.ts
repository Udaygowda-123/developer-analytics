import { describe, expect, it } from 'vitest';
import { parseUserAgent } from './userAgent.js';
import { normalisePath, normaliseReferrer } from './geo.js';

const UA = {
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
  ipad:
    'Mozilla/5.0 (iPad; CPU OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
  androidPhone:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  androidTablet:
    'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  curl: 'curl/8.4.0',
};

describe('browser detection', () => {
  it('does not mistake Edge for Chrome', () => {
    // Edge's UA contains "Chrome/120", so a naive check reports Chrome.
    expect(parseUserAgent(UA.edgeWindows).browser).toBe('Edge');
  });

  it('does not mistake Chrome for Safari', () => {
    // Chrome's UA ends with "Safari/537.36".
    expect(parseUserAgent(UA.chromeMac).browser).toBe('Chrome');
  });

  it('identifies real Safari', () => {
    expect(parseUserAgent(UA.safariMac).browser).toBe('Safari');
  });

  it('identifies Firefox', () => {
    expect(parseUserAgent(UA.firefoxLinux).browser).toBe('Firefox');
  });
});

describe('OS detection', () => {
  it.each([
    [UA.chromeMac, 'macOS'],
    [UA.edgeWindows, 'Windows'],
    [UA.firefoxLinux, 'Linux'],
    [UA.iphone, 'iOS'],
    [UA.ipad, 'iPadOS'],
    [UA.androidPhone, 'Android'],
  ])('parses %s', (ua, expected) => {
    expect(parseUserAgent(ua).os).toBe(expected);
  });

  it('prefers Android over the Linux token it also contains', () => {
    expect(parseUserAgent(UA.androidPhone).os).toBe('Android');
  });
});

describe('device classification', () => {
  it('classifies desktop browsers', () => {
    expect(parseUserAgent(UA.chromeMac).device).toBe('desktop');
    expect(parseUserAgent(UA.edgeWindows).device).toBe('desktop');
  });

  it('classifies phones', () => {
    expect(parseUserAgent(UA.iphone).device).toBe('mobile');
    expect(parseUserAgent(UA.androidPhone).device).toBe('mobile');
  });

  it('classifies tablets', () => {
    expect(parseUserAgent(UA.ipad).device).toBe('tablet');
  });

  it('treats an Android without "Mobile" as a tablet', () => {
    // Android's convention: tablets omit the "Mobile" token.
    expect(parseUserAgent(UA.androidTablet).device).toBe('tablet');
  });

  it('uses screen width to catch an iPad claiming to be a Mac', () => {
    // iPadOS 13+ in desktop mode is indistinguishable from a Mac by UA alone.
    expect(parseUserAgent(UA.safariMac, 820).device).toBe('tablet');
    expect(parseUserAgent(UA.safariMac, 2560).device).toBe('desktop');
    // Width alone must not override an explicit desktop signal from Chrome.
    expect(parseUserAgent(UA.chromeMac, 800).device).toBe('desktop');
  });
});

describe('bot detection', () => {
  it('flags crawlers and CLI tools', () => {
    expect(parseUserAgent(UA.googlebot).isBot).toBe(true);
    expect(parseUserAgent(UA.curl).isBot).toBe(true);
    expect(parseUserAgent('python-requests/2.31.0').isBot).toBe(true);
  });

  it('does not flag real browsers', () => {
    for (const ua of [UA.chromeMac, UA.safariMac, UA.iphone, UA.firefoxLinux]) {
      expect(parseUserAgent(ua).isBot).toBe(false);
    }
  });
});

describe('missing user agent', () => {
  it('returns nulls rather than guessing', () => {
    expect(parseUserAgent(undefined)).toEqual({
      device: null,
      browser: null,
      os: null,
      isBot: false,
    });
  });
});

describe('normalisePath', () => {
  it('strips query strings and fragments, which can carry personal data', () => {
    expect(normalisePath('/checkout?token=abc123&email=a@b.com')).toBe('/checkout');
    expect(normalisePath('/docs#section-2')).toBe('/docs');
  });

  it('strips a trailing slash but keeps the root', () => {
    expect(normalisePath('/pricing/')).toBe('/pricing');
    expect(normalisePath('/')).toBe('/');
  });

  it('forces a leading slash', () => {
    expect(normalisePath('pricing')).toBe('/pricing');
  });

  it('caps the length', () => {
    expect(normalisePath(`/${'a'.repeat(5000)}`).length).toBeLessThanOrEqual(2048);
  });
});

describe('normaliseReferrer', () => {
  it('reduces a full URL to its hostname', () => {
    expect(normaliseReferrer('https://news.ycombinator.com/item?id=1', 'example.com')).toBe(
      'news.ycombinator.com',
    );
  });

  it('drops the www prefix', () => {
    expect(normaliseReferrer('https://www.google.com/search?q=secret', 'example.com')).toBe(
      'google.com',
    );
  });

  it('discards self-referrals, which are internal navigation not acquisition', () => {
    expect(normaliseReferrer('https://example.com/about', 'example.com')).toBeNull();
    expect(normaliseReferrer('https://www.example.com/about', 'example.com')).toBeNull();
  });

  it('returns null for absent or malformed referrers', () => {
    expect(normaliseReferrer(null, 'example.com')).toBeNull();
    expect(normaliseReferrer('', 'example.com')).toBeNull();
    expect(normaliseReferrer('not a url', 'example.com')).toBeNull();
  });

  it('never retains the query string', () => {
    const result = normaliseReferrer(
      'https://mail.google.com/?session=abc&user=someone@example.com',
      'example.com',
    );
    expect(result).toBe('mail.google.com');
    expect(result).not.toContain('session');
  });
});
