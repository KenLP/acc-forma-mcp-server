/**
 * The single source of truth for the server version inside the bundle.
 *
 * It is a literal rather than a package.json import because the SEA/pkg build
 * bundles only compiled code — package.json is not on disk next to the binary.
 * `tests/unit/version-sync.spec.ts` fails if this drifts from package.json or
 * mcp-manifest.json, which is what stops the three from silently disagreeing.
 */
export const SERVER_VERSION = '0.1.1';
