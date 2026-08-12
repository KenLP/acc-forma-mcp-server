/**
 * Reduces a mutation tool's `structuredContent` to what the audit log is allowed to keep.
 *
 * PRIVACY.md and the submission docs promise the audit log holds "a short output summary" /
 * "not full payloads" — but until this module existed, `_wrap.ts` wrote `structuredContent`
 * verbatim (the whole created/updated issue, review, comment, ...). This is the fix: audit
 * should record WHAT HAPPENED TO WHICH RESOURCE, never the resource's business content.
 *
 * Policy:
 *   - KEEP: resource identifiers and lifecycle state — `id`, `displayId`, `status`,
 *     `published`, `urn`, and any key ending in `Id` or `Count`. These are exactly what
 *     README's "if a tool call times out, check meta_list_changelog" guidance depends on —
 *     dropping them would break that promise.
 *   - DROP: everything else — free text and business content (`title`, `description`,
 *     `body`, `comment`, `customAttributes`, `linkedDocuments`, ...), whether it's a leaf
 *     value or a nested object/array.
 *   - Wrapper objects (`{ issue: {...} }`, `{ review: {...} }`) are unwrapped exactly ONE
 *     level so the keep-list above can reach the fields that actually matter — deeper
 *     nesting is dropped rather than walked, keeping the function's output shape predictable
 *     and cheap to reason about.
 *   - Arrays are never inlined (an array of full resources — comments, custom attributes,
 *     linked documents — is exactly the "content" this function exists to keep out of the
 *     log). A nested array under a dropped key is fully dropped and counted in `_omitted`
 *     like any other dropped field; a bare array passed directly to `summarizeForAudit`
 *     (nothing to attach `_omitted` to) is reduced to `{ _array_length }` instead of an
 *     empty object, so at least SOME signal survives.
 *   - `_omitted` is added to an object when fields were dropped from it, so a human reading
 *     the JSONL later can tell some data was intentionally left out rather than mistaking a
 *     sparse entry for the whole result.
 */

const KEEP_EXACT = new Set(['id', 'displayId', 'status', 'published', 'urn']);

function isKeptKey(key: string): boolean {
  return KEEP_EXACT.has(key) || key.endsWith('Id') || key.endsWith('Count');
}

/** Arrays never get their elements audited — only how many there were. */
function summarizeArray(value: unknown[]): unknown {
  return { _array_length: value.length };
}

/**
 * @param depthRemaining how many more "unwrap a non-kept object key" hops are allowed.
 *   1 at the top-level call permits exactly the `{ issue: {...} } -> { id, status, ... }`
 *   unwrap; 0 once inside that inner object, so it stops there instead of walking further.
 */
function summarizeLevel(value: unknown, depthRemaining: number): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return summarizeArray(value);
  if (typeof value !== 'object') return value; // string/number/boolean scalar

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let omitted = 0;

  for (const [key, val] of Object.entries(obj)) {
    if (isKeptKey(key)) {
      // Identifier/status keys are expected to be scalars; if one somehow holds a nested
      // value, summarize it too rather than trusting it blindly.
      out[key] = val !== null && typeof val === 'object' ? summarizeLevel(val, depthRemaining) : val;
      continue;
    }
    if (depthRemaining > 0 && val !== null && typeof val === 'object' && !Array.isArray(val)) {
      // One-level wrapper unwrap, e.g. the `issue` key inside `{ issue: {...} }`.
      out[key] = summarizeLevel(val, depthRemaining - 1);
      continue;
    }
    omitted++;
  }

  if (omitted > 0) out['_omitted'] = omitted;
  return out;
}

/**
 * Entry point — always allows exactly one wrapper-unwrap hop, matching every current
 * mutation tool's `structuredContent` shape (`{ <resource>: {...} }` or a flat object).
 */
export function summarizeForAudit(structuredContent: unknown): unknown {
  return summarizeLevel(structuredContent, 1);
}
