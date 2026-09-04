import { Types } from 'mongoose';
import {
  Check,
  DailyRollup,
  Event,
  Monitor,
  Project,
  User,
  connectToDatabase,
  disconnectFromDatabase,
} from '@pulse/shared/models';
import { computeSessionId, generateApiKey, generateSlug } from '@pulse/shared/server';
import { getConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { rollupRange } from '../src/jobs/rollup.js';

const log = createLogger('seed');

/**
 * Generates ~90 days of realistic traffic so the dashboard has something to
 * show. "Realistic" matters more than "large": a flat random scatter makes
 * every chart look like noise and proves nothing about the aggregations. This
 * models the shapes real web traffic actually has —
 *
 *   - a weekly cycle (weekends are quieter),
 *   - a daily cycle (a working-hours hump),
 *   - a slow upward growth trend,
 *   - two deliberate spikes, so the chart has something to explain,
 *   - a long-tail distribution over paths, referrers and countries.
 */

const DAYS = Number(process.env.SEED_DAYS ?? 90);
const BASE_DAILY_VISITORS = Number(process.env.SEED_VISITORS ?? 220);

const PATHS: Array<[string, number]> = [
  ['/', 30],
  ['/pricing', 14],
  ['/docs', 12],
  ['/blog/introducing-pulse', 10],
  ['/features', 8],
  ['/docs/quickstart', 7],
  ['/blog/why-cookieless', 6],
  ['/changelog', 4],
  ['/about', 3],
  ['/docs/api', 3],
  ['/login', 2],
  ['/signup', 1],
];

const REFERRERS: Array<[string | null, number]> = [
  [null, 34], // direct
  ['google.com', 22],
  ['news.ycombinator.com', 12],
  ['github.com', 9],
  ['reddit.com', 7],
  ['x.com', 6],
  ['producthunt.com', 4],
  ['lobste.rs', 3],
  ['dev.to', 2],
  ['linkedin.com', 1],
];

const COUNTRIES: Array<[string, number]> = [
  ['US', 30], ['GB', 12], ['DE', 10], ['IN', 9], ['CA', 7], ['FR', 6],
  ['AU', 5], ['NL', 4], ['BR', 4], ['JP', 3], ['SE', 3], ['ES', 2], ['PL', 2], ['SG', 2],
];

const BROWSERS: Array<[string, number]> = [
  ['Chrome', 58], ['Safari', 20], ['Firefox', 9], ['Edge', 9], ['Opera', 2], ['Samsung Internet', 2],
];

const DEVICES: Array<['desktop' | 'mobile' | 'tablet', number]> = [
  ['desktop', 58], ['mobile', 36], ['tablet', 6],
];

const OSES: Array<[string, number]> = [
  ['macOS', 30], ['Windows', 32], ['iOS', 18], ['Android', 14], ['Linux', 6],
];

/** Deterministic PRNG so re-seeding produces the same demo data. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const random = makeRandom(20240904);

function weightedPick<T>(entries: Array<[T, number]>): T {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return entries[0]![0];
}

/** Visitors expected on a given day, with weekly cycle, growth and spikes. */
function visitorsForDay(dayIndex: number, totalDays: number): number {
  const date = new Date(Date.now() - (totalDays - 1 - dayIndex) * 86_400_000);
  const weekday = date.getUTCDay();

  const weekendFactor = weekday === 0 || weekday === 6 ? 0.55 : 1;
  // ~2.2x growth over the window, so the trend is visible but not absurd.
  const growthFactor = 0.7 + (1.5 * dayIndex) / totalDays;
  const noise = 0.85 + random() * 0.3;

  // Two spikes: a launch post and a smaller follow-up.
  const daysAgo = totalDays - 1 - dayIndex;
  const spikeFactor = daysAgo === 21 ? 4.2 : daysAgo === 6 ? 2.1 : 1;

  return Math.max(5, Math.round(BASE_DAILY_VISITORS * weekendFactor * growthFactor * noise * spikeFactor));
}

/** Hour-of-day weight: a working-hours hump with a long evening tail. */
const HOUR_WEIGHTS = [
  2, 1, 1, 1, 1, 2, 4, 7, 11, 14, 16, 16, 15, 16, 17, 16, 14, 12, 10, 9, 8, 6, 4, 3,
];

function pickHour(): number {
  const total = HOUR_WEIGHTS.reduce((a, b) => a + b, 0);
  let roll = random() * total;
  for (let hour = 0; hour < 24; hour++) {
    roll -= HOUR_WEIGHTS[hour]!;
    if (roll <= 0) return hour;
  }
  return 12;
}

async function main(): Promise<void> {
  const cfg = getConfig();
  await connectToDatabase();
  log.info('seeding', { days: DAYS, baseVisitors: BASE_DAILY_VISITORS });

  const email = process.env.SEED_EMAIL ?? 'demo@pulse.local';

  const user = await User.findOneAndUpdate(
    { email },
    { $setOnInsert: { firebaseUid: process.env.SEED_FIREBASE_UID ?? 'seed-demo-uid', email, name: 'Demo User' } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  const projectName = 'Acme Marketing Site';
  let project = await Project.findOne({ ownerId: user._id, name: projectName });
  if (!project) {
    project = await Project.create({
      ownerId: user._id,
      name: projectName,
      domain: 'acme.example',
      slug: generateSlug(projectName),
      apiKey: generateApiKey(),
    });
  }
  const projectId = project._id as Types.ObjectId;

  // Start clean so re-seeding is idempotent rather than cumulative.
  await Promise.all([
    Event.deleteMany({ projectId }),
    DailyRollup.deleteMany({ projectId }),
  ]);

  const startedAt = Date.now();
  let totalEvents = 0;

  for (let dayIndex = 0; dayIndex < DAYS; dayIndex++) {
    const dayStart = new Date(Date.now() - (DAYS - 1 - dayIndex) * 86_400_000);
    dayStart.setUTCHours(0, 0, 0, 0);

    const visitors = visitorsForDay(dayIndex, DAYS);
    const batch: Record<string, unknown>[] = [];

    for (let v = 0; v < visitors; v++) {
      // The session hash rotates daily, so a "visitor" is scoped to one day —
      // exactly as production behaves.
      const sessionId = computeSessionId({
        ip: `10.${Math.floor(random() * 255)}.${Math.floor(random() * 255)}.${v % 255}`,
        userAgent: `seed-agent-${v}`,
        projectId: String(projectId),
        date: dayStart,
        secret: cfg.PULSE_SESSION_SECRET,
      });

      const device = weightedPick(DEVICES);
      const browser = weightedPick(BROWSERS);
      const os = weightedPick(OSES);
      const country = weightedPick(COUNTRIES);
      const referrer = weightedPick(REFERRERS);

      // Most sessions are one page; a minority browse. Long tail, not uniform.
      const pageCount = random() < 0.55 ? 1 : random() < 0.8 ? 2 : 1 + Math.floor(random() * 6);
      const hour = pickHour();

      for (let p = 0; p < pageCount; p++) {
        const timestamp = new Date(dayStart);
        timestamp.setUTCHours(hour, Math.floor(random() * 60), Math.floor(random() * 60), 0);
        // Later pages in a session happen slightly later.
        timestamp.setUTCSeconds(timestamp.getUTCSeconds() + p * (20 + Math.floor(random() * 120)));

        const path = p === 0 ? weightedPick(PATHS) : weightedPick(PATHS);
        batch.push({
          projectId,
          type: 'pageview',
          name: path,
          path,
          // Only the first page of a session has an external referrer.
          referrer: p === 0 ? referrer : null,
          country,
          device,
          browser,
          os,
          sessionId,
          timestamp,
          meta: {},
        });
      }

      // ~4% of sessions convert; gives the custom-event path real data.
      if (random() < 0.04) {
        const timestamp = new Date(dayStart);
        timestamp.setUTCHours(hour, Math.floor(random() * 60), 0, 0);
        batch.push({
          projectId,
          type: 'custom',
          name: random() < 0.6 ? 'signup_started' : 'signup_completed',
          path: '/signup',
          referrer: null,
          country,
          device,
          browser,
          os,
          sessionId,
          timestamp,
          meta: { plan: weightedPick([['free', 6], ['pro', 3], ['team', 1]]) },
        });
      }
    }

    await Event.insertMany(batch, { ordered: false });
    totalEvents += batch.length;

    if (dayIndex % 15 === 0) {
      log.info('seeded day', { day: dayStart.toISOString().slice(0, 10), events: totalEvents });
    }
  }

  /* Monitors, with 90 days of check history so the status page and uptime
     charts have something to render. */
  const monitorSpecs = [
    { name: 'Marketing site', url: 'https://acme.example', intervalSeconds: 300, failureRate: 0.001 },
    { name: 'API', url: 'https://api.acme.example/health', intervalSeconds: 60, failureRate: 0.004 },
    { name: 'Checkout', url: 'https://acme.example/checkout', intervalSeconds: 300, failureRate: 0.012 },
  ];

  await Monitor.deleteMany({ projectId });
  for (const spec of monitorSpecs) {
    const monitor = await Monitor.create({
      projectId,
      name: spec.name,
      url: spec.url,
      intervalSeconds: spec.intervalSeconds,
      expectedStatus: 200,
      lastCheckedAt: new Date(),
      lastStatusOk: true,
    });

    await Check.deleteMany({ monitorId: monitor._id });

    // One check per interval for 30 days would be 43k documents for the 60s
    // monitor; sample every 10 minutes instead, which is plenty for the charts.
    const checks: Record<string, unknown>[] = [];
    const stepMs = 10 * 60_000;
    const historyMs = 90 * 86_400_000;
    let inIncident = 0;

    for (let t = Date.now() - historyMs; t <= Date.now(); t += stepMs) {
      // Failures cluster into incidents rather than scattering, which is what
      // makes the incident list and the uptime bars look real.
      if (inIncident > 0) {
        inIncident -= 1;
      } else if (random() < spec.failureRate) {
        inIncident = 2 + Math.floor(random() * 8);
      }

      const ok = inIncident === 0;
      const base = spec.name === 'API' ? 60 : 140;
      checks.push({
        monitorId: monitor._id,
        ok,
        statusCode: ok ? 200 : random() < 0.5 ? 502 : 500,
        latencyMs: ok
          ? Math.round(base + random() * base * 0.8 + (random() < 0.02 ? 900 : 0))
          : Math.round(1000 + random() * 4000),
        error: ok ? null : 'Expected status 200, received 502',
        timestamp: new Date(t),
      });
    }

    await Check.insertMany(checks, { ordered: false });
    log.info('seeded monitor', { name: spec.name, checks: checks.length });
  }

  /* Roll up everything except today, so the 90-day range reads real rollups
     rather than falling back to an empty result. */
  log.info('building rollups');
  const rollupStats = await rollupRange(
    new Date(Date.now() - DAYS * 86_400_000),
    new Date(Date.now() - 86_400_000),
  );

  log.info('seed complete', {
    events: totalEvents,
    days: DAYS,
    rollups: rollupStats.reduce((sum, s) => sum + s.projects, 0),
    durationMs: Date.now() - startedAt,
  });

  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      '  Seeded successfully.',
      '',
      `    Project:  ${project.name}`,
      `    API key:  ${project.apiKey}`,
      `    Status:   ${cfg.PUBLIC_APP_URL}/status/${project.slug}`,
      `    Events:   ${totalEvents.toLocaleString()} over ${DAYS} days`,
      '',
      '  Sign in with Firebase using an account whose email is:',
      `    ${email}`,
      '',
    ].join('\n'),
  );

  await disconnectFromDatabase();
}

main().catch((err) => {
  log.error('seed failed', err);
  process.exit(1);
});
