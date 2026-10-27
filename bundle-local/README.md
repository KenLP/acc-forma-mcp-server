# bundle-local/ — BIMLynx self-host MCP Bundle (.mcpb)

The self-host edition as a double-click Claude Desktop extension. Unlike `bundle/` (the hosted
connector, which only ships `mcp-remote` and talks to `mcp.bimlynx.com`), this bundle **contains
the whole MCP server** as one JavaScript file and runs it on the user's machine with the user's
own APS app. Do not mix the two manifests.

Customer-facing setup guide: [`docs/SELF-HOST-GUIDE.md`](../docs/SELF-HOST-GUIDE.md).

## Build

```bash
npm run bundle:local            # build + verify + pack → bimlynx-local-<version>.mcpb
node scripts/build-local-bundle.mjs --no-pack   # build + verify only
```

- `tsup.local.config.ts` → `bundle-local/server/index.cjs` (gitignored build output). Every JS
  dependency is inlined; `better-sqlite3` is left out on purpose — the bundle runs
  `FORMA_PERSISTENCE_MODE=memory`, and `src/persistence/db.ts` only loads it on first use.
- No native module → **one `.mcpb` for Windows, macOS and Linux.**
- The verify step copies `index.cjs` into an empty temp folder (no `node_modules` above it), starts
  it in setup mode with placeholder credentials and requires exactly `setup_create_robot` +
  `setup_status` from `tools/list`. A stray static import of an external module fails here,
  before anything is packed.
- Packing uses `@anthropic-ai/mcpb@2.1.2`, which validates `manifest.json` first.
- `manifest.json` `version` must equal `package.json` (`tests/unit/version-sync.spec.ts`).

## What the manifest sets

| env | from | why |
|---|---|---|
| `APS_CLIENT_ID`, `APS_CLIENT_SECRET` | `user_config` (secret is `sensitive`) | the customer's own APS app |
| `BIMLYNX_DATA_DIR` | `user_config.data_dir` (default `${HOME}/BIMLynx`) | robot key + audit log; the server creates it |
| `APS_REGION` | `user_config.aps_region` (default `US`) | must be `US`, `EMEA` or `AUS` |
| `APS_AUTH_MODE=ssa`, `FORMA_TRANSPORT=stdio`, `FORMA_PERSISTENCE_MODE=memory` | fixed | |

`FORMA_AUDIT_DIR` is deliberately not set: with `BIMLYNX_DATA_DIR` set the server defaults it to
`<data dir>/audit` itself (`src/config/env.ts`), which avoids joining a Windows path and `/audit`
inside the manifest. The server also expands a literal `${HOME}` / `~` in the data dir in case a
client passes the default through unsubstituted.

## Startup modes (src/selfhost/credentials.ts)

1. `SSA_ID`/`SSA_KEY_ID`/`SSA_KEY_PATH` set → original env path (never set by this bundle).
2. `<data dir>/robot.json` + `robot-key.pem` present → full tool set as that robot.
3. Neither → **setup mode**: only `setup_status` and `setup_create_robot`. After the robot is
   created the user restarts Claude Desktop and lands in (2).

## Verified so far (2026-10-27, Windows)

- Bundle started from a folder with no `node_modules`: setup mode serves the 2 setup tools; with
  credentials it serves all 46 tools and `dm_list_hubs` / `aecdm_list_hubs` return live data;
  a robot read from `robot.json` authenticates (existing robot, no new one created).
- `setup_status` against a real APS app: credentials accepted, service-account quota read.
- Claude Desktop on this machine runs Electron 44.9.3 — its bundled Node is well above the
  `node >=20` the manifest declares.

**Not yet verified:** install inside Claude Desktop itself (Windows + macOS), `setup_create_robot`
against real APS (it creates a real service account — part of the end-to-end drill), and whether
a Forma Build team's capacity is what gets charged (SPEC R3).

**Not signed** — Claude Desktop shows an unverified-publisher notice, same as `bundle/`.
