import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import {
  createVersionDiff,
  getVersionDiff,
  downloadDiffFields,
  downloadDiffProperties,
  rollupDiff,
  type DiffElement,
} from '../../apis/model-properties.js';

const inputSchema = z.object({
  project_id: z
    .string()
    .min(1)
    .describe('ACC project ID (with or without b. prefix). From dm_list_projects / admin_list_projects.'),
  prev_version_urn: z
    .string()
    .min(1)
    .describe(
      'DM version URN of the PREVIOUS (older) version — e.g. ' +
        '"urn:adsk.wipprod:fs.file:vf.XXXX?version=3". From dm_list_versions or ' +
        'aecdm_list_element_groups (fileVersionUrn). Must be the SAME file lineage as cur_version_urn.',
    ),
  cur_version_urn: z
    .string()
    .min(1)
    .describe('DM version URN of the CURRENT (newer) version of the same file — e.g. "...?version=4".'),
  diff_id: z
    .string()
    .optional()
    .describe(
      'Resume a diff already started in a prior call (returned as diffId when the first call ' +
        'timed out while still PROCESSING). When set, the tool just polls instead of creating a new diff.',
    ),
  category_filter: z
    .string()
    .optional()
    .describe(
      'Case-insensitive substring filter on the Revit category of changed elements ' +
        '(e.g. "Rooms", "Walls", "Structural"). Omit to include all categories.',
    ),
  wait_seconds: z
    .number()
    .int()
    .min(0)
    .max(110)
    .default(50)
    .describe('How long to poll for the diff to finish before returning a resumable diff_id. Default 50s.'),
  max_elements: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .default(2000)
    .describe('Cap on changed elements downloaded/detailed. Rollup counts still reflect all downloaded rows.'),
  include_changes: z
    .boolean()
    .default(false)
    .describe(
      'Include the per-element list of changed parameters (old → new value) in structuredContent. ' +
        'Needed to detect WHAT changed (e.g. a Room whose "Room Name"/"Department" changed = a function change). ' +
        'Off by default to keep the response lean.',
    ),
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const mpDiffVersionsTool: ReadToolDef<typeof inputSchema> = {
  name: 'mp_diff_versions',
  title: 'Diff Two Model Versions (Model Properties API)',
  description:
    'Model Properties API (index v2) version diff — the backend of ACC\'s Compare ' +
    'Versions. Given two versions of the same file lineage, computes server-side ' +
    'which design elements were added, removed, or modified, whether each change is ' +
    'a Transform (moved/rotated) or a Geometry change, and rolls the changes up by ' +
    'Revit category. Element IDs must be stable between the two versions ' +
    '(consecutive Revit/DWG/NWC/IFC versions of one file). Works with SSA auth ' +
    '(no 3LO needed). The diff computation is asynchronous; if still processing ' +
    'when `wait_seconds` elapses, the response includes a `diff_id` identifying the ' +
    'in-progress computation.',
  kind: 'read',
  scopes: ['data:read'],
  // SSA is proven against the live API; 3LO is the mode Autodesk's own Model Properties
  // docs describe. 2LO is deliberately absent — it has never been exercised here, and
  // claiming a mode we have not run is the kind of declaration/behaviour gap this server
  // is built to avoid.
  requiredAuthModes: ['ssa', '3lo'],
  inputSchema,

  execute: async (input, ctx) => {
    const { project_id, prev_version_urn, cur_version_urn } = input;

    // 1) Create (or resume) the diff.
    let status = input.diff_id
      ? await getVersionDiff(ctx.auth, project_id, input.diff_id)
      : await createVersionDiff(ctx.auth, project_id, prev_version_urn, cur_version_urn);

    // 2) Poll until FINISHED / FAILED or the wait budget is exhausted.
    const deadline = Date.now() + input.wait_seconds * 1000;
    while (status.state !== 'FINISHED' && status.state !== 'FAILED' && Date.now() < deadline) {
      await sleep(4000);
      status = await getVersionDiff(ctx.auth, project_id, status.diffId);
    }

    if (status.state === 'FAILED') {
      return {
        content: [{ type: 'text', text: `Diff ${status.diffId} FAILED. Check that both versions belong to the same file lineage and are translated.` }],
        structuredContent: { diffId: status.diffId, state: status.state },
      };
    }

    if (status.state !== 'FINISHED') {
      return {
        content: [
          {
            type: 'text',
            text:
              `Diff still processing (state: ${status.state}). ` +
              `Call mp_diff_versions again with diff_id="${status.diffId}" to resume ` +
              `(same project_id / version urns).`,
          },
        ],
        structuredContent: { diffId: status.diffId, state: status.state, resumable: true },
      };
    }

    // 3) FINISHED — download fields + properties, resolve, roll up.
    if (!status.fieldsUrl || !status.propertiesUrl) {
      return {
        content: [{ type: 'text', text: `Diff ${status.diffId} finished but returned no result URLs (stats only: ${JSON.stringify(status.stats)}).` }],
        structuredContent: { diffId: status.diffId, state: status.state, stats: status.stats },
      };
    }

    const fields = await downloadDiffFields(ctx.auth, status.fieldsUrl);
    let elements = await downloadDiffProperties(ctx.auth, status.propertiesUrl, fields, input.max_elements);

    if (input.category_filter) {
      const f = input.category_filter.toLowerCase();
      elements = elements.filter((e) => (e.category ?? '').toLowerCase().includes(f));
    }

    const rollup = rollupDiff(elements);
    const stats = status.stats ?? { added: 0, removed: 0, modified: 0 };

    const catLines = rollup.byCategory
      .slice(0, 25)
      .map((c) => {
        const parts = [
          c.added ? `+${c.added}` : '',
          c.removed ? `-${c.removed}` : '',
          c.changed ? `~${c.changed}` : '',
        ].filter(Boolean).join(' ');
        return `• ${c.category}: ${parts}  (${c.total})`;
      });

    const ctLines = Object.entries(rollup.byChangeType)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');

    const sample = (kind: DiffElement['kind']): string => {
      const items = elements.filter((e) => e.kind === kind).slice(0, 8);
      if (items.length === 0) return '';
      const rows = items.map(
        (e) => `    - ${e.name ?? '(unnamed)'} [${e.category ?? '?'}]${e.changeType ? ` (${e.changeType})` : ''}`,
      );
      return `\n  ${kind}:\n${rows.join('\n')}`;
    };

    const filterNote = input.category_filter ? ` (filter: "${input.category_filter}")` : '';
    const text =
      `Version diff — prev ${status.prevVersionUrns[0] ?? '?'} → cur ${status.curVersionUrns[0] ?? '?'}\n` +
      `Whole-model stats: +${stats.added} added, -${stats.removed} removed, ~${stats.modified} modified.\n\n` +
      `Changed elements by category${filterNote}  (+added / -removed / ~changed):\n` +
      (catLines.length ? catLines.join('\n') : '  (none)') +
      (ctLines ? `\n\nChange types: ${ctLines}` : '') +
      `\n\nSamples:${sample('ADDED')}${sample('REMOVED')}${sample('CHANGED')}` +
      `\n\n(diffId ${status.diffId} — cached; re-run is instant. Use category-level counts to route ` +
      `cross-discipline alerts.)`;

    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        diffId: status.diffId,
        state: status.state,
        stats,
        prevVersionUrn: status.prevVersionUrns[0],
        curVersionUrn: status.curVersionUrns[0],
        byCategory: rollup.byCategory,
        byChangeType: rollup.byChangeType,
        elements: input.include_changes ? elements : elements.map(({ changes: _c, ...rest }) => rest),
        elementCount: elements.length,
        categoryFilter: input.category_filter ?? null,
      },
    };
  },
};
