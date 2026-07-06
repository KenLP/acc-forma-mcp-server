# Change-Alert Prototype

Cross-discipline **change alerting** on top of model version diffs.

> When the Architectural model changes between versions — a room's function flips
> (meeting room → office), or walls/columns are added/modified — automatically
> raise an ACC issue telling the **Structural** team to re-check the calculation.

This is a standalone prototype (not an MCP tool). It reuses the core SDK
(`acc-forma-mcp-server/core`).

## Pipeline

```
[1] TRIGGER  detect a new model version
[2] DIFF     mp_diff_versions  (Model Properties API, SSA — no 3LO)
[3] RULES    rules.ts          (category / property change → discipline)
[4] ALERT    one ACC issue per discipline  (issues API; DRY-RUN by default)
```

## [1] Trigger — how do we know a new version exists?

Two options:

| | **Polling** (implemented here) | **Webhooks** (production) |
|---|---|---|
| Mechanism | Periodically read the model's latest version and compare to a saved marker | APS **Webhooks API** pushes `dm.version.added` / `dm.version.modified` to your callback |
| Needs a public URL | No | **Yes** (HTTPS callback endpoint) |
| Latency | Poll interval | Near-instant |
| Best for | Prototype / cron job | Real deployment |

This prototype polls **one AEC Data Model call** — `listAecdmElementGroups` returns each
model's current `fileVersionUrn` (which embeds `?version=N`). It compares `N` against
`.state.json`; when `N` increases, it diffs `v(N-1) → vN`. No folder traversal, no public
endpoint. For production, swap `detectNewVersion()` for a webhook handler that receives the
new version URN directly — the rest of the pipeline is unchanged.

## [2] Diff

`modelPropertiesApi.createVersionDiff` → poll → `downloadDiffProperties` (with per-element
`changes`: old → new values). Requires the two versions to share an element-stable lineage
(consecutive Revit/DWG/NWC/IFC versions of one file).

## [3] Rules (`rules.ts`)

A pure, data-driven table — the policy layer. Prototype rules (all → Structural):

| Rule | Fires when |
|---|---|
| `room-function-change` | a `Rooms` element's **Room Name / Department / Occupancy** changed |
| `walls-added-or-changed` | a `Walls` element was added or modified |
| `columns-added-or-changed` | a column element was added or modified |

Extend by adding rows (e.g. `Ducts`/`Mechanical Equipment` changed → `MEP`). Unit-tested in
`rules.spec.ts` (including the room meeting-room→office case).

## [4] Alert

One ACC issue per triggered discipline, titled `[Auto] Structural review — <model> vN→vM`,
body listing each rule's reason + sample elements (room changes show `old → new`).
**DRY-RUN by default** (prints the payload). Set `CREATE_ISSUES=1` to actually create it
(as an unpublished draft).

## Run

```bash
npx tsx prototypes/change-alert/index.mts                 # dry-run, latest two versions
FORCE=1 npx tsx prototypes/change-alert/index.mts         # ignore saved state
PREV=3 CUR=4 npx tsx prototypes/change-alert/index.mts    # explicit version pair
CREATE_ISSUES=1 npx tsx prototypes/change-alert/index.mts # create the ACC issue (draft)
```

Uses the repo `.env` (SSA creds). Config (project ids, watched model) is at the top of
`index.mts`.

## Not yet (design questions for productionizing)

- **Trigger** → move from polling to an APS webhook (`dm.version.added`).
- **Rule mapping** → richer table (per-category → discipline), maybe per-project config.
- **Room "function"** → currently keys on Room Name/Department/Occupancy text; a real
  policy might map specific occupancy classes to load categories.
- **Dedup / noise** → a `Transform`-only change (element just nudged) may not warrant an alert.
