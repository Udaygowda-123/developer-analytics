import { Project } from '@pulse/shared/models';
import { createLogger } from '../logger.js';

const log = createLogger('ingest:projectcache');

/**
 * API key → project resolution, cached in process.
 *
 * Without this, buffering the *writes* would be pointless: every `/collect`
 * request would still do a database round trip to resolve its key, so the hot
 * path would remain latency-bound and the connection pool would still be the
 * bottleneck. Caching turns key resolution into a Map lookup.
 *
 * Deliberately in-process rather than in Redis: it is a tiny, read-mostly,
 * eventually-consistent lookup, and a local Map has no network cost at all.
 * Each instance holds its own copy, so a revoked key can remain usable for up
 * to `ttlMs` on instances that already cached it — 60 seconds of exposure on a
 * key that is being rotated anyway. `invalidate()` is called when a project is
 * deleted so the common case is immediate on the instance handling the request.
 *
 * Negative results are cached too, and for longer: an invalid key is usually a
 * misconfigured snippet retrying forever, and without negative caching every
 * one of those requests would be a database query.
 */

export interface CachedProject {
  id: string;
  domain: string;
}

interface Entry {
  value: CachedProject | null;
  expiresAt: number;
}

export class ProjectCache {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly negativeTtlMs: number;
  private readonly maxEntries: number;
  private hits = 0;
  private misses = 0;

  constructor(options: { ttlMs?: number; negativeTtlMs?: number; maxEntries?: number } = {}) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.negativeTtlMs = options.negativeTtlMs ?? 300_000;
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  async resolve(apiKey: string): Promise<CachedProject | null> {
    const now = Date.now();
    const cached = this.entries.get(apiKey);
    if (cached && cached.expiresAt > now) {
      this.hits += 1;
      return cached.value;
    }

    this.misses += 1;
    const project = await Project.findOne({ apiKey }, { _id: 1, domain: 1 }).lean();
    const value: CachedProject | null = project
      ? { id: String(project._id), domain: String(project.domain ?? '') }
      : null;

    this.set(apiKey, value, now + (value ? this.ttlMs : this.negativeTtlMs));
    return value;
  }

  private set(apiKey: string, value: CachedProject | null, expiresAt: number): void {
    if (this.entries.size >= this.maxEntries) {
      // Cheap eviction: drop the oldest insertion. Map preserves insertion
      // order, so this is FIFO rather than true LRU — adequate here because the
      // working set is "keys currently sending traffic", which is stable.
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(apiKey, { value, expiresAt });
  }

  invalidate(apiKey: string): void {
    this.entries.delete(apiKey);
    log.debug('cache entry invalidated');
  }

  clear(): void {
    this.entries.clear();
  }

  getStats(): { size: number; hits: number; misses: number; hitRate: number } {
    const total = this.hits + this.misses;
    return {
      size: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : Math.round((this.hits / total) * 1000) / 10,
    };
  }
}
