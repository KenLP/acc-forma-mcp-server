import { apsRequest } from '../http/client.js';
import type { AuthProvider } from '../auth/index.js';
import { addBPrefix } from '../utils/project-id.js';
import { getProjectContainerIds } from './data-management.js';

const APS_BASE = 'https://developer.api.autodesk.com';

// Cache projectId → reviews container ID to avoid redundant DM calls
const containerIdCache = new Map<string, string>();

export async function resolveReviewsContainerId(
  auth: AuthProvider,
  hubId: string,
  projectId: string,
): Promise<string> {
  const key = addBPrefix(projectId);
  const cached = containerIdCache.get(key);
  if (cached) return cached;

  const ids = await getProjectContainerIds(auth, addBPrefix(hubId), key);
  const containerId = ids['reviews'];
  if (!containerId) {
    const available = Object.keys(ids).join(', ') || 'none';
    throw new Error(
      `Reviews module not found for project ${projectId}. ` +
        `Ensure the Reviews module is activated for this ACC project. ` +
        `(Available modules: ${available})`,
    );
  }
  containerIdCache.set(key, containerId);
  return containerId;
}

// ---- Types ----------------------------------------------------------------

export type ReviewStatus =
  | 'OPEN'
  | 'IN_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'VOID';

export type ReviewTransitionAction =
  | 'SUBMIT'
  | 'APPROVE'
  | 'REJECT'
  | 'VOID'
  | 'REOPEN';

export interface Review {
  id: string;
  name: string;
  status: ReviewStatus;
  description?: string;
  dueDate?: string;
  reviewerIds?: string[];
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateReviewPayload {
  name: string;
  reviewerIds: string[];
  description?: string;
  dueDate?: string;
  /** Review workflow template ID (optional — uses project default if omitted). */
  workflowId?: string;
  /** Model version IDs to attach to the review. */
  linkedDocuments?: Array<{ versionUrn: string }>;
}

export interface TransitionPayload {
  action: ReviewTransitionAction;
  comment?: string;
}

export interface ReviewPagination {
  limit: number;
  offset: number;
  totalResults: number;
}

// ---- API calls ------------------------------------------------------------

export async function listReviews(
  auth: AuthProvider,
  hubId: string,
  projectId: string,
  params?: { limit?: number; offset?: number; status?: ReviewStatus },
): Promise<{ results: Review[]; pagination: ReviewPagination }> {
  const containerId = await resolveReviewsContainerId(auth, hubId, projectId);
  const raw = await apsRequest<{
    results?: Review[];
    data?: Review[];
    pagination?: ReviewPagination;
  }>(auth, `/construction/reviews/v1/containers/${containerId}/reviews`, {
    baseUrl: APS_BASE,
    params: params as Record<string, string | number | boolean | undefined>,
  });
  return {
    results: raw.results ?? raw.data ?? [],
    pagination: raw.pagination ?? { limit: 0, offset: 0, totalResults: 0 },
  };
}

export async function getReview(
  auth: AuthProvider,
  hubId: string,
  projectId: string,
  reviewId: string,
): Promise<Review> {
  const containerId = await resolveReviewsContainerId(auth, hubId, projectId);
  return apsRequest<Review>(
    auth,
    `/construction/reviews/v1/containers/${containerId}/reviews/${reviewId}`,
    { baseUrl: APS_BASE },
  );
}

export async function createReview(
  auth: AuthProvider,
  hubId: string,
  projectId: string,
  payload: CreateReviewPayload,
): Promise<Review> {
  const containerId = await resolveReviewsContainerId(auth, hubId, projectId);
  return apsRequest<Review>(
    auth,
    `/construction/reviews/v1/containers/${containerId}/reviews`,
    { baseUrl: APS_BASE, method: 'POST', body: payload },
  );
}

export async function transitionReview(
  auth: AuthProvider,
  hubId: string,
  projectId: string,
  reviewId: string,
  payload: TransitionPayload,
): Promise<Review> {
  const containerId = await resolveReviewsContainerId(auth, hubId, projectId);
  return apsRequest<Review>(
    auth,
    `/construction/reviews/v1/containers/${containerId}/reviews/${reviewId}/transitions`,
    { baseUrl: APS_BASE, method: 'POST', body: payload },
  );
}
