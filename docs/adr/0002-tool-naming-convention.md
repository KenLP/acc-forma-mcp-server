# ADR 0002: Tool Naming Convention

**Status:** Accepted  
**Date:** 2026-04-16  
**Updated:** 2026-06-10

## Context

MCP tools need discoverable, predictable names so the LLM can reason about them without reading full descriptions. MCP tool names must not contain dots (rejected by the protocol).

## Decision

Use `<domain>_<verb>[_<noun>]` (all underscores, snake_case):

- **Domains:** `dm`, `admin`, `issues`, `rfis`, `reviews`, `submittals`, `forms`, `sheets`, `photos`, `locations`, `assets`, `cost`, `webhooks`, `aecdm`, `meta`
- **Verbs:** `list`, `get`, `create`, `update`, `delete`, `transition`, `add_comment`, `start_*`, `verify_*`

Examples: `dm_list_hubs`, `issues_create`, `aecdm_get_element_properties`, `meta_verify_audit_chain`

## Consequences

- Consistent grouping: LLM sees `issues_*` and immediately knows the tool family
- Mutation tools (`create`, `update`, `delete`, `transition`) auto-get `dry_run` + `approval_token` fields via `_wrap.ts`
- Read tools (`list`, `get`) skip the dry-run pipeline
- All tool description strings must use underscore names when referencing other tools (dot-style causes LLM to hallucinate non-existent tool names)
