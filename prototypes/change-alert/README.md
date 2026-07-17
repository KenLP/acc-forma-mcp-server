# Change-Alert Prototype

Cross-discipline **change alerting** on top of model version diffs.

> When the Architectural model changes between versions, automatically triage the
> changes by structural impact and raise an ACC issue — **pinned to the exact changed
> element** — telling the **Structural** team what to re-check.

This is a standalone prototype (not an MCP tool). It reuses the core SDK
(`acc-forma-mcp-server/core`).

## Why this beats Forma "Compare Versions"

Forma's Compare already lists what changed and filters by category. Its export (and UI)
stops at three things this prototype adds:

| Gap in Forma Compare | Added here |
|---|---|
| **#1 HOW it changed** — the export just says "Geometry" / "Attribute", no magnitude | `severity.ts` renders quantified `old → new (Δ …)` and rates each change CRITICAL…LOW by structural impact |
| **#2 No element id** — a changed row can't be located in the model | `pin.ts` drops a 3D pushpin on the exact element (via the diff's `externalId`), with objectId so ACC isolates it |
| **#3 No issue** — Compare is read-only | one ACC issue per affected discipline, ranked by severity, routed automatically |

The value isn't detecting the change (Forma does that) — it's the **judgment** (which of
208 modified rows actually matter) and the **location** (a click-to-jump pin).

## Pipeline

```
[1] TRIGGER  detect a new model version
[2] DIFF     mp_diff_versions  (Model Properties API, SSA — no 3LO)
[3] TRIAGE   severity.ts       (HOW it changed + does it MATTER — CRITICAL…LOW)
     RULES   rules.ts          (category / property change → discipline)
[4] ALERT    one ACC issue per discipline, PINNED to the worst changed element
```

Live on the Arch model v3→v4: the diff reports 65 added / 45 removed / 208 modified;
triage routes 45 to Structural, keeps **6 CRITICAL** (moved columns), suppresses 39 as
noise, and pins the issue to a changed column (`objectId` resolved for view isolation).

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

## [3] Triage (`severity.ts`) + Rules (`rules.ts`)

**`rules.ts`** — routing: which discipline cares (category/property change → discipline).
**`severity.ts`** — impact: how much it matters. Two orthogonal layers, both pure + unit-tested.

Severity classification (Structural lens):

| Element | Change | Severity |
|---|---|---|
| Structural member (joist/column/beam/framing) | removed, moved (Transform), or re-hosted (level/offset param) | **CRITICAL** |
| Structural member | added, or geometry reshaped | HIGH |
| Wall | added / removed | HIGH |
| Wall | geometry reshaped | MEDIUM |
| Wall | finish/type attribute only | LOW (noise) |
| Floor / slab | added / removed / geometry | HIGH |
| anything else | — | LOW |

`describeChange()` turns a raw property delta into `Start Level Offset: 0 → 7600 (Δ +7600)`
(gap #1). The alert only fires at/above `MIN_SEVERITY` (default `HIGH`), reporting how many
low-impact changes it suppressed.

## [4] Alert + pin (`pin.ts`)

One ACC issue per discipline, titled `[Auto] Structural review — <model> vN→vM (6 critical)`,
body ranked by severity with the quantified "what changed" per element. The issue is **pinned
to the worst point-placed changed element** — `pin.ts` reuses the same core APIs as the
`issues_pin_element` tool (manifest → AECDM origin → viewer coords → `buildPushpin`), walking
the ranked candidates until one resolves an AECDM origin (walls/linear members have none).

**DRY-RUN by default** — resolves the pin coordinates (read-only) and prints the payload but
creates nothing. Set `CREATE_ISSUES=1` to create the draft issue with the pin attached.

## Run

```bash
npx tsx prototypes/change-alert/index.mts                      # dry-run, latest two versions
PREV=3 CUR=4 npx tsx prototypes/change-alert/index.mts         # explicit version pair
MIN_SEVERITY=MEDIUM npx tsx prototypes/change-alert/index.mts  # lower the alert threshold
CREATE_ISSUES=1 PREV=3 CUR=4 npx tsx prototypes/change-alert/index.mts  # create draft issue + pin
```

Uses the repo `.env` for SSA credentials. The project is supplied by env vars — the
prototype ships with no project baked in:

| Var | Required | Meaning |
|---|---|---|
| `ALERT_AECDM_PROJECT_ID` | yes | AEC Data Model project id (`urn:adsk.workspace:prod.project:…`), from `aecdm_list_projects` |
| `ALERT_DM_PROJECT_ID` | yes | Data Management project id **without** the `b.` prefix — used for the diff and for creating issues |
| `ALERT_WATCH_MODEL` | yes | File name of the model to watch, exactly as listed by `aecdm_list_element_groups` |
| `ALERT_GLOBAL_OFFSET` | no (default `0,0,0`) | The model's viewer `globalOffset` as `x,y,z`. Read it once from any existing pin (`issues_get` → `viewerState.globalOffset`); without it the pin lands in global coordinates. |

## Not yet (design questions for productionizing)

- **Trigger** → move from polling to an APS webhook (`dm.version.added`).
- **Rule mapping** → richer table (per-category → discipline), maybe per-project config.
- **Room "function"** → currently keys on Room Name/Department/Occupancy text; a real
  policy might map specific occupancy classes to load categories.
- **Dedup / noise** → partly handled: `MIN_SEVERITY` suppresses LOW changes. A finer model
  would read the full property set (via `md_get_properties`) to confirm a wall is load-bearing
  before rating it, and to quantify the displacement of a `Transform` change (the diff exposes
  the change *type* but not the vector).
- **Bearing detection** → severity currently keys on category + change type + which params
  changed; it does not yet read `Structural Usage` to separate bearing from partition walls.
