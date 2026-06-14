import { apsRequest } from '../http/client.js';
import type { AuthProvider } from '../auth/index.js';
import { stripBPrefix } from '../utils/project-id.js';

const APS_BASE = 'https://developer.api.autodesk.com';

// ---- Types ----------------------------------------------------------------

export interface IssueSubtype {
  id: string;
  title: string;
  /** APS returns isActive per subtype; inactive subtypes are rejected by POST /issues. */
  isActive: boolean;
}

export interface IssueType {
  id: string;
  title: string;
  subtypes: IssueSubtype[];
}

export interface Issue {
  id: string;
  displayId?: number;
  title: string;
  status: string;
  issueTypeId: string;
  issueSubtypeId: string;
  assignedTo?: string;
  assignedToType?: 'user' | 'company' | 'role';
  dueDate?: string;
  startDate?: string;
  description?: string;
  createdBy?: string;
  createdAt?: string;
  updatedBy?: string;
  updatedAt?: string;
  closedBy?: string;
  closedAt?: string;
  locationId?: string;
  subLocationId?: string;
  rootCauseId?: string;
  published?: boolean;
  linkedDocuments?: LinkedDocument[];
  customAttributes?: Array<{ attributeDefinitionId: string; value: unknown }>;
  /** Only returned by GET /issues/{id} — what fields the caller may PATCH. */
  permittedAttributes?: string[];
  /** Only returned by GET /issues/{id} — valid status transitions from current state. */
  permittedStatuses?: string[];
}

export interface RootCause {
  id: string;
  title: string;
  rootCauses: Array<{ id: string; title: string }>;
}

/**
 * Pushpin / model element link on an issue. Field shape matches APS POST
 * /construction/issues/v1/.../issues `linkedDocuments[]`. Inner field names
 * are camelCase to match the API contract 1:1 (so callers can forward
 * Forma Viewer state verbatim without renaming keys).
 */
export interface LinkedDocument {
  /** 'TwoDVectorPushpin' for sheets/2D, 'ThreeDVectorPushpin' for 3D models. */
  type: 'TwoDVectorPushpin' | 'ThreeDVectorPushpin';
  /** Document lineage URN (item URN) of the file the pin attaches to. */
  urn: string;
  /** Version of the document the pin was created against. */
  createdAtVersion?: number;
  details?: {
    viewable?: {
      guid: string;
      name?: string;
      is3D?: boolean;
      viewableId?: string;
    };
    /** 3D point in viewer coordinates. */
    position?: { x: number; y: number; z: number };
    /** Forma Viewer dbId of the element the pin is anchored to. */
    objectId?: number;
    /** Opaque viewer camera/section state passthrough. */
    viewerState?: Record<string, unknown>;
  };
}

export interface CreateIssuePayload {
  title: string;
  issueSubtypeId: string;
  status?: string;
  description?: string;
  assignedTo?: string;
  /** Required when assignedTo is set: 'user' | 'company' | 'role' */
  assignedToType?: 'user' | 'company' | 'role';
  dueDate?: string;
  locationId?: string;
  rootCauseId?: string;
  /** Whether the issue is visible to all project members (false = draft). */
  published?: boolean;
  /** Pushpin links to model documents/elements. Enables the "View in Model" deep link. */
  linkedDocuments?: LinkedDocument[];
  customAttributes?: Array<{ attributeDefinitionId: string; value: unknown }>;
}

// ---- API calls ------------------------------------------------------------

export async function listIssueTypes(
  auth: AuthProvider,
  projectId: string,
): Promise<IssueType[]> {
  const pid = stripBPrefix(projectId);
  const data = await apsRequest<{
    results: Array<{
      id: string;
      title: string;
      subtypes: Array<{ id: string; title: string; isActive?: boolean }>;
    }>;
  }>(auth, `/construction/issues/v1/projects/${pid}/issue-types?include=subtypes`, {
    baseUrl: APS_BASE,
  });
  return (data.results ?? []).map((t) => ({
    id: t.id,
    title: t.title,
    subtypes: (t.subtypes ?? []).map((s) => ({
      id: s.id,
      title: s.title,
      // Default to true when APS omits the field, so legacy responses don't break create.
      isActive: s.isActive ?? true,
    })),
  }));
}

export async function listIssues(
  auth: AuthProvider,
  projectId: string,
  params?: {
    limit?: number;
    offset?: number;
    status?: string;
    assignedTo?: string;
  },
): Promise<{ results: Issue[]; pagination: { totalResults: number; limit: number; offset: number } }> {
  const pid = stripBPrefix(projectId);
  return apsRequest(
    auth,
    `/construction/issues/v1/projects/${pid}/issues`,
    {
      baseUrl: APS_BASE,
      params: params as Record<string, string | number | boolean | undefined>,
    },
  );
}

export async function getIssue(
  auth: AuthProvider,
  projectId: string,
  issueId: string,
): Promise<Issue> {
  const pid = stripBPrefix(projectId);
  return apsRequest<Issue>(auth, `/construction/issues/v1/projects/${pid}/issues/${issueId}`, {
    baseUrl: APS_BASE,
  });
}

export async function createIssue(
  auth: AuthProvider,
  projectId: string,
  payload: CreateIssuePayload,
): Promise<Issue> {
  const pid = stripBPrefix(projectId);
  return apsRequest<Issue>(auth, `/construction/issues/v1/projects/${pid}/issues`, {
    baseUrl: APS_BASE,
    method: 'POST',
    body: payload,
  });
}

export async function listRootCauses(
  auth: AuthProvider,
  projectId: string,
): Promise<RootCause[]> {
  const pid = stripBPrefix(projectId);
  const data = await apsRequest<{ results: RootCause[] }>(
    auth,
    `/construction/issues/v1/projects/${pid}/root-cause-categories`,
    { baseUrl: APS_BASE },
  );
  return data.results ?? [];
}

export interface UpdateIssuePayload {
  title?: string;
  description?: string;
  status?: string;
  issueSubtypeId?: string;
  assignedTo?: string;
  assignedToType?: 'user' | 'company' | 'role';
  dueDate?: string;
  startDate?: string;
  locationId?: string;
  subLocationId?: string;
  rootCauseId?: string;
  customAttributes?: Array<{ attributeDefinitionId: string; value: unknown }>;
}

export async function updateIssue(
  auth: AuthProvider,
  projectId: string,
  issueId: string,
  payload: UpdateIssuePayload,
): Promise<Issue> {
  const pid = stripBPrefix(projectId);
  return apsRequest<Issue>(
    auth,
    `/construction/issues/v1/projects/${pid}/issues/${issueId}`,
    { baseUrl: APS_BASE, method: 'PATCH', body: payload },
  );
}

export interface IssueComment {
  id: string;
  body: string;
  createdBy?: string;
  createdAt?: string;
  updatedBy?: string;
  updatedAt?: string;
}

export async function listIssueComments(
  auth: AuthProvider,
  projectId: string,
  issueId: string,
  params?: { limit?: number; offset?: number },
): Promise<{ results: IssueComment[]; pagination: { totalResults: number; limit: number; offset: number } }> {
  const pid = stripBPrefix(projectId);
  return apsRequest(
    auth,
    `/construction/issues/v1/projects/${pid}/issues/${issueId}/comments`,
    { baseUrl: APS_BASE, params: params as Record<string, string | number | undefined> },
  );
}

export async function addIssueComment(
  auth: AuthProvider,
  projectId: string,
  issueId: string,
  body: string,
): Promise<IssueComment> {
  const pid = stripBPrefix(projectId);
  return apsRequest<IssueComment>(
    auth,
    `/construction/issues/v1/projects/${pid}/issues/${issueId}/comments`,
    { baseUrl: APS_BASE, method: 'POST', body: { body } },
  );
}

// ---- Users / permissions ----------------------------------------------------

export interface IssueUserProfile {
  id?: string;
  name?: string;
  email?: string;
  /** Whether this identity can create issues in the project. */
  canCreateIssues?: boolean;
  /** Whether this identity can update issues in the project. */
  canUpdateIssues?: boolean;
  /** Whether this identity can add comments. */
  canCreateComments?: boolean;
}

export async function getIssueUserMe(
  auth: AuthProvider,
  projectId: string,
): Promise<IssueUserProfile> {
  const pid = stripBPrefix(projectId);
  return apsRequest<IssueUserProfile>(
    auth,
    `/construction/issues/v1/projects/${pid}/users/me`,
    { baseUrl: APS_BASE },
  );
}

// ---- Custom attribute definitions -------------------------------------------

export interface IssueAttrDefinition {
  id: string;
  title: string;
  type: string;
  dataType?: string;
  description?: string;
  /** Allowed values for enum-type attributes. */
  metadata?: { list?: Array<{ id: string; value: string }> };
}

export async function listIssueAttrs(
  auth: AuthProvider,
  projectId: string,
): Promise<IssueAttrDefinition[]> {
  const pid = stripBPrefix(projectId);
  const data = await apsRequest<{ results: IssueAttrDefinition[] }>(
    auth,
    `/construction/issues/v1/projects/${pid}/issues/attrs`,
    { baseUrl: APS_BASE },
  );
  return data.results ?? [];
}

// ---- Attachments ------------------------------------------------------------

export interface IssueAttachment {
  id: string;
  name?: string;
  urn?: string;
  /** 'dm' = Data Management file, 'url' = external URL */
  attachmentType?: string;
  createdBy?: string;
  createdAt?: string;
}

export async function listIssueAttachments(
  auth: AuthProvider,
  projectId: string,
  issueId: string,
  params?: { limit?: number; offset?: number },
): Promise<{ results: IssueAttachment[]; pagination: { totalResults: number; limit: number; offset: number } }> {
  const pid = stripBPrefix(projectId);
  return apsRequest(
    auth,
    `/construction/issues/v1/projects/${pid}/issues/${issueId}/attachments`,
    { baseUrl: APS_BASE, params: params as Record<string, string | number | undefined> },
  );
}
