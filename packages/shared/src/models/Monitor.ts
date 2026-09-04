import { Schema, Types, model, models, type InferSchemaType, type Model } from 'mongoose';
import { MONITOR_INTERVALS } from '../types.js';

const monitorSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    name: { type: String, required: true, trim: true },
    url: { type: String, required: true, trim: true },
    intervalSeconds: {
      type: Number,
      required: true,
      enum: MONITOR_INTERVALS as unknown as number[],
      default: 300,
    },
    expectedStatus: { type: Number, required: true, default: 200 },
    isPaused: { type: Boolean, required: true, default: false },
    /** Reset to 0 on any successful check; alert fires at 3. */
    consecutiveFailures: { type: Number, required: true, default: 0 },
    lastCheckedAt: { type: Date, default: null },
    lastNotifiedAt: { type: Date, default: null },
    /** Mirrors the last check's `ok` so status pages need no extra lookup. */
    lastStatusOk: { type: Boolean, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: true } },
);

// Listing monitors for a project's dashboard.
monitorSchema.index({ projectId: 1, createdAt: 1 }, { name: 'project_monitors' });

/**
 * The scheduler's due-query runs every 30 seconds across all tenants:
 *   { isPaused: false, lastCheckedAt: { $lte: <cutoff> } }
 * `isPaused` is an equality prefix, `lastCheckedAt` the range — same prefix
 * reasoning as the Event index. Ascending on lastCheckedAt so the oldest (most
 * overdue) monitors sort first for free.
 */
monitorSchema.index({ isPaused: 1, lastCheckedAt: 1 }, { name: 'due_for_check' });

export type MonitorDoc = InferSchemaType<typeof monitorSchema> & { _id: Types.ObjectId };

export const Monitor: Model<MonitorDoc> =
  (models.Monitor as Model<MonitorDoc>) ?? model<MonitorDoc>('Monitor', monitorSchema);
