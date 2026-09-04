import { Types } from 'mongoose';
import { Event, Project, User, type ProjectDoc } from '@pulse/shared/models';
import { generateApiKey, generateSlug } from '@pulse/shared/server';
import type { HydratedDocument } from 'mongoose';

/** Deterministic seed data so assertions can be exact rather than approximate. */

export async function createTestUser(overrides: Partial<{ email: string; firebaseUid: string }> = {}) {
  return User.create({
    firebaseUid: overrides.firebaseUid ?? `uid-${new Types.ObjectId().toHexString()}`,
    email: overrides.email ?? `user-${Date.now()}-${Math.random()}@example.com`,
    name: 'Test User',
  });
}

export async function createTestProject(
  ownerId: Types.ObjectId,
  overrides: Partial<{ name: string; domain: string }> = {},
): Promise<HydratedDocument<ProjectDoc>> {
  const name = overrides.name ?? 'Test Project';
  return Project.create({
    ownerId,
    name,
    domain: overrides.domain ?? 'example.com',
    slug: generateSlug(name),
    apiKey: generateApiKey(),
  });
}

export interface EventSpec {
  projectId: Types.ObjectId;
  timestamp: Date;
  sessionId?: string;
  path?: string;
  type?: 'pageview' | 'custom';
  referrer?: string | null;
  country?: string | null;
  device?: 'desktop' | 'mobile' | 'tablet' | null;
  browser?: string | null;
  name?: string;
}

export async function insertEvents(specs: EventSpec[]): Promise<void> {
  await Event.insertMany(
    specs.map((s) => ({
      projectId: s.projectId,
      type: s.type ?? 'pageview',
      name: s.name ?? s.path ?? '/',
      path: s.path ?? '/',
      referrer: s.referrer ?? null,
      country: s.country ?? null,
      // `in` rather than `??` so a spec can express an explicit null (an
      // unknown device) instead of having it silently defaulted to desktop.
      device: 'device' in s ? s.device : 'desktop',
      browser: 'browser' in s ? s.browser : 'Chrome',
      os: 'macOS',
      sessionId: s.sessionId ?? 'session-default',
      timestamp: s.timestamp,
      meta: {},
    })),
    { ordered: false },
  );
}

/** `n` pageviews spread evenly across the given window. */
export function spreadEvents(
  projectId: Types.ObjectId,
  from: Date,
  to: Date,
  count: number,
  overrides: Partial<EventSpec> = {},
): EventSpec[] {
  const span = to.getTime() - from.getTime();
  return Array.from({ length: count }, (_, i) => ({
    projectId,
    timestamp: new Date(from.getTime() + Math.floor((span * i) / count)),
    ...overrides,
  }));
}
