import { describe, it, expect } from 'vitest';
import { extractDocsViewables, type MdManifest } from '../../../../src/apis/model-derivative.js';

/**
 * Ground truth: issue displayId 1 in the Ken-MCP test project pins a TwoDRasterPushpin with
 * viewableId "Layout1" onto Q43_A-FE03----_PO126-.dwg. "Layout1" is the DWG layout name —
 * the manifest geometry node's `viewableID`, NOT its SVF2 `guid`. extractDocsViewables() must
 * surface that id so callers can build a working raster pin.
 */
describe('extractDocsViewables — Docs-native viewable extraction', () => {
  it('surfaces the DWG layout viewableId ("Layout1") from a 2D geometry node', () => {
    const manifest: MdManifest = {
      urn: 'urn:adsk.wipprod:fs.file:vf.abc?version=1',
      status: 'success',
      progress: 'complete',
      derivatives: [
        {
          outputType: 'svf2',
          status: 'success',
          children: [
            {
              guid: 'svf2-guid-2ac1',
              type: 'geometry',
              role: '2d',
              name: 'Layout1',
              viewableID: 'Layout1',
              children: [{ guid: 'res-1', type: 'resource', role: 'graphics' }],
            },
          ],
        },
      ],
    };

    const viewables = extractDocsViewables(manifest);
    expect(viewables).toHaveLength(1);
    expect(viewables[0]).toMatchObject({
      viewableId: 'Layout1',
      name: 'Layout1',
      guid: 'svf2-guid-2ac1',
      role: '2d',
      outputType: 'svf2',
    });
  });

  it('omits viewableId when the geometry node has no viewableID (SVF2 guid only)', () => {
    const manifest: MdManifest = {
      urn: 'urn:x',
      status: 'success',
      progress: 'complete',
      derivatives: [
        {
          outputType: 'svf2',
          status: 'success',
          children: [{ guid: 'g-1', type: 'geometry', role: '2d', name: 'Sheet 1' }],
        },
      ],
    };

    const [v] = extractDocsViewables(manifest);
    expect(v?.viewableId).toBeUndefined();
    expect(v?.guid).toBe('g-1');
  });

  it('collects 3D viewables too and ignores non-geometry nodes', () => {
    const manifest: MdManifest = {
      urn: 'urn:x',
      status: 'success',
      progress: 'complete',
      derivatives: [
        {
          outputType: 'svf2',
          status: 'success',
          children: [
            { guid: '3d-1', type: 'geometry', role: '3d', name: '{3D}', viewableID: 'abc-3d' },
            { guid: 'thumb', type: 'resource', role: 'thumbnail' },
            { guid: '2d-1', type: 'geometry', role: '2d', name: 'A-101', viewableID: 'A-101' },
          ],
        },
      ],
    };

    const viewables = extractDocsViewables(manifest);
    expect(viewables.map((v) => v.role).sort()).toEqual(['2d', '3d']);
    expect(viewables.find((v) => v.role === '3d')?.viewableId).toBe('abc-3d');
  });

  it('walks nested children across multiple derivatives', () => {
    const manifest: MdManifest = {
      urn: 'urn:x',
      status: 'success',
      progress: 'complete',
      derivatives: [
        {
          outputType: 'svf2',
          status: 'success',
          children: [
            {
              guid: 'parent',
              type: 'folder',
              role: 'viewables',
              children: [
                { guid: 'nested', type: 'geometry', role: '2d', name: 'Page 2', viewableID: '2' },
              ],
            },
          ],
        },
      ],
    };

    const viewables = extractDocsViewables(manifest);
    expect(viewables).toHaveLength(1);
    expect(viewables[0]?.viewableId).toBe('2');
  });

  it('returns an empty array when the manifest has no derivatives (not markup-capable)', () => {
    const manifest: MdManifest = {
      urn: 'urn:x',
      status: 'inprogress',
      progress: '50%',
      derivatives: [],
    };
    expect(extractDocsViewables(manifest)).toEqual([]);
  });
});
