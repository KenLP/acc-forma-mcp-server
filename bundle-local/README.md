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
- It then starts the same file with a throwaway robot in the data folder — once plainly, once
  with `SSA_*` vars leaking in from the environment — and requires the 39-tool self-host set
  both times (no `admin_*`, no `webhooks_*`). That is the read-scope promise below, checked on
  the built artifact.
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

1. `SSA_ID`/`SSA_KEY_ID`/`SSA_KEY_PATH` set → those credentials pick the robot (never set by this
   bundle; can leak in from the OS environment). Read scope is still the one below.
2. `<data dir>/robot.json` + `robot-key.pem` present → the self-host tool set (39) as that robot.
3. Neither → **setup mode**: only `setup_status` and `setup_create_robot`. After the robot is
   created the user restarts Claude Desktop and lands in (2).

## Read scope: only the projects the robot was invited to

`BIMLYNX_DATA_DIR` is set only by this bundle, and `src/index.ts` keys the self-host rules off
it — not off where the credentials came from:

- **SSA only.** No 2-legged token for project data is ever created. (The run-from-source path
  attaches one so `dm_*`/`admin_*`/`md_*` see the whole hub; a 2LO token is hub-wide no matter
  what the ACC custom integration shows for the robot — measured: 298 projects for a robot
  invited to a handful.) The SSA token does not request `account:read` either.
- **Tools left out** (`buildServer` mode `'self-host'`, `selfHostExclusion()`): the 4
  `admin_*` tools, marked `accountLevel` — the Account Admin API answers for the whole hub —
  and the 3 `webhooks_*` tools, which run only on 2LO.
- **Fail closed.** `buildServer` refuses to start in self-host mode if a 2-legged provider is
  attached, and `index.ts` refuses `APS_AUTH_MODE` other than `ssa` when the data dir is set.

Setup mode is the one place a 2-legged token exists: it carries only the service-account
management scopes `setup_create_robot` needs, no `data:read`.

## Verified so far (2026-10-27, Windows)

- Bundle started from a folder with no `node_modules`: setup mode serves the 2 setup tools; with
  credentials it serves all 46 tools and `dm_list_hubs` / `aecdm_list_hubs` return live data;
  a robot read from `robot.json` authenticates (existing robot, no new one created).
- `setup_status` against a real APS app: credentials accepted, service-account quota read.
- Claude Desktop on this machine runs Electron 44.9.3 — its bundled Node is well above the
  `node >=20` the manifest declares.

## Verified on macOS (2026-11-09, Claude Desktop, Apple Silicon)

- Install from the `.mcpb`, setup mode, `setup_create_robot` against real APS (robot created,
  1/10 slots), restart into the full tool set, custom integration, first reads.
- That run found the read-scope gap the section above closes: `dm_list_projects` listed all
  298 hub projects, and `md_get_manifest` read a model in a project the robot is not a member
  of. Re-tested on the SSA-only build (2026-11-12): the robot's 2 projects only, and the same
  model read is refused by Model Derivative; reads in the robot's own projects unaffected.

**Not yet verified:** install inside Claude Desktop on Windows, and whether a Forma Build team's
capacity is what gets charged (SPEC R3).

**Not signed** — Claude Desktop shows an unverified-publisher notice, same as `bundle/`.
