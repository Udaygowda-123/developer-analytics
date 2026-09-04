import { Schema, Types, model, models, type InferSchemaType, type Model } from 'mongoose';

const checkSchema = new Schema(
  {
    monitorId: { type: Schema.Types.ObjectId, ref: 'Monitor', required: true },
    /** Null when the request never completed (DNS failure, timeout, reset). */
    statusCode: { type: Number, default: null },
    latencyMs: { type: Number, required: true },
    ok: { type: Boolean, required: true },
    error: { type: String, default: null },
    timestamp: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: false },
);

/**
 * Same prefix rule as Event: uptime maths and latency charts are always
 * "one monitor, one time window", so the equality key leads and the range key
 * follows. Descending timestamp matches the "most recent check" lookup that
 * every status page does.
 */
checkSchema.index({ monitorId: 1, timestamp: -1 }, { name: 'monitor_time' });

export type CheckDoc = InferSchemaType<typeof checkSchema> & { _id: Types.ObjectId };

export const Check: Model<CheckDoc> =
  (models.Check as Model<CheckDoc>) ?? model<CheckDoc>('Check', checkSchema);
