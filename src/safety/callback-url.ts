/**
 * Validation for webhook callback URLs.
 *
 * A webhook is the one mutation this server offers that configures *ongoing egress*: once
 * created, Autodesk POSTs project event data (file names, folder URNs, issue contents) to
 * a third-party URL indefinitely, with no further call from us. That is a different class
 * of side effect from creating an issue, so the URL is checked before the hook is created
 * rather than trusted because it parsed.
 *
 * Kept free of config/env.js so it stays usable from the `/core` subpath; the allow-list
 * string is passed in by the caller (the MCP tool reads it from env).
 */

export class CallbackUrlError extends Error {
  constructor(url: string, reason: string) {
    super(`Refusing to register callback URL "${url}": ${reason}`);
    this.name = 'CallbackUrlError';
  }
}

/**
 * Hostnames Autodesk's servers can never reach. Registering one produces a hook that looks
 * healthy but silently never delivers — and after 5 consecutive failed events APS marks it
 * inactive. Rejecting up front turns a silent dead hook into an immediate, explainable error.
 */
function isUnreachableHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 127 || a === 0 || a === 10) return true; // loopback, "this network", private
    if (a === 192 && b === 168) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata 169.254.169.254)
    if (a >= 224) return true; // multicast + reserved
    return false;
  }

  // IPv6 private/link-local ranges: fc00::/7 (unique local), fe80::/10 (link-local)
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true;

  return false;
}

/** Parse the comma-separated host allow-list. `*` (the default) permits any public host. */
export function parseCallbackHostAllowlist(raw: string): Set<string> {
  if (raw.trim() === '*') return new Set(['*']);
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Validate a callback URL before registering it as a webhook target.
 *
 * @param rawUrl        the URL the caller wants Autodesk to POST to
 * @param allowedHosts  parsed FORMA_ALLOWED_CALLBACK_HOSTS. A bare host matches that host
 *                      exactly; a leading dot (".example.com") matches any subdomain.
 * @throws CallbackUrlError
 */
export function assertValidCallbackUrl(rawUrl: string, allowedHosts: Set<string>): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new CallbackUrlError(rawUrl, 'not a valid absolute URL');
  }

  // APS requires https for callbacks; enforcing it here also keeps event data — which can
  // include issue titles and file paths — off plaintext transport.
  if (parsed.protocol !== 'https:') {
    throw new CallbackUrlError(
      rawUrl,
      `protocol must be https, got "${parsed.protocol}". Autodesk only delivers to https endpoints.`,
    );
  }

  if (isUnreachableHost(parsed.hostname)) {
    throw new CallbackUrlError(
      rawUrl,
      `host "${parsed.hostname}" is a loopback, private, or link-local address. Autodesk's ` +
        `delivery servers cannot reach it, so the hook would be created but never fire. ` +
        `Use a publicly reachable https endpoint (a tunnel such as ngrok works for local development).`,
    );
  }

  if (!allowedHosts.has('*')) {
    const host = parsed.hostname.toLowerCase();
    const permitted = [...allowedHosts].some((entry) =>
      entry.startsWith('.') ? host === entry.slice(1) || host.endsWith(entry) : host === entry,
    );
    if (!permitted) {
      throw new CallbackUrlError(
        rawUrl,
        `host "${host}" is not in the FORMA_ALLOWED_CALLBACK_HOSTS allow-list. ` +
          `Add it to the env var, or set FORMA_ALLOWED_CALLBACK_HOSTS=* to permit any public host.`,
      );
    }
  }

  return parsed;
}
