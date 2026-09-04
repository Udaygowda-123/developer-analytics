import { Schema, Types, model, models, type InferSchemaType, type Model } from 'mongoose';

const projectSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true },
    /** URL-safe identifier used by the public status page route. */
    slug: { type: String, required: true, lowercase: true, trim: true },
    domain: { type: String, required: true, lowercase: true, trim: true },
    /** Always prefixed `pk_live_`. Generated server-side, never client-chosen. */
    apiKey: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: true } },
);

// /collect resolves an API key to a project on *every* request. Unique index
// keeps that a sub-millisecond point lookup, and the uniqueness constraint is
// what makes an API key safe to treat as a credential.
projectSchema.index({ apiKey: 1 }, { unique: true, name: 'uniq_apiKey' });
projectSchema.index({ slug: 1 }, { unique: true, name: 'uniq_slug' });
// Listing "my projects" on the dashboard home.
projectSchema.index({ ownerId: 1, createdAt: -1 }, { name: 'owner_recent' });

export type ProjectDoc = InferSchemaType<typeof projectSchema> & { _id: Types.ObjectId };

export const Project: Model<ProjectDoc> =
  (models.Project as Model<ProjectDoc>) ?? model<ProjectDoc>('Project', projectSchema);
