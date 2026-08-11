# bundle/ — BIMLynx MCP Bundle (.mcpb)

Packages the BIMLynx connector as a double-click-installable [MCP Bundle](https://github.com/modelcontextprotocol/mcpb)
for Claude Desktop, so a customer never edits `claude_desktop_config.json` by hand or installs
Node.js themselves. The bearer key is entered through Claude Desktop's own UI (masked, "sensitive"
field — see `user_config.bearer_key` in `manifest.json`).

This bundle does **not** contain a copy of the MCP server. It contains a bundled copy of
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) (pinned in `server/package.json`), which
Claude Desktop runs with its own Node.js runtime to proxy stdio ↔ the hosted server at
`https://mcp.bimlynx.com/mcp`.

## Why `node_modules/mcp-remote` instead of `npx mcp-remote@latest`

The MANIFEST.md spec's own description of `server.type: "node"` is *"Node.js server with bundled
dependencies"* — the two shipped Node examples (`hello-world-node`, and the spec's own snippets)
all invoke `"command": "node"` against a bundled JS file, never `npx`. Fetching `mcp-remote` via
`npx` at connect time was considered and rejected for two concrete reasons found during this
build, not just spec-reading:

1. **The classic Windows bug the .mcpb is supposed to fix.** Cursor and Claude Desktop on Windows
   have a documented bug where `npx`-spawned args with spaces get mangled — the exact
   `claude_desktop_config.json` pain point R3-3 exists to eliminate. Invoking `node
   <bundled-file>.js` directly sidesteps `npx` entirely, so that bug class cannot reach us.
2. **`node_modules` bundled dependencies is the pattern the spec actually documents** for
   `server.type: "node"` — `npx` fetching a package from the registry at connect time isn't shown
   anywhere in the official examples.

`server/package.json` pins `mcp-remote` to an exact version (`0.1.38`, no `^`/`~`) because the
whole `node_modules` tree ships inside the `.mcpb` verbatim — an unpinned range would let a future
`npm install` silently change what gets shipped.

## Windows args-with-spaces: still relevant, handled

`mcp-remote`'s own README documents the same npx/args-with-spaces bug and recommends passing the
`Authorization: Bearer <token>` value through an **environment variable**, not inline in `args`,
because env values aren't tokenized the way argv is. `manifest.json` follows that:

```
args: ["--header", "Authorization:${AUTH_TOKEN}"]
env:  { "AUTH_TOKEN": "Bearer ${user_config.bearer_key}" }
```

## Build

```bash
cd bundle/server
npm install --omit=dev        # regenerates node_modules/ (gitignored — not committed)
cd ../..
npx @anthropic-ai/mcpb validate bundle/manifest.json
npx @anthropic-ai/mcpb pack bundle bimlynx.mcpb
```

CLI package: **`@anthropic-ai/mcpb`** (verified via `npx @anthropic-ai/mcpb --version` → `2.1.2`
at the time this was built; not installed globally in this repo). `mcpb pack` runs manifest
validation itself before archiving, so a separate `validate` call is a convenience, not a
prerequisite.

Live-verified in this repo (2026-08-11): `mcpb validate bundle/manifest.json` → *"Manifest schema
validation passes!"*; `mcpb pack bundle <out>.mcpb` → succeeded, 740 files, 1.5 MB packed / 4.5 MB
unpacked, `mcpb info <out>.mcpb` confirms the archive is readable. The packed file itself is never
committed (`*.mcpb` is in `.gitignore`) — rebuild it from `bundle/` whenever you need it.

**Not signed.** `mcpb info` reports `WARNING: Not signed` — Claude Desktop will show an
unverified-publisher notice on install. `mcpb sign` exists (needs a code-signing cert) but is out
of scope for this pass; revisit before wide distribution.

## Test locally

Claude Desktop → Settings → Extensions → drag the packed `.mcpb` file onto the window (or use the
"Install Extension" file picker). Claude Desktop will prompt for the `BIMLynx bearer key` through
its own masked input — nothing to type into JSON.

## Does the customer need Node.js installed?

**No — for the mechanism itself.** The MCPB project's own README states plainly: *"Node.js ships
with Claude for macOS and Windows."* `server.type: "node"` extensions run on that bundled runtime,
which is exactly why the official guidance is *"We recommend implementing MCP servers in Node.js
rather than Python to reduce installation friction."* This is the main selling point R3-3 exists
to capture, and it is a documented project claim, not just inferred — but it has **not been
observed directly on Ken's machine** (see "Still needs a real install test" below); the CLI-level
smoke tests in this pass ran against the repo's own system Node, which doesn't prove Claude
Desktop's bundled runtime specifically.

## What was live-tested vs. what wasn't

Ran directly against `bundle/server/node_modules/mcp-remote/dist/proxy.js` with plain `node` (this
repo's Node 22, not Claude Desktop's bundled one) to confirm the entry point actually executes and
reaches the real server, before trusting it inside a packed bundle:

- Confirmed the process starts, does OAuth-discovery probing (all `404`, expected — the server
  isn't an OAuth server), then attempts the real `POST /mcp` with the custom header.
- **Found and worked around a real failure mode**: when the server returns `401` (bad/expired/
  malformed bearer key), the MCP SDK's `StreamableHTTPClientTransport` reacts to the `401` by
  falling into an OAuth recovery attempt (dynamic client registration at `/register`), which 404s
  against this non-OAuth server and surfaces as a confusing cascading `Fatal error`, not a clean
  "unauthorized" message. This is gated on `response.status === 401` in the SDK (verified by
  reading the bundled source) — it is **not** triggered on a `200` response, so a *valid* bearer
  key should reach the server and proceed normally without ever touching that path.
  `--transport http-only` is set in `manifest.json` to skip the pointless SSE-fallback half of
  that cascade (the server's `GET /mcp` already returns `405` by design, so SSE was never going to
  work here anyway).
  - **Practical effect**: a customer who pastes a wrong/expired bearer key will see a confusing
    OAuth-flavored error in Claude Desktop's extension logs instead of a clear "check your key"
    message. Worth a support-doc note; not a blocker for this pass.
- **NOT live-tested**: the full happy path with a real, valid tenant bearer key end-to-end inside
  actual Claude Desktop (vs. this repo's own Node, from a terminal). Provisioning a throwaway
  tenant service account to test this consumes one of the ~9 remaining SSA slots
  (`docs/HANDOFF.md` / `CLAUDE.md` "R2a" quota note) and installs a real extension into Ken's
  Claude Desktop — both require Ken to do, not something to do unattended from this pass.

## Still needs a real install test (Ken, by hand)

1. Build the `.mcpb` per "Build" above.
2. Drag it into Claude Desktop → Settings → Extensions on a machine where you can watch whether it
   prompts for Node (it shouldn't, per "Does the customer need Node.js installed?" above).
3. Enter a real bearer key when prompted; confirm a tool call round-trips
   (`meta_list_changelog` or similar low-risk read is a reasonable first call).
4. Confirm the *invalid-key* error path is at least non-alarming in Claude Desktop's UI, not just
   in a terminal — the cascading OAuth error text above was observed from a bare `node` process,
   not through Claude Desktop's own error surfacing.
