import { z } from 'zod';
import type { MutationToolDef, ToolContext } from '../_types.js';
import {
  createIssue,
  listIssueTypes,
  type CreateIssuePayload,
} from '../../apis/issues.js';
import { stripBPrefix } from '../../utils/project-id.js';
import { registerValidator, BusinessRuleError } from '../../safety/business-rules.js';
import {
  getMdManifest,
  getMdProperties,
  getMdViews,
  extractDocsViewables,
} from '../../apis/model-derivative.js';
import { queryElementPositions, validateCategoryName } from '../../apis/aecdm.js';
import {
  aecdmPositionToViewer,
  buildPushpin,
  METERS_TO_FEET,
  type Vec3,
} from '../../apis/pushpin.js';
import { apsRequest } from '../../http/client.js';

const APS_BASE = 'https://developer.api.autodesk.com';

/**
 * Derive the DM lineage URN from a file version URN.
 *   'urn:adsk.wipprod:fs.file:vf.XXXXX?version=N' → 'urn:adsk.wipprod:dm.lineage:XXXXX'
 */
function lineageFromVersionUrn(versionUrn: string): string {
  const match = /^urn:adsk\.wipprod:fs\.file:vf\.([^?]+)/.exec(versionUrn);
  if (!match) {
    throw new Error(
      `Cannot derive lineage from "${versionUrn}". Expected urn:adsk.wipprod:fs.file:vf.XXXXX?version=N.`,
    );
  }
  return `urn:adsk.wipprod:dm.lineage:${match[1]!}`;
}

// ---- Input schema ----------------------------------------------------------

const inputSchema = z.object({
  project_id: z
    .string()
    .min(1)
    .describe(
      'ACC project ID (with or without b. prefix). Get from dm_list_projects or admin_list_projects.',
    ),
  element_group_id: z
    .string()
    .min(1)
    .describe(
      'AECDM element group ID for the model. Get from aecdm_list_element_groups. ' +
        'Note: AECDM element group IDs differ from DM IDs — always use aecdm_list_element_groups.',
    ),
  category: z
    .string()
    .min(1)
    .describe(
      'BIM category name of the element (e.g. "Doors", "Pipe Fittings", "Structural Columns"). ' +
        'Only point-placed categories have a geometry origin in AECDM. ' +
        'Linear (Pipes, Ducts, Beams) and planar (Walls, Floors, Ceilings) elements return ' +
        'position: null and cannot be auto-pinned.',
    ),
  element_external_id: z
    .string()
    .min(1)
    .describe(
      'Revit UniqueId of the element — the AECDM "External ID" property. ' +
        'Found in aecdm_query_element_positions results as the externalId field. ' +
        'This is the durable element anchor used to look up the objectId in the chosen viewable.',
    ),
  model_version_urn: z
    .string()
    .startsWith('urn:adsk.wipprod:fs.file:')
    .describe(
      'File version URN of the model (urn:adsk.wipprod:fs.file:vf.XXXXX?version=N). ' +
        'Get from aecdm_list_element_groups → fileVersionUrn, or dm_list_versions → id. ' +
        'The tool derives the DM lineage URN internally for the pushpin; you only need this one URN.',
    ),
  global_offset: z
    .object({ x: z.number(), y: z.number(), z: z.number() })
    .optional()
    .describe(
      'Viewer globalOffset for this model: viewer_pos = aecdm_metres × unit_factor − global_offset. ' +
        'If omitted, auto-detected from existing pins on this model via filter[linkedDocumentUrn]. ' +
        'Defaults to {x:0,y:0,z:0} with a WARNING when no existing pins are found. ' +
        'Known calibrated offsets (Ken-MCP test project) — ' +
        'Plumbing model (vf.zxhzGseAS7yHZSRRho0H1A?version=3): {x:-14.327438466,y:3.055270374,z:26.715703010}; ' +
        'Architectural model (vf.mMOB5AnzRTO6kouVvXmlRw?version=4): {x:-19.068394820,y:-5.405197144,z:25.708333651}.',
    ),
  unit_factor: z
    .number()
    .positive()
    .default(METERS_TO_FEET)
    .describe(
      'Scale factor from AECDM metres to viewer units. ' +
        '3.280839895 (default) for imperial feet, 1 for metric metres, 1000 for millimetres.',
    ),
  viewable_name_hint: z
    .string()
    .optional()
    .describe(
      'Substring to match against 3D view names when multiple 3D views exist ' +
        '(e.g. "{3D}", "3D Plumbing", "Coordination"). If omitted, the first 3D viewable is used.',
    ),
  // Issue fields
  title: z
    .string()
    .min(1)
    .max(500)
    .describe('Issue title (required, max 500 characters).'),
  issue_subtype_id: z
    .string()
    .min(1)
    .describe(
      'Issue subtype ID (required). Use issues_list_types to get valid IDs for this project.',
    ),
  status: z
    .enum(['draft', 'open', 'pending', 'in_review', 'closed', 'void'])
    .default('open')
    .describe('Initial issue status. Defaults to "open".'),
  description: z
    .string()
    .max(10_000)
    .optional()
    .describe('Optional issue description (max 10,000 characters).'),
  published: z
    .boolean()
    .default(false)
    .describe(
      'Whether the issue is visible to all project members. false (default) = draft/unpublished.',
    ),
  assigned_to: z.string().optional().describe('Autodesk user ID to assign this issue to.'),
  assigned_to_type: z
    .enum(['user', 'company', 'role'])
    .optional()
    .describe('Required when assigned_to is set: "user" | "company" | "role".'),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
    .optional()
    .describe('Due date in YYYY-MM-DD format.'),
  location_id: z.string().optional().describe('Location node ID from the project location tree.'),
  root_cause_id: z
    .string()
    .optional()
    .describe('Root cause ID. Use issues_list_root_causes to get valid IDs.'),
});

type PinElementInput = z.infer<typeof inputSchema>;

// ---- Business rules ---------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/require-await
registerValidator<PinElementInput>('issues_pin_element', async (input, _ctx) => {
  const passed: string[] = [];

  if (input.due_date) {
    const today = new Date().toISOString().slice(0, 10);
    if (input.due_date < today) {
      throw new BusinessRuleError(
        'due_date_must_be_future',
        `due_date "${input.due_date}" is in the past (today is ${today}). ` +
          `Provide a current or future date.`,
      );
    }
    passed.push('due_date_is_current_or_future');
  }

  if (input.assigned_to && !input.assigned_to_type) {
    throw new BusinessRuleError(
      'assigned_to_type_required',
      `assigned_to_type is required when assigned_to is set. ` +
        `Provide one of: "user", "company", "role".`,
    );
  }
  if (input.assigned_to) passed.push('assigned_to_type_present');

  return { passed };
});

// ---- Resolution logic -------------------------------------------------------

interface ResolvedPin {
  viewableGuid: string;
  viewableName: string;
  viewerPosition: Vec3;
  objectId: number | undefined;
  globalOffset: Vec3;
  globalOffsetSource: 'provided' | 'existing_pin' | 'fallback_zero';
  aecdmElementName: string;
  subtypeTitle: string;
  linkedDocument: ReturnType<typeof buildPushpin>;
  issueBody: CreateIssuePayload;
}

async function resolvePin(input: PinElementInput, ctx: ToolContext): Promise<ResolvedPin> {
  const pid = stripBPrefix(input.project_id);
  // Derive DM lineage URN (used for pin urn + globalOffset filter) from the version URN
  const lineageUrn = lineageFromVersionUrn(input.model_version_urn);

  // 1. Validate issue_subtype_id
  const types = await listIssueTypes(ctx.auth, input.project_id);
  const subtype = types.flatMap((t) => t.subtypes).find((s) => s.id === input.issue_subtype_id);
  if (!subtype) {
    throw new BusinessRuleError(
      'issue_subtype_id_must_exist',
      `issue_subtype_id "${input.issue_subtype_id}" not found in project ${input.project_id}. ` +
        `Call issues_list_types to get valid subtype IDs.`,
    );
  }
  if (!subtype.isActive) {
    throw new BusinessRuleError(
      'issue_subtype_must_be_active',
      `issue_subtype_id "${input.issue_subtype_id}" ("${subtype.title}") is inactive. ` +
        `Call issues_list_types and pick an active subtype.`,
    );
  }

  // 2. Parallel: MD manifest + AECDM positions
  validateCategoryName(input.category);
  const [manifest, aecdmPositions] = await Promise.all([
    getMdManifest(ctx.auth, input.model_version_urn),
    queryElementPositions(ctx.auth, input.element_group_id, input.category, {
      maxElements: 2000,
    }),
  ]);

  // 3. Pick 3D viewable (prefer hint when multiple views exist)
  const viewables3d = extractDocsViewables(manifest).filter((v) => v.role === '3d');
  if (viewables3d.length === 0) {
    throw new BusinessRuleError(
      'no_3d_viewable',
      `No 3D viewable found in the manifest for model ${input.model_version_urn}. ` +
        `Run md_trigger_translation first and wait for status "success".`,
    );
  }
  let chosen = viewables3d[0]!;
  if (input.viewable_name_hint) {
    const hint = input.viewable_name_hint.toLowerCase();
    const matched = viewables3d.find((v) => v.name.toLowerCase().includes(hint));
    if (matched) chosen = matched;
  }

  // 4. Find element by externalId in AECDM results
  const aecdmEl = aecdmPositions.find((e) => e.externalId === input.element_external_id);
  if (!aecdmEl) {
    const samples = aecdmPositions
      .filter((e) => e.externalId)
      .slice(0, 5)
      .map((e) => `"${e.name}" (${e.externalId ?? '—'})`)
      .join(', ');
    throw new BusinessRuleError(
      'element_not_found',
      `Element with externalId "${input.element_external_id}" not found in category ` +
        `"${input.category}" of element group ${input.element_group_id}. ` +
        (samples ? `Sample elements: ${samples}. ` : '') +
        `Use aecdm_query_element_positions to find the correct externalId.`,
    );
  }
  if (!aecdmEl.position) {
    throw new BusinessRuleError(
      'element_has_no_geometry',
      `Element "${aecdmEl.name}" (externalId: ${input.element_external_id}) has no geometry ` +
        `origin in AECDM. Only point-placed elements (Doors, Pipe Fittings, Plumbing Fixtures, ` +
        `Columns) have positions. Linear (Pipes, Ducts, Beams) and planar (Walls, Floors, ` +
        `Ceilings) elements return position: null and cannot be auto-pinned.`,
    );
  }

  // 5. globalOffset: use explicit value or auto-detect from existing pins
  let globalOffset: Vec3;
  let globalOffsetSource: ResolvedPin['globalOffsetSource'];

  if (input.global_offset) {
    globalOffset = input.global_offset;
    globalOffsetSource = 'provided';
  } else {
    const issuesResp = await apsRequest<{
      results?: Array<{
        linkedDocuments?: Array<{
          details?: {
            viewerState?: { globalOffset?: { x: number; y: number; z: number } };
          };
        }>;
      }>;
    }>(ctx.auth, `/construction/issues/v1/projects/${pid}/issues`, {
      baseUrl: APS_BASE,
      params: { 'filter[linkedDocumentUrn]': lineageUrn, limit: 5 },
    });

    let found: Vec3 | undefined;
    outer: for (const issue of issuesResp.results ?? []) {
      for (const doc of issue.linkedDocuments ?? []) {
        const go = doc.details?.viewerState?.globalOffset;
        if (go && typeof go.x === 'number' && typeof go.y === 'number' && typeof go.z === 'number') {
          found = { x: go.x, y: go.y, z: go.z };
          break outer;
        }
      }
    }

    if (found) {
      globalOffset = found;
      globalOffsetSource = 'existing_pin';
    } else {
      globalOffset = { x: 0, y: 0, z: 0 };
      globalOffsetSource = 'fallback_zero';
    }
  }

  // 6. Convert AECDM metres → viewer space
  const viewerPosition = aecdmPositionToViewer(aecdmEl.position, globalOffset, input.unit_factor);

  // 7. Resolve objectId via MD properties (best-effort; enables "View in Model" deep link)
  // NOTE: /manifest and /metadata use DIFFERENT GUID namespaces. getMdProperties requires
  // the /metadata GUID — getMdViews retrieves them, matched by view name to chosen.
  let objectId: number | undefined;
  try {
    const metaViews = await getMdViews(ctx.auth, input.model_version_urn);
    const metaView =
      metaViews.find((v) => v.name === chosen.name && v.role === '3d') ??
      metaViews.find((v) => v.role === '3d');
    if (metaView) {
      const mdElements = await getMdProperties(ctx.auth, input.model_version_urn, {
        viewGuid: metaView.guid,
        categoryFilter: input.category,
        maxResults: 2000,
      });
      const mdEl = mdElements.find((e) => e.externalId === input.element_external_id);
      if (mdEl) objectId = mdEl.objectId;
    }
  } catch {
    // objectId is optional — proceed without it; pin will still render but won't highlight element
  }

  // 8. Build pushpin linkedDocument
  // Extract version number from model_version_urn (?version=N) — required by ACC Issues API.
  const versionMatch = /[?&]version=(\d+)/.exec(input.model_version_urn);
  const createdAtVersion = versionMatch ? parseInt(versionMatch[1]!, 10) : undefined;
  // seedURN = URL-safe base64 of the version URN (no padding), placed in viewerState.
  const seedUrn = Buffer.from(input.model_version_urn).toString('base64url');

  const linkedDocument = buildPushpin({
    lineageUrn,
    viewableGuid: chosen.guid,
    viewableName: chosen.name,
    ...(chosen.viewableId !== undefined ? { viewableId: chosen.viewableId } : {}),
    position: viewerPosition,
    ...(objectId !== undefined ? { objectId } : {}),
    externalId: input.element_external_id,
    ...(createdAtVersion !== undefined ? { createdAtVersion } : {}),
    globalOffset,
    seedUrn,
  });

  // 9. Build issue body
  const issueBody: CreateIssuePayload = {
    title: input.title,
    issueSubtypeId: input.issue_subtype_id,
    status: input.status,
    published: input.published,
    linkedDocuments: [linkedDocument],
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.assigned_to !== undefined ? { assignedTo: input.assigned_to } : {}),
    ...(input.assigned_to_type !== undefined ? { assignedToType: input.assigned_to_type } : {}),
    ...(input.due_date !== undefined ? { dueDate: input.due_date } : {}),
    ...(input.location_id !== undefined ? { locationId: input.location_id } : {}),
    ...(input.root_cause_id !== undefined ? { rootCauseId: input.root_cause_id } : {}),
  };

  return {
    viewableGuid: chosen.guid,
    viewableName: chosen.name,
    viewerPosition,
    objectId,
    globalOffset,
    globalOffsetSource,
    aecdmElementName: aecdmEl.name,
    subtypeTitle: subtype.title,
    linkedDocument,
    issueBody,
  };
}

// ---- Tool definition --------------------------------------------------------

export const pinElementTool: MutationToolDef<typeof inputSchema> = {
  name: 'issues_pin_element',
  title: 'Create ACC Issue with 3D Element Pin',
  description:
    'Creates an ACC issue and places a 3D pushpin on a specific BIM element in one ' +
    'call, resolving the viewable GUID, element objectId, and viewer position ' +
    'server-side, including the geometry-to-viewer coordinate transform. Only ' +
    'point-placed elements (Doors, Pipe Fittings, Columns, Plumbing Fixtures) have ' +
    'a geometry origin and can be pinned; linear (Pipes, Beams) and planar (Walls, ' +
    'Floors) elements have no position. globalOffset is auto-detected from ' +
    'existing pins on the model if omitted, or can be provided explicitly for ' +
    'highest accuracy.',
  kind: 'mutation',
  scopes: ['data:read', 'data:write'],
  requiredAuthModes: ['ssa', '3lo'],
  // The issue is written to project_id, but to build the pushpin this tool first reads an
  // AECDM element group and a Model Derivative URN — neither of which can be tied back to
  // that project. Checking project_id alone would let an allowed project be named while
  // model data was read from a project outside the allow-list, so refuse instead.
  // getProjectId still applies: rate governance and the audit entry need the target project.
  scope: { kind: 'unmappable', resource: 'AECDM element group id + Model Derivative URN' },
  inputSchema,

  getProjectId: (input) => input.project_id,

  buildPreview: async (input, ctx) => {
    const pid = stripBPrefix(input.project_id);
    const resolved = await resolvePin(input, ctx);
    const url = `${APS_BASE}/construction/issues/v1/projects/${pid}/issues`;

    const pos = resolved.viewerPosition;
    const posStr = `(${pos.x.toFixed(4)}, ${pos.y.toFixed(4)}, ${pos.z.toFixed(4)})`;

    const sideEffects = [
      `Create 1 issue titled "${input.title}" (status: ${input.status}, published: ${String(input.published)}) in project ${input.project_id}`,
      `Pin to element "${resolved.aecdmElementName}" (externalId: ${input.element_external_id})`,
      `Viewable: "${resolved.viewableName}" (guid: ${resolved.viewableGuid})`,
      `Viewer position (feet): ${posStr}`,
      ...(resolved.objectId !== undefined
        ? [`objectId resolved: ${resolved.objectId} — "View in Model" deep link will isolate the element`]
        : [`objectId not resolved — pin will render but the viewer will not highlight the element`]),
      ...(resolved.globalOffsetSource === 'fallback_zero'
        ? [
            `WARNING: global_offset defaulted to (0,0,0) — no existing pins found for model ` +
              `${input.model_version_urn}. Pin X/Y position will be in global space and may appear ` +
              `off-model. Provide global_offset explicitly for accuracy.`,
          ]
        : [`globalOffset source: ${resolved.globalOffsetSource} → (${resolved.globalOffset.x}, ${resolved.globalOffset.y}, ${resolved.globalOffset.z})`]),
    ];

    return {
      method: 'POST',
      url,
      body: resolved.issueBody,
      sideEffects,
      businessRulesPassed: [
        'issue_subtype_id_exists_in_project',
        'issue_subtype_is_active',
        'element_found_in_aecdm_category',
        'element_has_geometry_origin',
        ...(resolved.globalOffsetSource !== 'fallback_zero' ? ['global_offset_calibrated'] : []),
        ...(resolved.objectId !== undefined ? ['object_id_resolved'] : []),
        ...(input.due_date ? ['due_date_is_current_or_future'] : []),
      ],
      executePayload: { toolName: 'issues_pin_element', projectId: pid, body: resolved.issueBody },
    };
  },

  execute: async (input, ctx) => {
    const resolved = await resolvePin(input, ctx);
    const issue = await createIssue(ctx.auth, input.project_id, resolved.issueBody);

    const pos = resolved.viewerPosition;
    const posStr = `(${pos.x.toFixed(4)}, ${pos.y.toFixed(4)}, ${pos.z.toFixed(4)})`;

    const warnings: string[] = [];
    if (resolved.globalOffsetSource === 'fallback_zero') {
      warnings.push(
        `WARNING: global_offset defaulted to (0,0,0) — pin position may be inaccurate. ` +
          `Provide global_offset explicitly and re-pin for accuracy.`,
      );
    }
    if (resolved.objectId === undefined) {
      warnings.push(
        `Note: objectId not resolved — pin will render but element will not be isolated in viewer.`,
      );
    }

    return {
      content: [
        {
          type: 'text',
          text:
            `Issue created with 3D element pin.\n` +
            `ID:       ${issue.id}\n` +
            `Title:    ${issue.title}\n` +
            `Status:   ${issue.status}\n` +
            `Element:  ${resolved.aecdmElementName} (${input.element_external_id})\n` +
            `Viewable: ${resolved.viewableName} (${resolved.viewableGuid})\n` +
            `Position: ${posStr}\n` +
            (warnings.length > 0 ? `\n${warnings.join('\n')}` : ''),
        },
      ],
      structuredContent: {
        issue,
        pin: {
          viewableGuid: resolved.viewableGuid,
          viewableName: resolved.viewableName,
          viewerPosition: resolved.viewerPosition,
          objectId: resolved.objectId,
          globalOffset: resolved.globalOffset,
          globalOffsetSource: resolved.globalOffsetSource,
          aecdmElementName: resolved.aecdmElementName,
          externalId: input.element_external_id,
        },
      },
    };
  },
};
