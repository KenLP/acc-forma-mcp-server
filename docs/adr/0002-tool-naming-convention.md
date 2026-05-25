# ADR 0002: Tool Naming Convention

**Status:** Accepted  
**Date:** 2026-04-16

## Context

MCP tools need discoverable, predictable names so the LLM can reason about them without reading full descriptions.

## Decision

Use `<domain>.<verb>[_<noun>]` with snake_case after the dot:

- **Domains:** `dm`, `admin`, `issues`, `rfis`, `reviews`, `submittals`, `forms`, `sheets`, `photos`, `locations`, `assets`, `cost`, `webhooks`, `aecdm`, `meta`
- **Verbs:** `list`, `get`, `create`, `update`, `delete`, `transition`, `add_comment`, `start_*`, `verify_*`

Examples: `dm.list_hubs`, `issues.create`, `aecdm.get_element_properties`, `meta.verify_audit_chain`

## Consequences

- Consistent grouping: LLM sees `issues.*` and immediately knows the tool family
- Mutation tools (`create`, `update`, `delete`, `transition`) auto-get `dry_run` + `approval_token` fields via `_wrap.ts`
- Read tools (`list`, `get`) skip the dry-run pipeline
