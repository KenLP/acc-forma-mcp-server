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

export function checkHubAllowed(hubId: string): void {
  if (allowedHubs.has('*')) return;
  const { withPrefix, bare } = normalizeProjectId(hubId);
  if (!allowedHubs.has(withPrefix) && !allowedHubs.has(bare)) {
    throw new AllowlistError('hub', hubId);
  }
}

export function checkProjectAllowed(projectId: string): void {
  if (allowedProjects.has('*')) return;
  const { withPrefix, bare } = normalizeProjectId(projectId);
  if (!allowedProjects.has(withPrefix) && !allowedProjects.has(bare)) {
    throw new AllowlistError('project', projectId);
  }
}

/**
 * Guard for tools that act on a resource id which cannot be mapped back to a project
 * (e.g. a Model Derivative URN). When an allow-list is configured we cannot prove the
 * resource is inside it, so the only honest answer is to refuse — otherwise the tool
 * would silently bypass the allow-list the manifest promises.
 */
export function checkUnscopedToolAllowed(toolName: string, resourceKind: string): void {
  if (allowedProjects.has('*')) return;
  throw new AllowlistError(
    'project',
    toolName,
    `Tool "${toolName}" acts on a ${resourceKind} that cannot be mapped to a project, so it ` +
      `cannot be checked against FORMA_ALLOWED_PROJECTS. While the allow-list is active this ` +
      `tool is refused. Set FORMA_ALLOWED_PROJECTS=* to allow it, or use a project-scoped tool.`,
  );
}
