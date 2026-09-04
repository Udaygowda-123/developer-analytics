import type { DeviceType } from '@pulse/shared';

/**
 * Minimal User-Agent parsing.
 *
 * Deliberately hand-rolled rather than pulling in a UA database: this runs on
 * every ingested event, the full databases are megabytes of regexes, and we
 * only need four coarse buckets for a dashboard. Precision beyond
 * "Chrome / macOS / desktop" has no effect on any decision this product
 * supports, and a heavier parser would make it easier — not harder — to
 * fingerprint a visitor.
 *
 * Order matters throughout: several browsers impersonate others in their UA
 * string (Edge contains "Chrome", Chrome contains "Safari"), so the most
 * specific token must be tested first.
 */

export interface ParsedUserAgent {
  device: DeviceType | null;
  browser: string | null;
  os: string | null;
  isBot: boolean;
}

const BOT_PATTERN =
  /(bot|crawl|spider|slurp|bingpreview|facebookexternalhit|headlesschrome|lighthouse|pingdom|uptimerobot|curl\/|wget\/|python-requests|axios\/|go-http-client|node-fetch)/i;

const BROWSERS: Array<[RegExp, string]> = [
  [/edg(?:e|a|ios)?\//i, 'Edge'],
  [/opr\/|opera/i, 'Opera'],
  [/samsungbrowser/i, 'Samsung Internet'],
  [/firefox\/|fxios\//i, 'Firefox'],
  [/chrome\/|crios\//i, 'Chrome'],
  [/safari\//i, 'Safari'],
  [/msie |trident\//i, 'Internet Explorer'],
];

const OPERATING_SYSTEMS: Array<[RegExp, string]> = [
  // iPadOS 13+ reports "Macintosh", so iOS-specific tokens must lose to the
  // tablet detection below but still win over macOS here.
  [/iphone|ipod/i, 'iOS'],
  [/ipad/i, 'iPadOS'],
  [/android/i, 'Android'],
  [/cros/i, 'ChromeOS'],
  [/windows nt/i, 'Windows'],
  [/mac os x|macintosh/i, 'macOS'],
  [/linux/i, 'Linux'],
];

const TABLET_PATTERN = /ipad|tablet|playbook|silk|(android(?!.*mobile))/i;
const MOBILE_PATTERN = /mobile|iphone|ipod|android|blackberry|iemobile|opera mini|windows phone/i;

/**
 * `screenWidth` is only a tiebreaker for the ambiguous case (an iPad that
 * reports itself as a Mac). It is never the primary signal, because it is
 * trivially spoofable and varies with window size.
 */
export function parseUserAgent(
  userAgent: string | undefined,
  screenWidth?: number | null,
): ParsedUserAgent {
  if (!userAgent) {
    return { device: null, browser: null, os: null, isBot: false };
  }

  const ua = userAgent.slice(0, 512);

  if (BOT_PATTERN.test(ua)) {
    return { device: null, browser: null, os: null, isBot: true };
  }

  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1] ?? null;
  const os = OPERATING_SYSTEMS.find(([re]) => re.test(ua))?.[1] ?? null;

  let device: DeviceType;
  if (TABLET_PATTERN.test(ua)) {
    device = 'tablet';
  } else if (MOBILE_PATTERN.test(ua)) {
    device = 'mobile';
  } else if (os === 'macOS' && browser === 'Safari' && screenWidth != null && screenWidth <= 1024) {
    // Desktop-mode iPad: claims to be a Mac, but no Mac ships a <=1024px screen.
    //
    // Gated on the *resolved* browser, not on the UA containing "safari" —
    // Chrome's UA ends with "Safari/537.36", so a regex here would reclassify
    // every narrow Chrome window on a Mac as a tablet.
    device = 'tablet';
  } else {
    device = 'desktop';
  }

  return { device, browser, os, isBot: false };
}
