# Review brief — BIMLynx remote MCP (R1 + R2a + R3)

> For an independent reviewer (human or AI) with read access to this repository.
> Written 2026-08-12 by the team that built it. It deliberately points at the weak
> spots: a review that only confirms what we already believe is worth nothing.

## What you are reviewing

An MCP server that exposes Autodesk Construction Cloud / Forma to AI clients. It was
a local stdio tool; over the last three days it became a **hosted multi-tenant
service** and is now live in production at `https://mcp.bimlynx.com/mcp`, about to be
submitted to Autodesk's Design & Make Marketplace.

Branch: was `feat/remote-mcp`; merged to `main` and tagged `v0.2.0` on 2026-08-13.
Stack: TypeScript, Node ≥20, ESM. Deployed as a container on Fly.io (Singapore).

## Read these first, in this order

| File | Why |
|---|---|
| `CLAUDE.md` | Architecture, invariants, hard-won API gotchas. Densest single source. |
| `docs/specs/SPEC_remote-mcp.md` | The plan this work executed (R1/R2a/R3). Note: several of its claims turned out wrong — see below. |
| `src/tools/_wrap.ts` | Every safety guarantee lives here. If something can bypass this, that is the finding. |
| `src/transport/http.ts` | The whole remote attack surface. |
| `src/tenancy/` | Tenant isolation: bearer → tenant → per-tenant auth provider. |
| `docs/HANDOFF.md` | Current state, open items, operational gotchas. |
| `PRIVACY.md`, `mcp-manifest.json` | Submission artifacts — claims we make publicly. |

## Architecture in six lines

- Stateless HTTP: every `POST /mcp` builds a fresh `McpServer` + transport. Nothing shared between requests, so the machine can auto-stop when idle.
- `Authorization: Bearer <key>` → sha256 → `tenants` row → a per-tenant `SsaAuthProvider` built from that tenant's own Autodesk service account ("robot-per-tenant", Autodesk's official ISV isolation pattern).
- Tenant isolation is enforced **by Autodesk**, via each robot's own hub/project membership — not by our allow-list, which stays `*` in remote mode.
- Writes are two-call: preview returns a payload-bound, single-use approval token; execute requires it.
- Every tool call is appended to a per-tenant hash-chained JSONL audit log.
- Robot private keys are AES-256-GCM at rest; bearer keys are stored only as hashes.

## What we already know is weak — do not stop here, but do not waste time rediscovering it

1. **No HTTP-layer mocking, by deliberate policy.** 336 unit tests, none exercise real APS calls. Consequence, measured: **three tools shipped broken and were caught only in production** — `issues_list_attrs` (wrong endpoint, never worked since it was written), `issues_list` (status filter always 400), `issues_update` (could not publish a draft). All were found by reading the audit log, not by tests. We consider this the single biggest structural gap. Fixed instances; the *class* remains open.
2. **The server cannot enforce human approval.** `preview_required` guarantees a preview happened and that the executed payload matches it. It does **not** guarantee a person clicked anything — an agent can satisfy both calls itself, and we observed exactly that. Check whether any public claim (README, `PRIVACY.md`, `mcp-manifest.json`, listing copy in `docs/MCP-PUBLISHER-SUBMISSION.md` §5b) overstates this.
3. **Sqlite store classes have no unit tests** — `SqliteTokenStore`, `SqliteRateStore`, `SqliteIdempotencyStore`. Only `cleanupExpiredRows` is covered.
4. **`app_model: "C"` manifest shape is a guess.** No published Autodesk example of a remote/hosted manifest exists; field naming is our reading of the FAQ.
5. **SEA/exe pipeline untested since 2026-07-17**, and a sibling product (`bim-orchestrator`) consumes a *frozen* exe from 2026-06-15. Do not rebuild it — see rules below.
6. **Single machine, no HA.** Fly auto-stop means a cold start of several seconds; long tool calls can exceed client timeouts (`mp_diff_versions` polls 15-20s).
7. **`mcp-remote` (client-side bridge) wedges after a long call** — every later call then times out while the server is fine.
8. **Audit `lastHash` is in memory per audit dir**, restored from file at startup. Reason about what a mid-write crash or two concurrent writers to one tenant do to the chain.
9. **3LO is not implemented**; R2b (OAuth so claude.ai can connect) is researched but not built — see `docs/specs/R2b-oauth-findings.md`.

## Questions we actually want answered

Ordered by how much a wrong answer would cost us.

1. **Can one tenant reach another's data or state?** Trace bearer → `getContextForBearer` → `buildTenantContext` → `_wrap.ts` → stores/audit. The per-tenant `SsaAuthProvider` cache is a module-level `Map` that survives across stateless requests — is that cache keyed and invalidated correctly when a tenant is disabled or deleted?
2. **Does anything reach Autodesk without passing `wrapMutationTool`?** Any path that skips it skips every guarantee at once.
3. **Is the approval token actually payload-bound and single-use** under concurrency? Two simultaneous executes with the same token — what happens?
4. **Is the audit chain honest?** Can an entry be dropped or reordered without `verifyChain` noticing? What happens when two requests for the same tenant append at the same instant?
5. **Secrets**: is `FORMA_MASTER_KEY` handled correctly (`src/tenancy/crypto.ts`)? IV reuse, authentication tag checking, key-loss behaviour. Does anything log a bearer key, a PEM, or a live approval token? (`src/utils/redact.ts` is supposed to prevent this.)
6. **Do our public claims match the code?** Read `PRIVACY.md` against `src/persistence/db.ts` and `src/safety/audit-log.ts`. We rewrote it for the hosted model; assume we got something wrong.
7. **HTTP surface**: `src/transport/http.ts` — error handling, information disclosure, anything reachable before authentication, request-size limits, and whether a malformed or hostile body can do more than return 400.
8. **What would you have caught that our process structurally cannot?** Our process is multi-agent implementation, tests without network mocks, and live probing. Tell us the blind spot, not just the bug.

## Rules of engagement — please respect these

- **Read-only against Autodesk.** Do not create, update, void or delete ACC data. The test project (`Ken-MCP`) contains real work.
- **Do not create or delete Autodesk service accounts.** The quota is 10 per client ID; we have ~8 free and each one matters.
- **Do not run `npm run sea:build` / `sea:copy`.** A sibling product demos from a frozen exe; rebuilding it is the one action that can break an unrelated demo.
- **Do not rotate `APS_CLIENT_SECRET`.** It is mirrored in two other repos; rotation is scheduled after that demo.
- **Do not `fly deploy`.** Ask instead — production is serving a live pilot tenant.
- Local checks are all safe and encouraged: `npm run typecheck && npm run lint && npm run test && npm run build`.

## What a useful report looks like

For each finding: the file and line, a concrete failure scenario (inputs → wrong outcome), and how you verified it — reading code, running a test, or probing. Please separate *confirmed* from *suspected*; we would rather have five confirmed findings than thirty plausible ones. If you conclude something is fine, say why you are confident, so we know which stones were turned.

---

## Response to your review (written 2026-08-13, after remediation)

Your report is `docs/audits/AUDIT_2026-08-12_remote-mcp.md`. Before touching any code we
re-verified all thirteen findings independently — reading the cited lines ourselves and, where
your report described a probe, re-running our own version of it rather than trusting your output.
Result: **13/13 confirmed.** None were dismissed. The full verdict table, with the nuance each
finding picked up under re-verification, is `docs/audits/AUDIT_2026-08-12_remediation-plan.md`.
Four commits closed the ones we're treating as done: `5527eed`, `057955c`, `ce8f150`, `1e8e629`.

**Where we agreed and fixed as described:**

- **P1-1 (UTC rollover)** — reproduced your fake-clock result exactly. Fixed by keying the cached
  last-hash by the resolved daily file path instead of the directory (`5527eed`).
- **P1-4 (unbounded downloads)** — agreed in full. Model Properties NDJSON is now stream-parsed
  with the element cap enforced during the read; Model Coordination's buffered reads now count
  bytes as they arrive and cap decompressed size too; both fetches carry timeouts (`ce8f150`).
- **P2-1 (500 instead of 413)** — reproduced by probe. Fixed immediately (`5527eed`). The other
  half of your finding — moving body-parsing behind auth — we deliberately split into its own
  commit (`1e8e629`) because it changes what an unauthenticated malformed/oversized body reports
  (401 instead of 400/413), which we considered a semantic call worth isolating from a pure
  size-limit fix, not something to slip in quietly.
- **P2-2 (retention not continuous)** — agreed; added a 24h unref'd prune timer (`1e8e629`).
- **P1-2 (verifier over-claims)** and **P1-3 (audit stores full output)** — agreed the code and
  the promises had drifted apart, and chose to fix the code toward the promise rather than soften
  the promise toward the code. `summarizeForAudit()` now keeps identifiers/status/counts only
  (`057955c`); `meta_verify_audit_chain`'s description, `PRIVACY.md`, `docs/SAFETY.md`, and the
  manifest now say the chain proves internal consistency of the retained log, not non-deletion
  (`ce8f150`).
- **D1 (mp_diff_versions classification)**, **D3 (stale pnpm docs)** — agreed as written. D3 we
  didn't take on faith either: ran a real `pnpm install --frozen-lockfile` in a scratch clone
  before removing the warning (`1e8e629`).
- **D2 (non-atomic token consume)** — your own report already scoped this correctly as a
  multi-process risk, not a live bug (your concurrency probe showed the single-process case is
  safe, which matches ours). We made the final consume step a single `DELETE` guarded by
  `changes === 1` anyway, ahead of any actual horizontal scaling (`1e8e629`).

**Where we narrowed your recommendation, and why:**

- **P0-2 (approval-token binding).** You proposed a wrapper-wide redesign — "one canonical
  preparation step that returns an immutable execution plan" for every mutation tool. We checked
  all nine and found the TOCTOU is real in exactly one: `issues_pin_element`, whose preview
  re-fetches live state (global offset, element position, object id) that can drift before
  execute. The other eight build their request body purely from the input, so the existing
  cross-request protection (the token hash is checked against a freshly recomputed preview) already
  held for them. We fixed the one tool that needed it — `execute()` now receives the exact
  `preview.executePayload` from the same request instead of re-deriving it (`057955c`) — instead
  of restructuring the pipeline for eight tools that were never exposed. If you think that's an
  incomplete read of the risk surface, we'd like to hear specifically which of the other eight you
  think still has a gap; we didn't find one.
- **P0-1 (webhooks auth/tenant model).** You gave us two options: strip webhooks from remote, or
  build a tenant-owned hook-ownership registry with controlled 2LO. We took the first (your
  recommended one) rather than the registry — webhooks have zero hosted users today, and a
  per-tenant ownership model is real design work we didn't think was justified for a pilot. The
  tools now declare `remoteEnabled: false` and `requiredAuthModes: ['2lo']` (the auth-mode gate
  you correctly noted was entirely missing) and are skipped whenever a request carries a
  `tenantId` (`5527eed`). Hosted tool count is 43; the 3 webhook tools remain available self-host
  over stdio with real 2LO credentials, where the isolation concern doesn't apply.

- **P2-3 (tenant deletion / cache cleanup).** We agree cached decrypted credentials outliving a
  disable is a real gap, but we don't think it's a code fix: the CLI that disables a tenant runs
  in a separate process (`fly ssh console`) from the server holding the cache, so there is nothing
  in-process to evict on that path. The correct fix is an operational procedure, and it shipped as
  one — `docs/SAFETY.md` §"Offboarding a tenant" (`1e8e629`) documents the five steps: disable,
  let in-flight requests drain, `fly machines restart` to flush the provider cache, delete the
  tenant row plus the three composite-keyed tables plus the tenant's audit subdirectory, and the
  customer's own removal of the robot at the Autodesk layer. Two honest caveats we wrote into that
  document rather than around: the restart is process-wide (there is no per-tenant evict), and the
  permanent-deletion step is a hand-run SQLite operation we have not yet rehearsed against the
  deployed volume.

**Where we still owe you something, and haven't shipped it:**

- **P2-4 (subprocessor wording).** Not ours to decide — forwarded to Ken. `PRIVACY.md` now
  explains why AWS isn't listed as a third subprocessor (Autodesk-issued signed URLs, no AWS
  account of our own), but the exact wording still wants a legal/privacy read before it's final.

**Overall:** this was the highest-signal review we've had on this codebase — thirteen findings,
thirteen held up, and the two blockers you flagged as blockers (P0-1, P0-2) were both real. Thank
you for pointing at the weak spots instead of confirming what we already believed. We have not
yet re-run you (or an equivalent independent pass) against the post-remediation code — that's
still ahead of us, alongside the production redeploy, before this goes to Autodesk.
