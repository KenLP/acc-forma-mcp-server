import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { getMdManifest } from '../../apis/model-derivative.js';
import type { MdDerivativeChild } from '../../apis/model-derivative.js';
import { checkUnscopedToolAllowed } from '../../safety/allowlist.js';

const inputSchema = z.object({
  urn: z
    .string()
    .min(1)
    .describe(
      'Item version URN from Data Management — get it from dm_list_versions. ' +
        'Accepts both raw URN (starts with "urn:adsk.") and base64url-encoded form. ' +
        'This is a DM version URN, NOT an AECDM elementGroupId.',
    ),
});

export const mdGetManifestTool: ReadToolDef<typeof inputSchema> = {
  name: 'md_get_manifest',
  title: 'Get Model Derivative Manifest',
  description:
    'Model Derivative API — returns the translation status and available views ' +
    '(3D/2D view GUIDs) for a model version, and diagnostic detail for translation ' +
    'failures. Takes a DM version URN. File/URN-based, distinct from the AEC Data ' +
    "Model's semantic BIM queries (elements by category, parameter values, " +
    'element counts).',
  kind: 'read',
  scopes: ['data:read'],
  preferredAuth: '2lo',
  inputSchema,

  execute: async (input, ctx) => {
    checkUnscopedToolAllowed('md_get_manifest', 'Model Derivative URN');
    const auth = ctx.auth2lo ?? ctx.auth;
    const manifest = await getMdManifest(auth, input.urn);

    // Collect geometry views from SVF2 derivative
    const svf2 = manifest.derivatives?.find((d) => d.outputType === 'svf2');
    const views3d: Array<{ guid: string; name: string }> = [];
    const views2d: Array<{ guid: string; name: string }> = [];

    function walk(children: MdDerivativeChild[] | undefined): void {
      for (const child of children ?? []) {
        if (child.type === 'geometry') {
          const entry = { guid: child.guid, name: child.name ?? 'unnamed' };
          if (child.role === '3d') views3d.push(entry);
          else if (child.role === '2d') views2d.push(entry);
        }
        if (child.children) walk(child.children);
      }
    }
    walk(svf2?.children);

    const statusIcon: Record<string, string> = {
      success: '✓', inprogress: '⏳', pending: '⏳', failed: '✗', timeout: '✗',
    };
    const icon = statusIcon[manifest.status] ?? '?';

    const lines: string[] = [
      `Status:   ${icon} ${manifest.status}  (${manifest.progress})`,
      `Region:   ${manifest.region ?? 'unknown'}`,
    ];

    if (svf2) {
      lines.push(`SVF2:     ${svf2.status}`);
      if (views3d.length > 0) {
        lines.push('', `3D views (${views3d.length}):`);
        views3d.forEach((v) => lines.push(`  • ${v.name}  guid: ${v.guid}`));
      }
      if (views2d.length > 0) {
        lines.push('', `2D views (${views2d.length}):`, ...views2d.slice(0, 10).map((v) => `  • ${v.name}  guid: ${v.guid}`));
        if (views2d.length > 10) lines.push(`  … and ${views2d.length - 10} more`);
      }
    } else {
      lines.push('SVF2:     not available');
      lines.push('', 'Tip: Run md_trigger_translation to request SVF2 output, then poll md_get_manifest for status.');
    }

    const otherTypes = manifest.derivatives?.filter((d) => d.outputType !== 'svf2') ?? [];
    if (otherTypes.length > 0) {
      lines.push('', `Other derivatives: ${otherTypes.map((d) => `${d.outputType} (${d.status})`).join(', ')}`);
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        status: manifest.status,
        progress: manifest.progress,
        region: manifest.region,
        hasSvf2: !!svf2,
        views3d,
        views2d: views2d.slice(0, 50),
      },
    };
  },
};
