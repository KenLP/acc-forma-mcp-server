import { env } from '../config/env.js';
import { normalizeProjectId } from '../utils/project-id.js';

export class AllowlistError extends Error {
  constructor(kind: 'hub' | 'project', id: string) {
    super(
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
  if (!allowedHubs.has(hubId)) throw new AllowlistError('hub', hubId);
}

export function checkProjectAllowed(projectId: string): void {
  if (allowedProjects.has('*')) return;
  const { withPrefix, bare } = normalizeProjectId(projectId);
  if (!allowedProjects.has(withPrefix) && !allowedProjects.has(bare)) {
    throw new AllowlistError('project', projectId);
  }
}
