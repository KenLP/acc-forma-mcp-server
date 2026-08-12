# Remote MCP Review Findings

**Review date:** 2026-08-12  
**Branch:** `feat/remote-mcp`  
**Reviewed commit:** `c1dea57`  
**Review brief:** [`docs/REVIEW_BRIEF_remote-mcp.md`](../REVIEW_BRIEF_remote-mcp.md)

## Overall Assessment

The project should **not be submitted for MCP Marketplace review in its current state**.

Four findings should be resolved before submission:

1. Remote Webhooks authentication and tenant isolation.
2. Approval-token binding to the actual Autodesk request payload.
3. Audit-chain failure across UTC day rollover.
4. Privacy and submission claims that do not match audit behavior.

The remaining findings mainly concern production robustness, operational guarantees,
and documentation accuracy.

## Findings Requiring Immediate Action

### P0-1: Remote Webhooks use an incompatible authentication and tenant model

**Status:** Confirmed  
**Submission impact:** Blocker

The remote tenant context only supplies SSA authentication:

- [`src/tenancy/context.ts:54`](../../src/tenancy/context.ts#L54)

When a tool declares `preferredAuth: "2lo"`, the wrapper uses `ctx.auth2lo` only when
it exists and otherwise silently falls back to SSA:

- [`src/tools/_wrap.ts:49`](../../src/tools/_wrap.ts#L49)

The three Webhooks tools use `/app/hooks` and prefer 2LO authentication:

- [`src/tools/webhooks/list.ts:19`](../../src/tools/webhooks/list.ts#L19)
- [`src/tools/webhooks/create.ts:61`](../../src/tools/webhooks/create.ts#L61)
- [`src/tools/webhooks/delete.ts:17`](../../src/tools/webhooks/delete.ts#L17)

The API implementation and project documentation describe `/app/hooks` as 2LO-only:

- [`src/apis/webhooks.ts:190`](../../src/apis/webhooks.ts#L190)
- [`CLAUDE.md:358`](../../CLAUDE.md#L358)
- [`mcp-manifest.json:107`](../../mcp-manifest.json#L107)

#### Consequences

- Webhooks are advertised in the remote tool inventory but are not provided with the
  authentication mode their implementation requires.
- Attaching a process-wide 2LO credential without additional authorization would be
  unsafe. `/app/hooks` is application-wide, while all hosted tenants share the APS
  application identity.
- A tenant could potentially list or affect hooks belonging to another tenant unless
  the server independently tracks and enforces hook ownership.

#### Required remediation

Choose one of the following before submission:

1. Remove the Webhooks tools from the remote registry, manifest, and Marketplace tool
   listing.
2. Implement a tenant-owned hook registry and enforce ownership during list, create,
   and delete operations before enabling application-wide 2LO authentication.

Simply adding global `auth2lo` to the tenant context is not sufficient.

### P0-2: Approval tokens do not centrally bind the actual wire payload

**Status:** Confirmed  
**Submission impact:** Blocker

The mutation wrapper creates a preview and verifies the approval token against
`preview.executePayload`:

- [`src/tools/_wrap.ts:235`](../../src/tools/_wrap.ts#L235)
- [`src/tools/_wrap.ts:325`](../../src/tools/_wrap.ts#L325)

After verification, the wrapper calls the tool's execute function with the original
input instead of the verified execution payload:

- [`src/tools/_wrap.ts:329`](../../src/tools/_wrap.ts#L329)

This makes the guarantee dependent on each individual tool reconstructing exactly the
same request body during preview and execution.

`issues_pin_element` contains a confirmed time-of-check/time-of-use path:

- Preview calls `resolvePin()` and binds the token to the resulting issue body at
  [`src/tools/issues/pin-element.ts:415`](../../src/tools/issues/pin-element.ts#L415).
- Execute calls `resolvePin()` again at
  [`src/tools/issues/pin-element.ts:458`](../../src/tools/issues/pin-element.ts#L458).

When `global_offset` is omitted, `resolvePin()` reads current pin and model state.
Changes between preview and execution can therefore produce a POST body different
from the body approved by the token.

This contradicts the current guarantee documented in:

- [`src/safety/dry-run.ts:57`](../../src/safety/dry-run.ts#L57)
- [`docs/MCP-PUBLISHER-SUBMISSION.md:495`](../MCP-PUBLISHER-SUBMISSION.md#L495)

#### Required remediation

- Introduce one canonical preparation step that returns an immutable execution plan.
- Bind the approval token to that plan.
- Execute the verified plan directly instead of reconstructing dynamic request data.
- Add a test that changes source data between preview and execute and verifies that
  the actual request remains bound to the approved payload or is rejected.

### P1-1: Audit chains fail across UTC day rollover

**Status:** Confirmed by local probe  
**Submission impact:** Blocker

The last audit hash is cached only by audit directory:

- [`src/safety/audit-log.ts:62`](../../src/safety/audit-log.ts#L62)
- [`src/safety/audit-log.ts:79`](../../src/safety/audit-log.ts#L79)

Audit entries are written to a separate file for each UTC date:

- [`src/safety/audit-log.ts:88`](../../src/safety/audit-log.ts#L88)

The verifier requires the first entry in each independently verified file to point to
the genesis hash:

- [`src/safety/hash-chain.ts:29`](../../src/safety/hash-chain.ts#L29)
- [`src/tools/meta/verify-audit-chain.ts:56`](../../src/tools/meta/verify-audit-chain.ts#L56)

A long-running process retains the previous day's cached hash. Its first entry after
00:00 UTC points to the prior day's last hash instead of genesis, so verification of
the new daily file fails.

#### Probe result

Using a fake clock:

```text
2026-08-12 first prevHash: sha256:genesis
2026-08-12 verification: valid

2026-08-13 first prevHash: previous day's final hash
2026-08-13 verification: invalid at index 0
```

The result also depends on process uptime. Restarting before the first entry of the new
day produces a different chain from a process that remains alive across midnight.

#### Required remediation

- Key the cached previous hash by both audit directory and UTC date; or
- Define a cross-file chain and update verification and restart recovery to load and
  verify the previous day's final hash.

Add a fake-clock rollover regression test.

### P1-2: The verifier cannot prove that no audit entries were deleted

**Status:** Confirmed design limitation  
**Submission impact:** Public-claim blocker

The internal hash chain can detect modification, reordering, or deletion of an entry
inside the retained chain. It cannot detect:

- Truncation of entries from the end of a file.
- Replacement of an entire file with a newly generated chain beginning at genesis.
- Truncation followed by process restart, after which the server resumes from the new
  final line.

The tool description currently claims that a valid result proves no entries were
deleted:

- [`src/tools/meta/verify-audit-chain.ts:46`](../../src/tools/meta/verify-audit-chain.ts#L46)

That guarantee cannot be provided without an external trust anchor.

#### Required remediation

Either:

- Publish signed checkpoints to an external immutable location; or
- Narrow the claim to state that the tool verifies the internal consistency of the
  retained chain.

### P1-3: Audit persistence exceeds what Privacy and submission documents disclose

**Status:** Confirmed  
**Submission impact:** Blocker

For mutation tools, the wrapper stores the full `result.structuredContent` value in the
field named `outputSummary`:

- [`src/tools/_wrap.ts:332`](../../src/tools/_wrap.ts#L332)
- [`src/tools/_wrap.ts:339`](../../src/tools/_wrap.ts#L339)

Several mutation tools return full API objects, for example:

- Issue creation: [`src/tools/issues/create.ts:370`](../../src/tools/issues/create.ts#L370)
- Issue update: [`src/tools/issues/update.ts:230`](../../src/tools/issues/update.ts#L230)
- Comment creation: [`src/tools/issues/add-comment.ts:68`](../../src/tools/issues/add-comment.ts#L68)
- Review creation: [`src/tools/reviews/create.ts:148`](../../src/tools/reviews/create.ts#L148)
- Review transition: [`src/tools/reviews/transition.ts:83`](../../src/tools/reviews/transition.ts#L83)

The implementation can therefore retain complete issue, comment, review, and pin
response objects for the configured audit-retention period.

This conflicts with statements that the server does not persist full outputs and keeps
only a short output summary:

- [`PRIVACY.md:57`](../../PRIVACY.md#L57)
- [`PRIVACY.md:69`](../../PRIVACY.md#L69)
- [`docs/MCP-PUBLISHER-SUBMISSION.md:263`](../MCP-PUBLISHER-SUBMISSION.md#L263)
- [`mcp-manifest.json:122`](../../mcp-manifest.json#L122)

Absolute statements such as “every write is previewed and audit-logged” also do not
fully describe these supported configurations:

- Audit fail-open can allow an operation when audit persistence fails.
- `client_approval_only` does not require the server preview/token workflow.
- Read auditing is configurable.
- The server cannot verify that a human actually inspected the preview; human approval
  is a client responsibility.

#### Required remediation

- Define explicit allowlisted audit summaries for every tool instead of persisting raw
  `structuredContent`.
- Update Privacy, manifest, README, and Publisher Submission language to match actual
  behavior and configuration.
- Clearly distinguish server-enforced token binding from human approval performed by
  the MCP client.

## Production Findings

### P1-4: Model downloads have no timeout or effective memory limit

**Status:** Confirmed  
**Production impact:** High

Model Properties downloads the entire NDJSON response into a string and then splits
and parses every line:

- [`src/apis/model-properties.ts:109`](../../src/apis/model-properties.ts#L109)

Model Coordination downloads complete signed-S3 responses into memory before parsing:

- [`src/apis/model-coordination.ts:215`](../../src/apis/model-coordination.ts#L215)

The user-facing `maxElements` and `maxResults` limits are applied only after complete
responses have already been downloaded and parsed:

- [`src/apis/model-properties.ts:231`](../../src/apis/model-properties.ts#L231)

The Fly machine is configured with 256 MB of memory:

- [`fly.toml:40`](../../fly.toml#L40)

Large model or clash responses can exceed available memory. A stalled signed-URL
download can also leave a request open indefinitely because no abort timeout is used.

#### Recommended remediation

- Stream and incrementally parse NDJSON.
- Add `AbortSignal` timeouts to direct fetch calls.
- Enforce response-size and decompressed-size limits.
- Apply safe early termination where result semantics permit it.
- Treat additional machine memory as defense in depth, not the primary fix.

### P2-1: HTTP body parsing occurs before authentication and maps oversized input to 500

**Status:** Confirmed by local probe  
**Production impact:** Medium

The global JSON parser is installed before route authentication:

- [`src/transport/http.ts:141`](../../src/transport/http.ts#L141)
- [`src/transport/http.ts:62`](../../src/transport/http.ts#L62)

Only malformed JSON receives dedicated handling. Other parser failures are mapped to a
generic 500 response:

- [`src/transport/http.ts:176`](../../src/transport/http.ts#L176)

An unauthenticated 110 KB JSON request produced:

```text
HTTP status: 500
JSON-RPC error: Internal server error
Server log: PayloadTooLargeError stack
```

The correct response is 413. The current middleware order also allows unauthenticated
clients to consume JSON parsing resources before authentication.

#### Recommended remediation

- Authenticate `/mcp` before parsing its request body where the framework structure
  permits it.
- Configure and document an explicit body-size limit.
- Map `entity.too.large` to HTTP 413.
- Add malformed and oversized body regression tests.
- Add rate limiting at the application or trusted ingress layer.

### P2-2: The documented 90-day retention is not continuously enforced

**Status:** Confirmed  
**Production impact:** Medium

Audit pruning runs during process startup:

- [`src/index.ts:54`](../../src/index.ts#L54)
- [`src/index.ts:98`](../../src/index.ts#L98)
- [`src/safety/audit-log.ts:157`](../../src/safety/audit-log.ts#L157)

A long-running instance can retain audit files past 90 days until its next restart.
This does not match the statement that records are automatically deleted after 90 days:

- [`PRIVACY.md:135`](../../PRIVACY.md#L135)

#### Recommended remediation

- Run pruning on a scheduled interval and monitor failures; or
- Describe the actual startup-based retention process accurately.

### P2-3: Tenant deletion needs an operational cache-cleanup procedure

**Status:** Confirmed operational gap  
**Production impact:** Medium

Decrypted tenant provider material is cached in process memory:

- [`src/tenancy/context.ts:16`](../../src/tenancy/context.ts#L16)
- [`src/tenancy/context.ts:36`](../../src/tenancy/context.ts#L36)

Deleting or disabling a tenant prevents new authenticated requests because each request
first performs an active-tenant lookup. However, cached decrypted credentials remain in
memory until process restart, and in-flight operations may continue.

The permanent-deletion documentation should include:

- Tenant database-row deletion.
- Approval, idempotency, and rate-limit state cleanup.
- Audit-file deletion according to policy.
- Provider-cache invalidation or process restart.
- Handling expectations for in-flight requests.

### P2-4: Processors and storage wording needs legal verification

**Status:** Documentation/legal verification required  
**Production impact:** Medium

Privacy documentation describes an exact set of two subprocessors, while the manifest
also declares `*.amazonaws.com` access and Model Coordination downloads data from
Autodesk-issued signed S3 URLs.

AWS may be Autodesk's underlying storage provider rather than a direct subprocessor of
this application. The exact “two subprocessors” wording should nevertheless be checked
by the publisher's legal/privacy owner rather than inferred from implementation alone.

## Classification and Documentation Decisions

### D1: `mp_diff_versions` creates server-side work while classified as read-only

**Status:** Confirmed behavior; classification decision required

The tool is registered through the read wrapper but issues a POST to create or request
an asynchronous diff job:

- [`src/tools/mp/diff-versions.ts:69`](../../src/tools/mp/diff-versions.ts#L69)
- [`src/apis/model-properties.ts:67`](../../src/apis/model-properties.ts#L67)

It does not modify source project data and is idempotent for a version pair, so treating
it as a read-like computation may be acceptable. It still creates Autodesk-side work
and potential cost. The project should explicitly document and confirm this
classification for Marketplace review.

GraphQL POST requests used by read tools are semantically read-only and were not found
to create a similar mutation concern.

### D2: Approval consumption is safe only for the current single-process topology

**Status:** Verified safe under current deployment; future scaling risk

A local concurrency probe using the same token for two concurrent callbacks produced:

```text
["fulfilled", "rejected"]
```

Within one Node process, verification and synchronous SQLite operations run without an
`await`, so competing HTTP callbacks cannot interleave inside token consumption.

The store contract nevertheless performs a lookup followed by deletion rather than one
atomic database statement. Multiple processes or replicas could both verify before
either deletion becomes visible.

Before horizontal scaling, use an atomic consume operation such as a transaction or
`DELETE ... RETURNING` with affected-row validation.

### D3: Native dependency installation documentation appears stale

**Status:** Needs fresh-install verification

These documents state that pnpm skips the `better-sqlite3` build unless a separate
approval command is run:

- [`README.md:487`](../../README.md#L487)
- [`CLAUDE.md:157`](../../CLAUDE.md#L157)
- [`docs/HANDOFF.md:86`](../HANDOFF.md#L86)

The package configuration now contains `pnpm.onlyBuiltDependencies`:

- [`package.json:101`](../../package.json#L101)

The local real-SQLite tests pass. A clean installation should be tested once, after
which the stale warnings should be removed or corrected.

## Verified-Safe Areas

### Tool registration and mutation wrappers

- Every registry entry declared as a read tool passes through `wrapReadTool`.
- Every registry entry declared as a mutation tool passes through `wrapMutationTool`.
- All nine declared mutation tools use the central mutation wrapper.
- No direct MCP registration bypass was found for declared mutation tools.

Relevant registry:

- [`src/server.ts:17`](../../src/server.ts#L17)

### Tenant isolation

- Bearer credentials are looked up by hash and only active tenants are accepted.
- Tenant auth-provider caching is keyed by tenant UUID.
- Audit directories are tenant-specific.
- Approval, rate-limit, and idempotency records include tenant ID.
- SQLite primary keys include tenant identity where required.
- A deleted or disabled tenant cannot start a new Autodesk request through a stale
  provider cache because the active-tenant lookup happens first.

Relevant implementation:

- [`src/tenancy/robot-store.ts:115`](../../src/tenancy/robot-store.ts#L115)
- [`src/tenancy/context.ts:36`](../../src/tenancy/context.ts#L36)
- [`src/tenancy/db.ts:29`](../../src/tenancy/db.ts#L29)

### Cryptography and secret handling

- Tenant secrets use AES-256-GCM.
- Encryption uses a random 12-byte IV for each operation.
- Authentication tags are verified during decryption.
- The master key is validated as 32 bytes represented by 64 hexadecimal characters.
- Bearer credentials are stored as hashes.
- Approval tokens are redacted or represented by fingerprints in audit records.
- No confirmed current log path exposes PEM private keys, bearer tokens, or raw
  approval tokens.

Residual operational concerns remain around master-key backup, rotation, and key
versioning. Loss of the master key makes stored tenant ciphertext unrecoverable.

### HTTP error disclosure

- Malformed JSON returns a generic client-facing 400 response.
- Missing and invalid credentials do not reveal tenant existence.
- Client responses do not expose server stack traces or filesystem paths.
- Public root and health routes appear intentional.
- Unsupported HTTP methods return 405.

### Audit concurrency in the current topology

- Audit appends use synchronous file operations.
- Same-process callbacks serialize during append, so a same-tenant concurrent request
  does not fork the hash chain inside one event loop.
- Malformed or partial JSON lines are reported as invalid rather than silently accepted.

Multiple server processes writing the same tenant audit directory would not preserve
that guarantee and are outside the current single-process deployment model.

## Validation Results

The following safe local checks completed successfully:

```text
npm run typecheck  PASS
npm run lint       PASS
npm run test       PASS: 45 files, 336 tests
npm run build      PASS
```

Focused local probes also confirmed:

- The UTC audit rollover failure.
- Single-process approval-token replay rejection under concurrent callbacks.
- Oversized unauthenticated JSON currently returns 500 instead of 413.
- Malformed JSON responses do not expose stack traces to clients.

## Review Boundaries

In accordance with the review brief, the review did not perform:

- Autodesk mutations.
- Service account creation or deletion.
- SEA build or copy operations.
- Secret rotation.
- Fly deployment or production configuration changes.

No source code or existing documentation was modified as part of the review. This file
is the requested export of the review findings.

The pre-existing untracked directories `docs/audits/`, `docs/study/`, and `notes/`
were not cleaned or otherwise modified, except for adding this report under
`docs/audits/`.
