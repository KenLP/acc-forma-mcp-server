import { DataManagementClient } from '@aps_sdk/data-management';
import type { AuthProvider } from '../auth/index.js';

/** Minimal adapter to make our AuthProvider compatible with APS SDK */
function toSdkAuth(auth: AuthProvider): { getAccessToken(): Promise<string> } {
  return { getAccessToken: (): Promise<string> => auth.getAccessToken() };
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
  const resp = await client.getHubs();
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
  const resp = await client.getHubProjects(hubId);
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
  const resp = await client.getProjectTopFolders(hubId, projectId);
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
  const resp = await client.getItem(projectId, itemId);
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
  const resp = await client.getItemVersions(projectId, itemId);
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
  const resp = await client.getProject(hubId, projectId);
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
  const resp = await client.getFolderContents(projectId, folderId);
  return (resp.data ?? []).map((item) => ({
    id: item.id ?? '',
    name: item.attributes?.displayName ?? '',
    type: item.type,
  }));
}
