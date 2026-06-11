# ADR 0004: Audit Log Format — JSONL Primary, SQLite Optional Index

**Status:** Accepted  
**Date:** 2026-04-16

## Context

Audit logs for construction data access must be:
- Forensic-friendly (readable by auditors without special tooling)
- Tamper-evident (detect if entries are retroactively modified)
- Crash-safe (an incomplete write should not corrupt previous entries)
- Exportable (ship to SIEM / log aggregator)

## Decision

**Primary format: append-only JSONL** — one JSON object per line in `audit-YYYY-MM-DD.jsonl`.

**Tamper-evidence: SHA-256 hash chain** — each entry contains `prev_hash` (hash of the previous entry) and `this_hash = sha256(prev_hash + canonical_json(entry_fields))`. Modifying any prior entry invalidates all subsequent hashes.

**Secondary (opt-in): SQLite** — when `FORMA_AUDIT_INDEX=sqlite`, a SQLite DB is built from the JSONL files. Used for fast filter/aggregate queries. If the `.db` is corrupt or deleted, it is rebuilt from JSONL. Source of truth is always JSONL.

## Consequences

- No database required in default mode
- JSONL is `grep`-able, `jq`-able, compatible with Filebeat/Fluentd/Loki
- Hash chain can be verified via the `meta_verify_audit_chain` MCP tool or offline with standard tools (`jq`, `sha256sum`)
- SQLite index is defined in the env schema but **not yet implemented** — setting `FORMA_AUDIT_INDEX=sqlite` causes a startup error with a clear message
