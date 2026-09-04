import { Schema, Types, model, models, type InferSchemaType, type Model } from 'mongoose';

const labelledCount = new Schema(
  { label: { type: String, required: true }, count: { type: Number, required: true } },
  { _id: false },
);

/**
 * One document per project per UTC day, written by the nightly rollup job.
 * Ranges longer than 30 days read from here instead of scanning raw events.
 */
const dailyRollupSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    /** UTC midnight of the day being summarised. */
    date: { type: Date, required: true },
    pageviews: { type: Number, required: true, default: 0 },
    uniqueVisitors: { type: Number, required: true, default: 0 },
    topPaths: { type: [labelledCount], default: [] },
    topReferrers: { type: [labelledCount], default: [] },
    countries: { type: [labelledCount], default: [] },
    browsers: { type: [labelledCount], default: [] },
    devices: {
      desktop: { type: Number, default: 0 },
      mobile: { type: Number, default: 0 },
      tablet: { type: Number, default: 0 },
      unknown: { type: Number, default: 0 },
    },
    /** Bookkeeping so a re-run can be recognised as a re-run in the logs. */
    generatedAt: { type: Date, required: true, default: () => new Date() },
    eventsProcessed: { type: Number, required: true, default: 0 },
  },
  { timestamps: false },
);

/**
 * Unique on (projectId, date) — this constraint is what makes the nightly job
 * idempotent: it upserts on this key, so re-running a day overwrites rather
 * than appending a second summary. Same prefix rule as Event: project first,
 * then the date range.
 */
dailyRollupSchema.index({ projectId: 1, date: 1 }, { unique: true, name: 'uniq_project_date' });

export type DailyRollupDoc = InferSchemaType<typeof dailyRollupSchema> & { _id: Types.ObjectId };

export const DailyRollup: Model<DailyRollupDoc> =
  (models.DailyRollup as Model<DailyRollupDoc>) ??
  model<DailyRollupDoc>('DailyRollup', dailyRollupSchema);
