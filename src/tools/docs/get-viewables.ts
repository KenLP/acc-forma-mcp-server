import { z } from 'zod';
import type { ReadToolDef } from '../_types.js';
import { getMdManifest, extractDocsViewables } from '../../apis/model-derivative.js';

const inputSchema = z.object({
  urn: z
    .string()
    .min(1)
    .describe(
      'Document version URN from Data Management (dm_list_versions / dm_get_item tipVersionId). ' +
        'Accepts raw URN (starts with "urn:adsk.") or base64url-encoded form. ' +
        'This is a DM version URN — NOT an AECDM elementGroupId.',
    ),
});

export const docsGetViewablesTool: ReadToolDef<typeof inputSchema> = {
  name: 'docs_get_viewables',
  title: 'Get ACC Docs Viewables (for 2D PDF pushpins)',
  description:
    'Resolves ACC Docs-native viewable IDs for a document, required to place a 2D ' +
    'PDF pushpin (TwoDRasterPushpin). A TwoDRasterPushpin keys on ' +
    '`details.viewable.viewableId` — a Docs-native id such as "Layout1" (a DWG ' +
    'layout) or a PDF page id — distinct from the SVF2 `guid` returned by ' +
    '`md_get_manifest`; the markups service rejects SVF2 GUIDs for raster pins. ' +
    'Returns, for each 2D viewable, `viewableId`, `name` (page/sheet label), the ' +
    'SVF2 `guid`, and `role`; 3D viewables are returned too. A document with no ' +
    'viewables has not been processed by ACC Docs / Model Derivative and is not ' +
    'markup-capable.',
  kind: 'read',
  scopes: ['data:read'],
  preferredAuth: '2lo',
  // The lookup goes to the Model Derivative manifest, which is addressed by URN alone and
  // is not project-scoped. This tool used to take an optional project_id purely so the
  // allow-list would fire — but nothing tied that project to the URN, so a caller could
  // name an allowed project and read a document from any other one. Refuse instead.
  scope: { kind: 'unmappable', resource: 'document version URN' },
  inputSchema,

  execute: async (input, ctx) => {
    const auth = ctx.auth2lo ?? ctx.auth;
    const manifest = await getMdManifest(auth, input.urn);
    const viewables = extractDocsViewables(manifest);

    const views2d = viewables.filter((v) => v.role === '2d');
    const views3d = viewables.filter((v) => v.role === '3d');
    // Only 2D viewables that carry a Docs-native viewableId can anchor a TwoDRasterPushpin.
    const rasterCapable = views2d.filter((v) => v.viewableId);

    const lines: string[] = [`Translation: ${manifest.status} (${manifest.progress})`];

    if (manifest.status !== 'success') {
      lines.push(
        '',
        '⚠ Document is not fully processed yet — viewables may be incomplete or absent.',
        '  Poll md_get_manifest until status=success, then retry.',
      );
    }

    if (rasterCapable.length > 0) {
      lines.push('', `2D viewables usable for a TwoDRasterPushpin (${rasterCapable.length}):`);
      rasterCapable.forEach((v) =>
        lines.push(`  • viewableId: "${v.viewableId}"   name: ${v.name}`),
      );
    } else {
      lines.push(
        '',
        'No markup-capable 2D viewable found (no derivative node carried a viewableId).',
        'This document cannot anchor a TwoDRasterPushpin yet. To fix:',
        '  • If it is a PDF uploaded via the Data Management API, it may not be processed by ACC',
        '    Docs. Re-publish it through ACC Docs (or the ACC Sheets API upload→extract→publish',
        '    pipeline) so a Docs-native viewable is created.',
        '  • If translation just finished, allow a moment and retry.',
      );
    }

    // Surface 2D viewables that exist but lack a viewableId — they expose only an SVF2 guid,
    // which the markups service will reject for a raster pin.
    const guidOnly2d = views2d.filter((v) => !v.viewableId);
    if (guidOnly2d.length > 0) {
      lines.push(
        '',
        `2D viewables WITHOUT a Docs-native viewableId (${guidOnly2d.length}) — SVF2 guid only, ` +
          `NOT usable for a raster PDF pin:`,
      );
      guidOnly2d.slice(0, 10).forEach((v) => lines.push(`  • name: ${v.name}   guid: ${v.guid}`));
    }

    if (views3d.length > 0) {
      lines.push('', `3D viewables (${views3d.length}) — for vector/3D pins, keyed by guid:`);
      views3d.slice(0, 10).forEach((v) => lines.push(`  • name: ${v.name}   guid: ${v.guid}`));
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        status: manifest.status,
        markupCapable: rasterCapable.length > 0,
        rasterViewables: rasterCapable,
        views2d,
        views3d,
      },
    };
  },
};
