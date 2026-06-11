import { DataManagementClient } from '@aps_sdk/data-management';
import type { AuthProvider } from '../auth/index.js';
import { ApsApiError } from '../http/errors.js';
import { addBPrefix } from '../utils/project-id.js';

/** Minimal adapter to make our AuthProvider compatible with APS SDK */
function toSdkAuth(auth: AuthProvider): { getAccessToken(): Promise<string> } {
  return { getAccessToken: (): Promise<string> => auth.getAccessToken() };
}

/**
 * Wrap APS SDK calls so their errors are normalized to ApsApiError.
 * The SDK throws its own error types that would otherwise be classified as
 * unexpected errors in _wrap.ts instead of the correct 'failed_api' stage.
 *
 * Known limitation: unlike apsRequest() in http/client.ts, these SDK calls
 * do not get automatic retry/backoff for 429 or 5xx responses. Transient
 * failures will surface immediately as ApsApiError to the caller.
 */
async function callSdk<T>(fn: () => Promise<T>, method: string, path: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApsApiError) throw err;
    const e = err as Record<string, unknown>;
    const status = (e['status'] ?? e['statusCode'] ?? 500) as number;
    const message = err instanceof Error ? err.message : String(err);
    throw new ApsApiError(status, method, path, message);
  }
}

export interface ApsHub {
  id: string;
  name: string;
  region: string;
  type: string;
}

export interface ApsProject {
  id: string;
  name: string;
  type: string;
  status?: string;
}

export interface ApsFolder {
  id: string;
  name: string;
  type: 'folders' | 'items';
  objectCount?: number;
}

export interface ApsItem {
  id: string;
  name: string;
  type: string;
  hidden: boolean;
  tipVersionId?: string;
}

export interface ApsVersion {
  id: string;
  name: string;
  versionNumber: number;
  createTime?: string;
  lastModifiedTime?: string;
  storageSize?: number;
  fileType?: string;
}

export async function listHubs(auth: AuthProvider): Promise<ApsHub[]> {
  const client = new DataManagementClient({ authenticationProvider: toSdkAuth(auth) });
  const resp = await callSdk(() => client.getHubs(), 'GET', '/project/v1/hubs');
  return (resp.data ?? []).map((h) => ({
    id: h.id ?? '',
    name: h.attributes?.name ?? '',
    region: h.attributes?.region ?? '',
    type: h.attributes?.extension?.type ?? '',
  }));
}

export async function listProjects(
  auth: AuthProvider,
  hubId: string,
): Promise<ApsProject[]> {
  const client = new DataManagementClient({ authenticationProvider: toSdkAuth(auth) });
  const resp = await callSdk(() => client.getHubProjects(addBPrefix(hubId)), 'GET', `/project/v1/hubs/${addBPrefix(hubId)}/projects`);
  return (resp.data ?? []).map((p) => {
    const status = p.attributes?.extension?.data?.projectType as string | undefined;
    return {
      id: p.id ?? '',
      name: p.attributes?.name ?? '',
      type: p.attributes?.extension?.type ?? '',
      ...(status !== undefined ? { status } : {}),
    };
  });
}

export async function listTopFolders(
  auth: AuthProvider,
  hubId: string,
  projectId: string,
): Promise<ApsFolder[]> {
  const client = new DataManagementClient({ authenticationProvider: toSdkAuth(auth) });
  const resp = await callSdk(() => client.getProjectTopFolders(addBPrefix(hubId), addBPrefix(projectId)), 'GET', `/project/v1/hubs/${addBPrefix(hubId)}/projects/${addBPrefix(projectId)}/topFolders`);
  return (resp.data ?? []).map((f) => ({
    id: f.id ?? '',
    name: f.attributes?.displayName ?? f.attributes?.name ?? '',
    type: f.type,
    objectCount: f.attributes?.objectCount,
  }));
}

export async function getItem(
  auth: AuthProvider,
  projectId: string,
  itemId: string,
): Promise<ApsItem> {
  const client = new DataManagementClient({ authenticationProvider: toSdkAuth(auth) });
  const resp = await callSdk(() => client.getItem(addBPrefix(projectId), itemId), 'GET', `/data/v1/projects/${addBPrefix(projectId)}/items/${itemId}`);
  const item = resp.data;
  return {
    id: item?.id ?? '',
    name: item?.attributes?.displayName ?? '',
    type: item?.type ?? '',
    hidden: (item?.attributes as unknown as Record<string, unknown>)?.['hidden'] === true,
    ...(item?.relationships?.tip?.data?.id
      ? { tipVersionId: item.relationships.tip.data.id }
      : {}),
  };
}

export async function listItemVersions(
  auth: AuthProvider,
  projectId: string,
  itemId: string,
): Promise<ApsVersion[]> {
  const client = new DataManagementClient({ authenticationProvider: toSdkAuth(auth) });
  const resp = await callSdk(() => client.getItemVersions(addBPrefix(projectId), itemId), 'GET', `/data/v1/projects/${addBPrefix(projectId)}/items/${itemId}/versions`);
  return (resp.data ?? []).map((v) => ({
    id: v.id ?? '',
    name: v.attributes?.name ?? '',
    versionNumber: (v.attributes as unknown as Record<string, unknown>)?.['versionNumber'] as number ?? 0,
    ...(v.attributes?.createTime ? { createTime: String(v.attributes.createTime) } : {}),
    ...(v.attributes?.lastModifiedTime
      ? { lastModifiedTime: String(v.attributes.lastModifiedTime) }
      : {}),
    ...(v.attributes?.storageSize !== undefined
      ? { storageSize: v.attributes.storageSize }
      : {}),
    ...(v.attributes?.fileType ? { fileType: String(v.attributes.fileType) } : {}),
  }));
}

/**
 * Fetches the container IDs for ACC modules (reviews, issues, etc.)
 * from the DM project relationship map.
 */
export async function getProjectContainerIds(
  auth: AuthProvider,
  hubId: string,
  projectId: string,
): Promise<Record<string, string>> {
  const client = new DataManagementClient({ authenticationProvider: toSdkAuth(auth) });
  const resp = await callSdk(() => client.getProject(addBPrefix(hubId), addBPrefix(projectId)), 'GET', `/project/v1/hubs/${addBPrefix(hubId)}/projects/${addBPrefix(projectId)}`);
  const relationships = (resp.data?.relationships ?? {}) as Record<
    string,
    { data?: { id?: string } }
  >;
  const ids: Record<string, string> = {};
  for (const [key, rel] of Object.entries(relationships)) {
    if (rel?.data?.id) ids[key] = rel.data.id;
  }
  return ids;
}

export async function listFolderContents(
  auth: AuthProvider,
  projectId: string,
  folderId: string,
): Promise<ApsFolder[]> {
  const client = new DataManagementClient({ authenticationProvider: toSdkAuth(auth) });
  const resp = await callSdk(() => client.getFolderContents(addBPrefix(projectId), folderId), 'GET', `/data/v1/projects/${addBPrefix(projectId)}/folders/${folderId}/contents`);
  return (resp.data ?? []).map((item) => ({
    id: item.id ?? '',
    name: item.attributes?.displayName ?? '',
    type: item.type,
  }));
}
