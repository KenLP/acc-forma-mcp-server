# ADR 0003: Dry-Run-First Mutation Pattern

**Status:** Accepted  
**Date:** 2026-04-16

## Context

LLMs can hallucinate API payloads or act on ambiguous user intent. A single-call write pattern gives no opportunity for the user to see exactly what will be sent to ACC before it happens.

## Decision

Mutation tools default to `dry_run=true`. The server:
1. Call 1 (`dry_run=true`): validates allow-list, readonly mode, rate limit, business rules, builds the full APS request payload — but does NOT call APS. Returns a human-readable preview + `approval_token` (ULID, TTL 300s, single-use, cryptographically bound to the payload hash via SHA-256).
2. Call 2 (`dry_run=false, approval_token=<token>`): verifies the token, checks the payload hash matches, then calls APS and audits the result.

**No separate `meta.confirm_action` tool** — confirmation is embedded in the second tool call itself. The MCP client's built-in approval UI gates each call, so the user always sees the full payload before approving.

Power users can set `FORMA_MUTATION_MODE=client_approval_only` to collapse to a single call and trust the client UI.

## Consequences

- Two round-trips for every write in default mode (acceptable for construction data — writes are infrequent and high-stakes)
- Approval token prevents replay attacks and payload substitution
- `FORMA_MUTATION_MODE=client_approval_only` available for power users
- All stages (preview, executed, denied_*, failed_api) are audit-logged with the same hash chain
