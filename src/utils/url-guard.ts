/** Error thrown when a server-provided URL is outside the declared endpoint set. */
export class DisallowedUrlError extends Error {
  constructor(url: string, reason: string) {
    super(`Refusing to fetch "${url}": ${reason}`);
    this.name = 'DisallowedUrlError';
  }
}

export interface UrlPolicy {
  /** Exact hostnames allowed (e.g. 'developer.api.autodesk.com'). */
  exactHosts?: string[];
  /** Hostname suffixes allowed (e.g. '.amazonaws.com'). Matched with endsWith. */
  hostSuffixes?: string[];
}

/**
 * Validate a URL received from an API response before fetching it (and especially
 * before attaching a bearer token). HTTPS is always required. Throws DisallowedUrlError.
 */
export function assertAllowedUrl(rawUrl: string, policy: UrlPolicy): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new DisallowedUrlError(rawUrl, 'not a valid absolute URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new DisallowedUrlError(rawUrl, `protocol must be https, got "${parsed.protocol}"`);
  }
  const host = parsed.hostname.toLowerCase();
  const exactOk = (policy.exactHosts ?? []).some((h) => host === h.toLowerCase());
  const suffixOk = (policy.hostSuffixes ?? []).some((s) => host.endsWith(s.toLowerCase()));
  if (!exactOk && !suffixOk) {
    throw new DisallowedUrlError(rawUrl, `host "${host}" is not in the declared endpoint set`);
  }
  return parsed;
}
