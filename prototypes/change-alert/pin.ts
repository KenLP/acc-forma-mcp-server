// Pin step — attach a 3D pushpin to the auto-created issue at the exact changed element.
//
// This closes gap #2 (Forma's Compare export has no element id, so a change can't be located
// in the model) and gap #3 (no create-issue-from-compare). The Model Properties diff already
// hands us each changed element's `externalId` (Revit UniqueId) — the durable anchor. From
// there this mirrors the production `issues_pin_element` tool (src/tools/issues/pin-element.ts)
// but as a standalone helper over the published core SDK:
//
//   manifest (3D viewable) + AECDM position (metres) → viewer coords → buildPushpin
//
// Only POINT-PLACED elements (Columns, Doors, Fixtures, Fittings) have an AECDM origin, so
// only those can be auto-pinned. Walls / floors / linear members return position: null.

import { aecdmApi, mdApi, pushpinApi, type AuthProvider } from '../../src/core.js';
import type { LinkedDocument } from '../../src/apis/issues.js';
import type { Vec3 } from '../../src/apis/pushpin.js';

/** Point-placed Revit families that expose an AECDM geometry origin (so can be pinned). */
const PINNABLE_RE =
  /column|door|window|furniture|fixture|fitting|equipment|casework|generic model|planting|lighting|specialty|mechanical equipment|plumbing/i;

export function isPinnable(category: string | undefined): boolean {
  return !!category && PINNABLE_RE.test(category);
}

/** 'urn:adsk.wipprod:fs.file:vf.XXXX?version=N' → 'urn:adsk.wipprod:dm.lineage:XXXX'. */
function lineageFromVersionUrn(versionUrn: string): string {
  const m = /^urn:adsk\.wipprod:fs\.file:vf\.([^?]+)/.exec(versionUrn);
  if (!m) throw new Error(`Cannot derive lineage from "${versionUrn}".`);
  return `urn:adsk.wipprod:dm.lineage:${m[1]!}`;
}

export interface PinInput {
  elementGroupId: string;
  category: string;
  externalId: string;
  modelVersionUrn: string;
  globalOffset: Vec3;
  unitFactor?: number;
}

export interface PinResult {
  linkedDocument: LinkedDocument;
  viewerPosition: Vec3;
  objectId: number | undefined;
  elementName: string;
  viewableName: string;
}

/**
 * Resolve a 3D pushpin for one changed element. Returns null (with a reason logged by the
 * caller) when the element has no AECDM origin — e.g. a wall or a linear member.
 */
export async function buildElementPin(
  auth: AuthProvider,
  input: PinInput,
): Promise<PinResult | { skipped: string }> {
  const lineageUrn = lineageFromVersionUrn(input.modelVersionUrn);
  const unitFactor = input.unitFactor ?? pushpinApi.METERS_TO_FEET;

  // 1. Manifest (3D viewable) + AECDM positions, in parallel.
  const [manifest, positions] = await Promise.all([
    mdApi.getMdManifest(auth, input.modelVersionUrn),
    aecdmApi.queryElementPositions(auth, input.elementGroupId, input.category, { maxElements: 2000 }),
  ]);

  const viewables3d = mdApi.extractDocsViewables(manifest).filter((v) => v.role === '3d');
  if (viewables3d.length === 0) return { skipped: 'no 3D viewable in manifest' };
  const chosen = viewables3d[0]!;

  // 2. Locate the changed element by its diff externalId.
  const el = positions.find((p) => p.externalId === input.externalId);
  if (!el) return { skipped: `externalId ${input.externalId} not found in AECDM "${input.category}"` };
  if (!el.position) return { skipped: `"${el.name}" has no AECDM origin (not point-placed)` };

  // 3. Metres → viewer space.
  const viewerPosition = pushpinApi.aecdmPositionToViewer(el.position, input.globalOffset, unitFactor);

  // 4. Resolve objectId (dbId) so ACC can isolate the element on click. /manifest and
  //    /metadata use different GUID namespaces — match the metadata view by name.
  let objectId: number | undefined;
  try {
    const metaViews = await mdApi.getMdViews(auth, input.modelVersionUrn);
    const metaView =
      metaViews.find((v) => v.name === chosen.name && v.role === '3d') ??
      metaViews.find((v) => v.role === '3d');
    if (metaView) {
      const mdEls = await mdApi.getMdProperties(auth, input.modelVersionUrn, {
        viewGuid: metaView.guid,
        categoryFilter: input.category,
        maxResults: 2000,
      });
      objectId = mdEls.find((m) => m.externalId === input.externalId)?.objectId;
    }
  } catch {
    /* objectId is optional — pin still renders, just won't auto-isolate */
  }

  const versionMatch = /[?&]version=(\d+)/.exec(input.modelVersionUrn);
  const createdAtVersion = versionMatch ? parseInt(versionMatch[1]!, 10) : undefined;
  const seedUrn = Buffer.from(input.modelVersionUrn).toString('base64url');

  const linkedDocument = pushpinApi.buildPushpin({
    lineageUrn,
    viewableGuid: chosen.guid,
    viewableName: chosen.name,
    ...(chosen.viewableId !== undefined ? { viewableId: chosen.viewableId } : {}),
    position: viewerPosition,
    ...(objectId !== undefined ? { objectId } : {}),
    externalId: input.externalId,
    ...(createdAtVersion !== undefined ? { createdAtVersion } : {}),
    globalOffset: input.globalOffset,
    seedUrn,
  });

  return { linkedDocument, viewerPosition, objectId, elementName: el.name, viewableName: chosen.name };
}
