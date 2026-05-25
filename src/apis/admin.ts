import { apsRequest } from '../http/client.js';
import type { AuthProvider } from '../auth/index.js';
import { stripBPrefix } from '../utils/project-id.js';

const APS_BASE = 'https://developer.api.autodesk.com';

// ---- Types ----------------------------------------------------------------

export interface AdminProject {
  id: string;
  name: string;
  status: string;
  type?: string;
  startDate?: string;
  endDate?: string;
  jobNumber?: string;
  addressLine1?: string;
  city?: string;
  country?: string;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  firstName?: string;
  lastName?: string;
  roleId?: string;
  roleName?: string;
  status: string;
  companyId?: string;
  companyName?: string;
}

export interface AdminCompany {
  id: string;
  name: string;
  tradeType?: string;
  city?: string;
  country?: string;
  websiteUrl?: string;
}

export interface AdminPagination {
  limit: number;
  offset: number;
  totalResults: number;
}

// ---- API calls ------------------------------------------------------------

export async function adminListProjects(
  auth: AuthProvider,
  hubId: string,
  params?: { limit?: number; offset?: number; status?: string },
): Promise<{ results: AdminProject[]; pagination: AdminPagination }> {
  const accountId = stripBPrefix(hubId);
  const raw = await apsRequest<{
    results?: AdminProject[];
    data?: AdminProject[];
    pagination?: AdminPagination;
  }>(auth, `/hq/v1/accounts/${accountId}/projects`, {
    baseUrl: APS_BASE,
    params: params as Record<string, string | number | boolean | undefined>,
  });
  return {
    results: raw.results ?? raw.data ?? [],
    pagination: raw.pagination ?? { limit: 0, offset: 0, totalResults: 0 },
  };
}

export async function adminGetProject(
  auth: AuthProvider,
  hubId: string,
  projectId: string,
): Promise<AdminProject> {
  const accountId = stripBPrefix(hubId);
  const pid = stripBPrefix(projectId);
  return apsRequest<AdminProject>(
    auth,
    `/hq/v1/accounts/${accountId}/projects/${pid}`,
    { baseUrl: APS_BASE },
  );
}

export async function adminListUsers(
  auth: AuthProvider,
  hubId: string,
  params?: { limit?: number; offset?: number },
): Promise<{ results: AdminUser[]; pagination: AdminPagination }> {
  const accountId = stripBPrefix(hubId);
  const raw = await apsRequest<{
    results?: AdminUser[];
    data?: AdminUser[];
    pagination?: AdminPagination;
  }>(auth, `/hq/v1/accounts/${accountId}/users`, {
    baseUrl: APS_BASE,
    params: params as Record<string, string | number | boolean | undefined>,
  });
  return {
    results: raw.results ?? raw.data ?? [],
    pagination: raw.pagination ?? { limit: 0, offset: 0, totalResults: 0 },
  };
}

export async function adminListCompanies(
  auth: AuthProvider,
  hubId: string,
  params?: { limit?: number; offset?: number },
): Promise<{ results: AdminCompany[]; pagination: AdminPagination }> {
  const accountId = stripBPrefix(hubId);
  const raw = await apsRequest<{
    results?: AdminCompany[];
    data?: AdminCompany[];
    pagination?: AdminPagination;
  }>(auth, `/hq/v1/accounts/${accountId}/companies`, {
    baseUrl: APS_BASE,
    params: params as Record<string, string | number | boolean | undefined>,
  });
  return {
    results: raw.results ?? raw.data ?? [],
    pagination: raw.pagination ?? { limit: 0, offset: 0, totalResults: 0 },
  };
}
