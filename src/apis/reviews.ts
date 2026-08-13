import { apsRequest } from '../http/client.js';
import type { AuthProvider } from '../auth/index.js';
import { stripBPrefix } from '../utils/project-id.js';

const APS_BASE = 'https://developer.api.autodesk.com';

/**
 * Reviews is addressed by project id directly — `/construction/reviews/v1/projects/{pid}/…`
 * — exactly like Issues, and unlike what this module used to assume.
 *
 * It previously resolved a "reviews" container from the Data Management project
 * relationships payload and called `/containers/{id}/…`. Neither half was right: that
 * payload has no `reviews` key (live response carries hub, rootFolder, issues, submittals,
 * rfis, markups, cost, locations), so every call failed at resolution with "Reviews module
 * not found" — and even given a container id, `/containers/{id}/reviews` answers 404 for
 * every id shape. Verified 2026-08-13 against the live API: `/projects/{raw uuid}/reviews`
 * and `/projects/{b.-prefixed}/reviews` both return 200 with real data. Raw uuid is used
 * here for consistency with the other project-scoped clients.
 */
function reviewsRoot(projectId: string): string {
  return `/construction/reviews/v1/projects/${stripBPrefix(projectId)}`;
}

// ---- Types ----------------------------------------------------------------

export type ReviewStatus =
  | 'OPEN'
  | 'IN_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'VOID';

/** One file version submitted into a review. `urn` must be a versioned file URN (`…?version=N`). */
export interface ReviewFileVersion {
  urn: string;
}

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

/**
 * The exact body `POST /projects/{pid}/reviews` accepts — all three fields required, and
 * nothing else permitted (the API answers "data should NOT have additional properties").
 * Notably there is no reviewer list: approvers come from the workflow definition's steps,
 * which is why `workflowId` is mandatory rather than optional. Contract confirmed field by
 * field against the live validator on 2026-08-13.
 */
export interface CreateReviewPayload {
  name: string;
  workflowId: string;
  /** At least one — the API rejects an empty array. */
  fileVersions: ReviewFileVersion[];
}

export interface ReviewPagination {
  limit: number;
  offset: number;
  totalResults: number;
}

// ---- API calls ------------------------------------------------------------

export async function listReviews(
  auth: AuthProvider,
  projectId: string,
  params?: { limit?: number; offset?: number; status?: ReviewStatus },
): Promise<{ results: Review[]; pagination: ReviewPagination }> {
  const raw = await apsRequest<{
    results?: Review[];
    data?: Review[];
    pagination?: ReviewPagination;
  }>(auth, `${reviewsRoot(projectId)}/reviews`, {
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
  projectId: string,
  reviewId: string,
): Promise<Review> {
  return apsRequest<Review>(auth, `${reviewsRoot(projectId)}/reviews/${reviewId}`, {
    baseUrl: APS_BASE,
  });
}

export async function createReview(
  auth: AuthProvider,
  projectId: string,
  payload: CreateReviewPayload,
): Promise<Review> {
  return apsRequest<Review>(auth, `${reviewsRoot(projectId)}/reviews`, {
    baseUrl: APS_BASE,
    method: 'POST',
    body: payload,
  });
}

/** Approval workflow definitions for a project — the `workflowId` a review is created against. */
export async function listWorkflows(
  auth: AuthProvider,
  projectId: string,
): Promise<{ results: Array<{ id: string; name: string; status?: string }> }> {
  const raw = await apsRequest<{ results?: Array<{ id: string; name: string; status?: string }> }>(
    auth,
    `${reviewsRoot(projectId)}/workflows`,
    { baseUrl: APS_BASE },
  );
  return { results: raw.results ?? [] };
}
