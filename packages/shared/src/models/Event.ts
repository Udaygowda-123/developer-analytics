import { Schema, Types, model, models, type InferSchemaType, type Model } from 'mongoose';
import { DEVICE_TYPES, EVENT_TYPES } from '../types.js';

/**
 * The hot collection. Everything about this schema is chosen for write
 * throughput first and one specific read pattern second.
 */
const eventSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    type: { type: String, enum: EVENT_TYPES, required: true, default: 'pageview' },
    name: { type: String, required: true, trim: true },
    path: { type: String, required: true },
    referrer: { type: String, default: null },
    country: { type: String, default: null },
    device: { type: String, enum: [...DEVICE_TYPES, null], default: null },
    browser: { type: String, default: null },
    os: { type: String, default: null },
    /**
     * Cookieless, daily-rotating hash — see `src/server/session.ts`. Treated as
     * an opaque bucket key, never as a stable identifier for a person.
     */
    sessionId: { type: String, required: true },
    timestamp: { type: Date, required: true, default: () => new Date() },
    meta: { type: Schema.Types.Mixed, default: () => ({}) },
  },
  {
    // No `updatedAt`: events are immutable, and a second date field per
    // document is pure write amplification on the collection we write most.
    timestamps: false,
    minimize: true,
  },
);

/**
 * THE load-bearing index. Field order matters, and it is not interchangeable:
 *
 *   { projectId: 1, timestamp: -1 }
 *
 * MongoDB can only use a compound index as a *prefix*. Every analytics read is
 * scoped to exactly one project and then to a time window:
 *
 *   { projectId: <id>, timestamp: { $gte: from, $lt: to } }
 *
 * With projectId first, the equality predicate selects one contiguous region of
 * the index, and the range predicate then walks a contiguous run *inside* that
 * region — so the number of index entries examined is proportional to the rows
 * we actually return. That is what makes a 90-day dashboard query on a
 * many-tenant collection cheap.
 *
 * Reversed (`{ timestamp: -1, projectId: 1 }`) the range comes first, so Mongo
 * would scan every event from every project in the window and filter projectId
 * afterwards — work proportional to total traffic, not to this tenant's. On a
 * shared ingestion pipeline that is the difference between a 5 ms and a 5 s
 * dashboard.
 *
 * The `-1` on timestamp matches our sort direction (newest first), letting the
 * index also satisfy the sort without an in-memory SORT stage. Note a
 * single-field direction on the *last* key is not strictly required — Mongo can
 * walk an index backwards — but keeping it aligned documents the intent and
 * keeps compound sorts (`projectId asc, timestamp desc`) index-covered.
 */
eventSchema.index({ projectId: 1, timestamp: -1 }, { name: 'project_time' });

/**
 * Unique-visitor counts are `$addToSet`/`$group` over sessionId inside a
 * project+range. Adding sessionId as a suffix lets that grouping read from the
 * index rather than fetching documents.
 */
eventSchema.index({ projectId: 1, timestamp: -1, sessionId: 1 }, { name: 'project_time_session' });

/**
 * Retention (Phase 6) deletes by age across all projects, which the
 * project-prefixed indexes above cannot serve. A TTL index would be simpler,
 * but it would delete events *before* the nightly rollup had a chance to read
 * them if the job ever failed — so retention is an explicit, logged job and
 * this index just makes its range delete cheap.
 */
eventSchema.index({ timestamp: 1 }, { name: 'timestamp_retention' });

export type EventDoc = InferSchemaType<typeof eventSchema> & { _id: Types.ObjectId };

export const Event: Model<EventDoc> =
  (models.Event as Model<EventDoc>) ?? model<EventDoc>('Event', eventSchema);
