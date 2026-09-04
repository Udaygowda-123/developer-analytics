import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '@pulse/shared';
import { Project, User, type ProjectDoc, type UserDoc } from '@pulse/shared/models';
import type { HydratedDocument, Types } from 'mongoose';
import { getTokenVerifier } from '../firebase.js';
import { createLogger } from '../logger.js';
import { asyncHandler } from './errorHandler.js';

const log = createLogger('auth');

export interface AuthedRequest extends Request {
  auth: {
    firebaseUid: string;
    email: string;
    user: HydratedDocument<UserDoc>;
  };
}

export interface ProjectRequest extends AuthedRequest {
  project: HydratedDocument<ProjectDoc>;
}

function extractBearerToken(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token.trim() || null;
}

/**
 * Verifies a Firebase ID token **server-side** and resolves it to our own User.
 *
 * The client sends only the signed token. We never read a uid, email or user id
 * from the request body or from a header — a client-supplied uid is an
 * assertion, not a credential, and trusting one would let any caller act as any
 * user by typing their id.
 */
export const requireAuth = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const token = extractBearerToken(req);
  if (!token) {
    throw ApiError.unauthorized('Missing Authorization: Bearer <firebase-id-token>');
  }

  let decoded;
  try {
    decoded = await getTokenVerifier().verify(token);
  } catch (err) {
    // Distinguish "your token expired, refresh it" from "this token is not
    // ours", because the client handles them differently.
    const code = (err as { code?: string }).code ?? '';
    if (code.includes('id-token-expired') || code.includes('id-token-revoked')) {
      throw new ApiError(401, 'unauthorized', 'Session expired, please sign in again', {
        cause: err,
      });
    }
    log.warn('token verification failed', { code });
    throw new ApiError(401, 'unauthorized', 'Invalid authentication token', { cause: err });
  }

  if (!decoded.email) {
    throw ApiError.forbidden('This account has no email address');
  }

  // Upsert on first sight: the dashboard creates the Firebase account, and the
  // first authenticated API call materialises our User row. `setOnInsert` keeps
  // a later name change in our DB from being clobbered on every request.
  const user = await User.findOneAndUpdate(
    { firebaseUid: decoded.uid },
    {
      $set: { email: decoded.email.toLowerCase() },
      $setOnInsert: {
        firebaseUid: decoded.uid,
        name: decoded.name ?? decoded.email.split('@')[0] ?? '',
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  (req as AuthedRequest).auth = {
    firebaseUid: decoded.uid,
    email: decoded.email.toLowerCase(),
    user,
  };
  next();
});

/**
 * Loads `:projectId` and asserts the authenticated user owns it.
 *
 * Ownership is checked in the *query*, not after the fetch — so a wrong id is
 * indistinguishable from someone else's id, and we never leak the existence of
 * another tenant's project through a 403-vs-404 difference.
 */
export const requireProjectAccess = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const authed = req as AuthedRequest;
    const projectId = req.params.projectId ?? '';
    if (!/^[a-f\d]{24}$/i.test(projectId)) {
      throw ApiError.notFound('Project not found');
    }

    const project = await Project.findOne({
      _id: projectId,
      ownerId: authed.auth.user._id as Types.ObjectId,
    });
    if (!project) {
      throw ApiError.notFound('Project not found');
    }

    (req as ProjectRequest).project = project;
    next();
  },
);
