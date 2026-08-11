# Privacy Policy — acc-forma-mcp-server / BIMLynx

**Last updated:** 2026-08-11
**Applies to:** the hosted service at `https://mcp.bimlynx.com/mcp` (the primary subject of
this policy) and the open-source `acc-forma-mcp-server` codebase when self-hosted (§0)
**Publisher contact:** hello@bimlynx.com (general) · support@bimlynx.com (data requests) ·
ken.lephuc@gmail.com

## 0. Two ways to run this software — which one applies to you

`acc-forma-mcp-server` is open-source (MIT). It can run two ways:

- **Hosted service ("BIMLynx", `mcp.bimlynx.com`)** — the publisher operates the server for
  you. You connect your MCP client to a URL and authenticate with a bearer key issued to your
  organization. **This is the mode almost all of this policy describes**, because it is the
  mode with data flowing through infrastructure you do not control.
- **Self-host** — you clone the repository and run the server yourself, on your own machine
  or infrastructure, with your own Autodesk credentials. In this mode the publisher operates
  nothing and receives nothing: every byte — credentials, project data, the audit log —
  stays on your machine, under your control, exactly as this document described before the
  hosted service existed. If you are self-hosting, skip to §6, which is the only section
  written for that mode; everything else describes the hosted service.

If you are unsure which applies to you: if you were given a bearer key and a URL by BIMLynx,
you are using the hosted service. If you cloned the repository and supplied your own
`APS_CLIENT_ID`/`SSA_*` credentials, you are self-hosting.

---

## 1. Hosted service — what data the software handles, how, and why

### 1.1 Tenant provisioning data

To provision your organization ("tenant") on the hosted service, the publisher creates a
dedicated Autodesk Secure Service Account (a "robot") for you and stores:

| Field | Content |
|---|---|
| Tenant name, robot email, service account id, key id | Identifying metadata for your robot |
| Robot private key | Encrypted at rest (AES-256-GCM) with a publisher-held master key (`FORMA_MASTER_KEY`) — never stored or logged in plaintext |
| Bearer key | Only its SHA-256 **hash** is stored. The live key is shown to you exactly once, at provisioning, and cannot be recovered from the stored hash |

This is the credential architecture behind the "one bearer key per tenant, robot-per-tenant"
model: your MCP client sends the bearer key, the server maps it to your robot, and mints
Autodesk API tokens on your robot's behalf for that request. Source: `src/tenancy/robot-store.ts`,
`src/tenancy/crypto.ts`.

### 1.2 Autodesk project data — in transit, not retained as such

When you invoke a tool, the server calls Autodesk APIs using your tenant's robot credentials
and returns the result to your MCP client. This may include project and account metadata,
folders, files and versions, issues and comments, reviews, BIM element properties, clash
results, and model version diffs — whatever the tool you invoked is for.

- **How collected:** requested from Autodesk's APIs on your behalf, in direct response to a
  tool call you (or your agent) make.
- **Used for:** producing that tool's result, then discarded. The server does not log,
  index, or persist full tool outputs.
- **Exception — idempotency cache:** if a mutation tool call supplies an `idempotency_key`
  and `FORMA_PERSISTENCE_MODE=sqlite` is enabled (the hosted service's default), the server
  caches that call's result for replay in case the same key is retried — see §1.4. This is
  the one place a mutation's result (which can include Autodesk project/business data) is
  written to disk, and it is short-lived (bounded by the approval-token TTL, default 300s).
- **Audit log entries** (§1.3) record inputs (redacted) and a short output summary for every
  call, not full outputs — that is the one durable record of what happened.

### 1.3 The per-tenant audit log

Every tool invocation that reaches a tool handler is appended to a hash-chained JSONL audit
log, stored on the publisher's infrastructure under a directory scoped to your tenant
(`FORMA_AUDIT_DIR/<tenantId>/`) — one tenant's chain is a separate file tree from another's.
This is a deliberate safety feature: it lets you and the publisher verify what an AI agent
did through your credentials.

Each entry records: timestamp and call id; which tool ran and whether it was a read or a
mutation; the actor (auth mode, your tenant's robot id); the ACC project targeted; the tool's
inputs **after** secret redaction; a short output summary; for mutating calls, a SHA-256
**fingerprint** of the approval token (never the live token); and the hash-chain fields
linking entries so tampering is detectable.

**Redaction before writing.** Inputs and outputs pass through a redactor (`src/utils/redact.ts`)
that strips bearer tokens, JWTs, `client_secret` values, live approval tokens, and any field
named `access_token`, `refresh_token`, `client_secret`, `password`, `authorization`,
`x-api-key`, `api_key`, `private_key`, `assertion`, or `approval_token`. Redaction targets
*secrets*, not *business content* — if a tool call includes an issue title or description,
that content is recorded in `input_redacted`.

### 1.4 Approval tokens, rate counters, idempotency records

The hosted service runs `FORMA_PERSISTENCE_MODE=sqlite`, so this data is stored in a SQLite
database on the publisher's infrastructure (the Fly.io volume backing the service — see
§2), keyed per tenant:

| Table | Contents |
|---|---|
| `approval_tokens` | live approval token ids, tool name, a SHA-256 payload hash, expiry |
| `rate_counters` | per-tenant/per-tool/per-project hourly counters |
| `idempotency_records` | idempotency keys, tool name, payload hash, and the **cached tool result** — which can include Autodesk project/business data returned by that call |

All three expire with `FORMA_APPROVAL_TOKEN_TTL` (default 300 seconds) or, for rate
counters, at the next hour boundary; expired rows are purged at server startup.

---

## 2. Sub-processors — who else touches your data

The hosted service has exactly two sub-processors, both necessary to its operation:

| Sub-processor | Role | Data involved |
|---|---|---|
| **Autodesk** | The APS/ACC APIs the server calls on your robot's behalf | Whatever Autodesk data your tool call requests or writes — governed by the [Autodesk Privacy Statement](https://www.autodesk.com/company/legal-notices-trademarks/privacy-statement) |
| **Fly.io** | Hosts the server container and its persistent volume (region: Singapore) | Everything described in §1: tenant records, robot keys (encrypted), the audit log, approval tokens/rate counters/idempotency cache |

There are no other sub-processors: no analytics provider, no advertising network, no
third-party logging or monitoring SDK, no data broker. Your data is not sold, and it is not
used to train any model, by the publisher or otherwise.

### AI / LLM services

The server itself does not send data to any AI or LLM service — it bundles no AI SDK, holds
no AI provider credentials, and makes no calls to any AI provider. It returns tool results
over the MCP protocol to whichever client you configured; that client is typically an AI
agent, and whether an AI model receives the data — and which provider — is determined by
your own choice of client and your consent with that provider, not by this server.

---

## 3. Data retention and deletion

| Data | Retention |
|---|---|
| Tenant record (robot identity, encrypted private key, bearer key hash) | Retained until you request tenant deletion (§4) or the publisher disables/removes the tenant |
| Autodesk project data returned by a tool call | Not retained as such — see the idempotency-cache exception in §1.2 |
| Approval tokens, rate counters, idempotency records | Expire with the approval-token TTL (default 300s) or hourly boundary; purged at server startup |
| Audit log | **90 days by default** (`FORMA_AUDIT_RETENTION_DAYS`, `src/config/env.ts`), then deleted automatically by `pruneOldAuditFiles()`, scoped per tenant |

---

## 4. Your control — revoking access and deleting data

- **Cut off Autodesk-layer access instantly, without the publisher:** your Autodesk hub
  admin can remove the tenant robot from Hub Admin → Custom Integrations, or remove its
  project/hub membership. This takes effect at Autodesk's own layer — it does not depend on
  the publisher acting on your request, and it is the fastest way to guarantee the robot can
  read nothing further.
- **Request the tenant be disabled:** email support@bimlynx.com. Once disabled, the bearer
  key is rejected immediately (checked locally on every request, before any Autodesk call is
  made).
- **Request permanent deletion of your tenant record and audit history:** email
  support@bimlynx.com. This is a manual process on the publisher's side today — there is no
  self-service deletion endpoint — so expect it to take a support turnaround, not be
  instantaneous.
- **What is not promised:** disabling a tenant does not guarantee an Autodesk access token
  already issued to the robot is invalidated the instant you ask. Autodesk's own token
  lifetime applies to any token minted before disablement (potentially up to roughly an
  hour) — this has not been independently verified against a live token. If you need a hard
  guarantee of zero further access, use the Autodesk-layer removal above; it is not
  best-effort in the same way.

---

## 5. Children's privacy

The service is a developer/professional tool for AEC/BIM workflows. It is not directed at
children and does not knowingly collect data from anyone under the age required by
applicable law.

---

## 6. Self-host mode

If you clone the repository and run the server yourself with your own Autodesk credentials,
none of §§1–4 apply — there is no publisher-operated infrastructure in the picture at all.

**The publisher receives no data from you in this mode — none.** There is no telemetry, no
analytics, no usage reporting, no crash reporting, and no "phone home" of any kind. The
software contacts only Autodesk's own APIs, using credentials that you supply, to do the work
you ask of it. Credentials are read from your process environment at startup and never
written to disk by the software. Autodesk project data is held in memory for the duration of
a call and returned to your MCP client — not stored, other than the local audit log (a JSONL
file on your own machine, `~/.acc-forma-mcp/audit` by default) and, only if you opt into
`FORMA_PERSISTENCE_MODE=sqlite`, a local `state.db` holding approval tokens, rate counters,
and idempotency records (which can include cached tool results). Both files stay on your
machine; nothing is transmitted anywhere except Autodesk (`developer.api.autodesk.com`,
plus Autodesk-issued pre-signed S3 URLs for Model Coordination clash downloads).

You are in full control: stop the process to stop all data processing; revoke or rotate your
Autodesk credentials to cut off access entirely; delete the audit directory and `state.db`
to delete everything the software ever wrote. There is no publisher-side account in this
mode, so there is no consent to withdraw from the publisher and no deletion request to file
— the data never left your machine.

---

## 7. Changes to this policy

Material changes will be published in this file, with the "Last updated" date revised, and
recorded in the repository's public commit history at
<https://github.com/KenLP/acc-forma-mcp-server>.

## 8. Contact

Questions about this policy, or requests under §4: **support@bimlynx.com** (data requests) ·
**hello@bimlynx.com** (general) · or open an issue at
<https://github.com/KenLP/acc-forma-mcp-server/issues>.
