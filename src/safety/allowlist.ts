import { env } from '../config/env.js';
import { normalizeProjectId } from '../utils/project-id.js';

export class AllowlistError extends Error {
  constructor(kind: 'hub' | 'project', id: string, customMessage?: string) {
    super(
      customMessage ??
        `${kind} "${id}" is not in the FORMA_ALLOWED_${kind.toUpperCase()}S allow-list. ` +
          `Add it to the env var or set FORMA_ALLOWED_${kind.toUpperCase()}S=* to permit all (not recommended for production).`,
    );
    this.name = 'AllowlistError';
  }
}

function parseList(envValue: string): Set<string> {
  if (envValue.trim() === '*') return new Set(['*']);
  return new Set(
    envValue
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

// Parsed once at startup
const allowedHubs = parseList(env.FORMA_ALLOWED_HUBS);
const allowedProjects = parseList(env.FORMA_ALLOWED_PROJECTS);

export function isHubAllowed(hubId: string): boolean {
  if (allowedHubs.has('*')) return true;
  const { withPrefix, bare } = normalizeProjectId(hubId);
  return allowedHubs.has(withPrefix) || allowedHubs.has(bare);
}

export function isProjectAllowed(projectId: string): boolean {
  if (allowedProjects.has('*')) return true;
  const { withPrefix, bare } = normalizeProjectId(projectId);
  return allowedProjects.has(withPrefix) || allowedProjects.has(bare);
}

export function checkHubAllowed(hubId: string): void {
  if (!isHubAllowed(hubId)) throw new AllowlistError('hub', hubId);
}

export function checkProjectAllowed(projectId: string): void {
  if (!isProjectAllowed(projectId)) throw new AllowlistError('project', projectId);
}

/** True when either allow-list narrows the server to a subset of hubs/projects. */
export function isAllowlistActive(): boolean {
  return !(allowedHubs.has('*') && allowedProjects.has('*'));
}

/**
 * True when the PROJECT allow-list specifically narrows the server to a subset of
 * projects. Narrower than isAllowlistActive(): a tool that only ever filters by
 * isProjectAllowed (e.g. admin_list_projects) must not degrade its response just because
 * FORMA_ALLOWED_HUBS is narrowed while FORMA_ALLOWED_PROJECTS is still '*' — nothing it
 * does is actually filtered in that case.
 */
export function isProjectAllowlistActive(): boolean {
  return !allowedProjects.has('*');
}

/**
 * Guard for tools whose input id cannot be mapped back to a DM hub/project — an
 * AECDM-native id, or a Model Derivative URN (whose endpoints are not project-scoped, so
 * the URN alone reaches any model the credential can see). While an allow-list is active
 * we cannot prove the resource is inside it, so the only honest answer is to refuse:
 * proceeding would silently bypass the control the manifest promises.
 */
export function checkUnmappableToolAllowed(toolName: string, resource: string): void {
  if (!isAllowlistActive()) return;
  throw new AllowlistError(
    'project',
    toolName,
    `Tool "${toolName}" acts on a ${resource}, which cannot be mapped to a Data Management hub or ` +
      `project id and therefore cannot be checked against FORMA_ALLOWED_HUBS / FORMA_ALLOWED_PROJECTS. ` +
      `While either allow-list is active this tool is refused rather than allowed through unchecked. ` +
      `Set both allow-lists to * to enable it, or use a project-scoped tool instead.`,
  );
}
