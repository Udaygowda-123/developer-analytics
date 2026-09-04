import { Schema, model, models, type InferSchemaType, type Model } from 'mongoose';

const userSchema = new Schema(
  {
    /**
     * The Firebase `uid` from a *server-verified* ID token. Never populated
     * from a client-supplied field — see `apps/ingest/src/middleware/auth.ts`.
     */
    firebaseUid: { type: String, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: true } },
);

// Every request from an authenticated user starts by resolving uid -> User,
// so this lookup has to be a single index hit.
userSchema.index({ firebaseUid: 1 }, { unique: true, name: 'uniq_firebaseUid' });
userSchema.index({ email: 1 }, { unique: true, name: 'uniq_email' });

export type UserDoc = InferSchemaType<typeof userSchema>;

export const User: Model<UserDoc> =
  (models.User as Model<UserDoc>) ?? model<UserDoc>('User', userSchema);
