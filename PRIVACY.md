# Privacy Policy — acc-forma-mcp-server

**Last updated:** 2026-07-16
**Applies to:** `acc-forma-mcp-server` (all versions)
**Publisher contact:** ken.lephuc@gmail.com

## Summary

`acc-forma-mcp-server` is an open-source MCP server that **you run on your own machine or
infrastructure**. It is not a hosted service.

**The publisher receives no data from you — none, ever.** There is no telemetry, no
analytics, no usage reporting, no crash reporting, and no "phone home" of any kind. The
software contacts only Autodesk's own APIs, using credentials that you supply, to do the
work you ask of it.

Everything below describes data handled **on your own machine, under your own control**.

---

## 1. What data the software handles, how, and why

### 1.1 Credentials you supply

You provide your own Autodesk Platform Services (APS) credentials through environment
variables (`APS_CLIENT_ID`, `APS_CLIENT_SECRET`, `SSA_ID`, `SSA_KEY_ID`, `SSA_KEY_PATH`).

- **How collected:** read from your process environment at startup. The software ships with
  no credentials of its own.
- **Used for:** obtaining an access token from Autodesk's token endpoint and authenticating
  API calls, and nothing else.
- **Never** written to disk by the software, never logged, never transmitted anywhere except
  Autodesk (`developer.api.autodesk.com`).

### 1.2 Autodesk project data

When you invoke a tool, the software calls Autodesk APIs and returns the result to your MCP
client. This may include project and account metadata, folders, files and versions, issues
and comments, reviews, BIM element properties, clash results, and model version diffs —
whatever the tool you invoked is for.

- **How collected:** requested from Autodesk's APIs on your behalf, in direct response to a
  tool call you (or your agent) makes.
- **Used for:** producing that tool's result. It is held in memory for the duration of the
  call and returned to your MCP client.
- **Not stored** by the software, other than the audit-log record described in §1.3 and —
  only if you enable SQLite persistence — the cached tool result described in §1.4.

### 1.3 The local audit log

Every tool call is appended to a local audit log — a JSONL file on your own machine. This is
a deliberate safety feature: it lets you prove what an AI agent did.

Each entry records:

| Field | Content |
|---|---|
| `ts`, `id` | timestamp and a call id |
| `tool`, `kind`, `stage` | which tool ran, whether it was a read or a mutation, and at what stage |
| `actor` | `auth_mode` and your `ssa_id`. `user_email` exists in the schema but is **always `null`** in this release (it is reserved for a future end-user-login mode that is not implemented) |
| `project_id` | the ACC project the call targeted |
| `input_redacted` | the tool's inputs, **after** secret redaction (see below) |
| `output_summary` | a short summary of the result |
| `approval_token` | for mutating calls, a SHA-256 **fingerprint** of the approval token — the live token is never written to the audit log |
| `prev_hash`, `this_hash` | SHA-256 hash chain linking entries so tampering is detectable |

**Redaction before writing.** Inputs and outputs are passed through a redactor
(`src/utils/redact.ts`) that removes bearer tokens, JWTs, `client_secret` values, live
approval tokens (`appr_…` strings), and any field named `access_token`, `refresh_token`,
`client_secret`, `password`, `authorization`, `x-api-key`, `api_key`, `private_key`,
`assertion`, or `approval_token`.

**Be aware:** redaction targets *secrets*, not *business content*. If you pass business data
to a tool — for example an issue title or description — that content is recorded in
`input_redacted`. Treat the audit directory with the same care as the project data itself.

- **Where:** `~/.acc-forma-mcp/audit` by default; configurable via `FORMA_AUDIT_DIR`.
- **Who can read it:** only you. The server creates the audit directory with `0700` and each
  log file with `0600` on POSIX systems, so other local users cannot read them; on Windows
  the files inherit the parent directory's ACL. Nothing ever leaves your machine.

### 1.4 Approval tokens, rate counters, idempotency records

By default (`FORMA_PERSISTENCE_MODE=memory`) approval tokens, rate-limit counters, and
idempotency records are held **in memory only** and are discarded when the process exits.

If you opt into `FORMA_PERSISTENCE_MODE=sqlite`, the same data is instead stored in a
local SQLite database on your machine (default `~/.acc-forma-mcp/state.db`, configurable
via `FORMA_DB_PATH`) so that restarts do not invalidate in-flight approvals:

| Table | Contents |
|---|---|
| `approval_tokens` | live approval token ids, the tool name, a SHA-256 payload hash, expiry |
| `rate_counters` | per-tool/per-project hourly counters |
| `idempotency_records` | idempotency keys, tool name, payload hash, and the **cached tool result** — which can include Autodesk project/business data returned by that call |

Approval tokens and idempotency records expire with the approval-token TTL; rate counters
are keyed by the hour and stale buckets are discarded. All expired rows are purged at
startup. Like the audit log, `state.db` never leaves your machine — treat it with the same
care as project data. `state.db` is also created inside a `0700` directory, for the same
reason as the audit directory above.

---

## 2. Data shared with third parties

**The software shares your data with exactly one third party: Autodesk** — because calling
Autodesk's APIs on your behalf is its entire purpose. Your use of Autodesk's services is
governed by the [Autodesk Privacy Statement](https://www.autodesk.com/company/legal-notices-trademarks/privacy-statement).

Network destinations, in full:

| Destination | Why | Direction |
|---|---|---|
| `developer.api.autodesk.com` | APS REST/GraphQL API calls and OAuth token requests | request + response |
| `*.amazonaws.com` | Autodesk-issued pre-signed S3 URLs (short-lived, ~60 s) returned by the Model Coordination clash API, used to download clash-result files | **download only** — nothing is uploaded |

Both destinations are Autodesk's own: the `*.amazonaws.com` URLs are pre-signed links that
Autodesk itself issues and hosts, not a separate vendor we chose. So the only party that
receives your data is Autodesk, under the Autodesk Privacy Statement linked above — a level
of protection at least equivalent to this policy, since the data is already theirs and the
software adds no onward sharing of its own.

There are **no other network destinations**. No analytics provider, no advertising network,
no third-party SDK, no logging service, and no publisher-operated endpoint. The publisher
operates no server and receives nothing.

### AI / LLM services

The software **does not send data to any AI or LLM service.** It bundles no AI SDK or model,
holds no AI provider credentials, and makes no calls to any AI provider.

For clarity about how MCP works: the software returns tool results over a local `stdio`
channel to the MCP client **you** run, and that client is typically an AI agent. Whether an
AI model receives the data, and which provider that model belongs to, is determined entirely
by your own choice of client, your configuration, and your consent with that provider. The
software neither selects, contracts with, nor transmits to any AI provider.

---

## 3. Data retention and deletion

| Data | Retention |
|---|---|
| Credentials | Not retained. Held in process memory only; discarded on exit. |
| Autodesk project data | Not retained. Held in memory for the duration of a call. |
| Approval tokens, rate counters, idempotency records | Memory mode (default): discarded on exit. SQLite mode: stored in `state.db` on your machine until the approval-token TTL expires; expired rows are purged at startup. |
| Audit log | Retained on **your** machine for **90 days by default**, then deleted automatically. Configurable via `FORMA_AUDIT_RETENTION_DAYS`. Old files are pruned at server startup (`pruneOldAuditFiles()`). |

Because the publisher holds no data, there is nothing for the publisher to retain or delete.

---

## 4. Your control — revoking consent and deleting data

You are in full control at all times:

- **Stop all data processing:** stop the server process, or remove it from your MCP client's
  configuration.
- **Revoke access to Autodesk data:** revoke or rotate the credentials you supplied (remove
  the Secure Service Account from the project in ACC Hub Admin → Custom Integrations, and/or
  delete the APS app or its keys in the APS Developer Portal). The software then has no
  access to anything.
- **Restrict access without revoking:** set `FORMA_ALLOWED_HUBS` / `FORMA_ALLOWED_PROJECTS`
  to limit which hubs and projects the software may touch, and/or
  `FORMA_MUTATION_MODE=readonly` to disable every write.
- **Delete all stored data:** delete the audit directory (`~/.acc-forma-mcp/audit`, or your
  `FORMA_AUDIT_DIR`), delete `state.db` if you enabled SQLite persistence
  (`~/.acc-forma-mcp/state.db`, or your `FORMA_DB_PATH`), and unset the environment
  variables. With the audit directory and state.db removed, nothing else is stored
  anywhere — this is complete deletion.

There is no publisher-side account, so there is no consent to withdraw from the publisher
and no deletion request to file.

---

## 5. Children's privacy

The software is a developer tool for professional AEC/BIM workflows. It is not directed at
children and collects no data from anyone.

## 6. Changes to this policy

Material changes will be published in this file, with the "Last updated" date revised, and
recorded in the repository's public commit history at
<https://github.com/KenLP/acc-forma-mcp-server>.

## 7. Contact

Questions about this policy: **ken.lephuc@gmail.com**, or open an issue at
<https://github.com/KenLP/acc-forma-mcp-server/issues>.
