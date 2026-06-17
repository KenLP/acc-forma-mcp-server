# Backlog: ACC Issue Pushpins — 2D Raster Pin "Unavailable" Problem

> Status: **ROOT CAUSE CONFIRMED — PLATFORM LIMITATION**
> 2D raster pins (TwoDRasterPushpin) require an internal ACC Docs markup record that
> is NOT creatable via any public APS API. The `POST /issues` endpoint stores metadata
> only; the ACC Docs viewer renders pins from a separate internal markup record.

---

## What works vs what doesn't

| | Works? | Notes |
|---|---|---|
| 3D vector pins (TwoDVectorPushpin, is3D:true) | ✅ | Issues #100/#102/#103/#105 — renders in model viewer |
| 2D raster pin created via ACC Docs UI | ✅ | Issue #1 — shows pin location in DWG viewer |
| 2D raster pin created via API (programmatic) | ❌ | All programmatic issues: "unavailable" / "markup deleted" |

---

## Definitive root cause (confirmed 2026-06-17)

When the ACC Docs UI places a pin on a 2D sheet, it creates TWO records:
1. **Issue record** — stored via `POST /construction/issues/v1/projects/{pid}/issues` with `linkedDocuments` (the public endpoint we use)
2. **Markup record** — stored in an **internal ACC Docs markup service** (no public API)

The `snapshotUrn` field on the issue (e.g., `urn:adsk.objects:os.object:wip.dm.prod/{uuid}.jpg`) is a handle to this markup record. The ACC Docs viewer resolves the pin from the **markup record**, NOT from `placements[]`/`linkedDocuments[0].details.position`.

**Proof sequence:**
- Issue #109 with correct `linkedDocuments` + `placements` → **"unavailable"** (no markup record → no `snapshotUrn`)
- Patched issue #109's `snapshotUrn` with issue #1's value → **"markup deleted"** (viewer found issue #1's markup record, but it's associated with a different issue)
- All markups endpoints probed (30+ patterns at developer.api.autodesk.com and acc.autodesk.com) → **404** for all

**Endpoint patterns probed (all returned 404 with SSA token):**
```
/construction/issues/v1/projects/{pid}/markups
/construction/issues/v1/projects/{pid}/issues/{id}/markups
/construction/markup/v1/projects/{pid}/markups
/construction/markups/v1/projects/{pid}/markups
/fieldservice/v1/containers/{pid}/pushpins
/fieldservice/v1/containers/{pid}/pushpins/{id}
/construction/pushpins/v1/projects/{pid}/pushpins
/markup/v{1,2}/containers/{pid}/markups
/markup/v{1,2}/projects/{pid}/markups
/construction/docs/v1/projects/{pid}/markups
/construction/snapshot/v{1,2}/projects/{pid}/snapshots
/issues/v{1,2}/projects/{pid}/pushpins
...and 20+ more variations
```

**Autodesk official statement confirms this:**
> "Document specific issues (a.k.a. pushpin issues) are not supported in the ACC Issues API."
> "Creation of a push-in is only available through the Viewer Pushpin extension; creating
> a push-in directly at the server side using POST endpoint is not currently supported."

---

## Ground truth: issue #1 (working, created via ACC Docs UI)

```
Project:    Ken-MCP  (PID 57deb033-4608-46de-ab21-fcb0404de6d3)
Issue ID:   b782cbb2-0f81-4485-96bc-dd1b153417a7
displayId:  1
File:       Q43_A-FE03----_PO126-.dwg  (lineage EeUtfZAdQmG8yUfkp4GB5g)
snapshotUrn: urn:adsk.objects:os.object:wip.dm.prod/5806547d-6df6-49da-b761-5c5678a9755e.jpg
```

GET response — `linkedDocuments[0]` (what the API stores — NOT what renders the pin):
```json
{
  "type": "TwoDRasterPushpin",
  "urn": "urn:adsk.wipprod:dm.lineage:EeUtfZAdQmG8yUfkp4GB5g",
  "createdAtVersion": 1,
  "details": {
    "viewable": {
      "id": "3d08fd40-6f7c-bb0a-981f-d0554edcdf59",
      "viewableId": "Layout1",
      "guid": "3d08fd40-6f7c-bb0a-981f-d0554edcdf59",
      "name": "Layout1",
      "is3D": false
    },
    "position": { "x": 0.6039, "y": 0.5439 }
  }
}
```

GET response — `placements[0]` (stored correctly, but NOT used for pin rendering):
```json
{
  "type": "file",
  "createdAtVersion": 1,
  "lineageUrn": "urn:adsk.wipprod:dm.lineage:EeUtfZAdQmG8yUfkp4GB5g",
  "viewable": { "viewableId": "Layout1", "guid": "3d08fd40-6f7c-bb0a-981f-d0554edcdf59", "name": "Layout1", "is3D": false },
  "originContext": { "product": "docs", "tool": "files" }
}
```

---

## What our programmatic issues correctly DO

Even though the pin won't render in the ACC Docs viewer, a programmatic `TwoDRasterPushpin` issue:
- ✅ Appears in the issues list
- ✅ Has correct `linkedDocuments` / `placements` structure (matches issue #1 structurally)
- ✅ Shows the associated document (clicking shows the document without the pin)
- ✅ Has `originContext` correctly at top level (triggering the "docs routing" for the issue)
- ❌ Does NOT render a visual pin on the document
- ❌ Shows "This issue is unavailable. Adjust your filters and try again." in ACC Docs

---

## All attempted fixes (in order, for institutional memory)

### Fix 1: Add `viewable.guid` alongside `viewableId`
- **Status**: ✅ Necessary (prevents `guid:null` stored → "unavailable" variant)
- **Not sufficient**: still "unavailable" after fix

### Fix 2: Move `originContext` to top level of linkedDocument (commits 0ebd97c, 32c99c7)
- **Status**: ✅ Correct structural change — `placements[0].originContext` now correct in GET
- **Not sufficient**: doesn't fix viewer rendering (viewer uses markup record, not placements)

### Fix 3: POST `placements` field with `type:"sheet"` + `pins:[]`
- **Status**: ❌ Schema error — 3D-only; no 2D variant exists

### Fix 4: PATCH `snapshotUrn` with working issue's value
- **Status**: ❌ PATCH accepted (HTTP 200) but viewer shows "markup deleted" (not "unavailable")
- **Confirmed**: snapshotUrn IS the markup record handle; can't borrow another issue's record

### Fix 5: PATCH `snapshotHasMarkups: false`
- **Status**: ❌ PATCH accepted (HTTP 200, snapshotHasMarkups: null → false)
- **No change**: still "markup deleted" / "unavailable" — snapshotHasMarkups alone does nothing

---

## Current code state (correct, keep as-is)

All code changes are committed and correct. The `TwoDRasterPushpin` structure IS the right
shape — the limitation is at the platform level, not in our code.

### Key files
- `src/apis/pushpin.ts` — `buildRasterPushpin()`, coord helpers
- `src/apis/issues.ts` — `LinkedDocument` interface
- `src/tools/issues/create.ts` — `issues_create` MutationToolDef (validates raster contract)
- `tests/unit/tools/aecdm/pushpin.spec.ts` — pushpin unit tests
- `tests/unit/tools/issues/linked-documents.spec.ts` — issues_create Zod validation tests

### Reference issues in Ken-MCP test project
| displayId | id | Description |
|---|---|---|
| #1 | b782cbb2-... | ✅ WORKING — hand-placed DWG pin via ACC Docs UI |
| #100/#102 | — | ✅ 3D vector pins — render in model viewer |
| #106 | 2301007d-... | ❌ DWG raster — old structure |
| #107 | — | ❌ PDF raster — old structure |
| #108 | b31f9336-... | ❌ DWG raster — originContext probe |
| #109 | bfb0e1f3-... | ❌ DWG raster — fully patched (correct structure + snapshotUrn + snapshotHasMarkups) |
| #110 | 13f3221f-... | ❌ PDF raster — v4 fix |

### Key URNs / GUIDs
```
DWG lineage:    urn:adsk.wipprod:dm.lineage:EeUtfZAdQmG8yUfkp4GB5g
DWG viewableId: Layout1
DWG guid:       3d08fd40-6f7c-bb0a-981f-d0554edcdf59

PDF lineage:    urn:adsk.wipprod:dm.lineage:zoh3ja5XRyW94kaEbxuKUg
PDF viewableId: 1
PDF guid:       90676fc9-3b78-54a6-96d5-6a59252761e3

Working snapshot (issue #1):  urn:adsk.objects:os.object:wip.dm.prod/5806547d-6df6-49da-b761-5c5678a9755e.jpg
```

---

## If this ever gets unblocked

The unlock condition is: Autodesk exposing a public API to create markup records in the
ACC Docs markup service. Watch for:
- New endpoint at `developer.api.autodesk.com/construction/markup/...`
- APS forum announcement about programmatic pushpin support for ACC Docs 2D views
- Field in `POST /issues` response that populates `snapshotUrn` automatically

Until then, alternatives:
1. **Instruct users to place 2D pins via ACC Docs UI** — the issue will be created with a working pin
2. **Use 3D vector pins (TwoDVectorPushpin + is3D:true)** for model elements — fully supported
3. **Use APS Viewer with BIM360 PushPin extension** — the supported programmatic path for 3D pins

---

## External references
- ACC Issues API v1: https://aps.autodesk.com/en/docs/issues/v1/reference/http/
- Official limitation statement: https://aps.autodesk.com/en/docs/issues/v1/reference/http/ (pushpin section)
- Autodesk C# SDK gen files: `IssuesApi.gen.cs` etc. in project root
