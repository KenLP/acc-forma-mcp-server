import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AnyToolDef } from '../../src/tools/_types.js';

// The registry pulls in tools that import safety/allowlist.js, which imports config/env.js
// — and env.js THROWS at import time when APS creds are absent. Mock env before importing
// the registry, exactly as tests/unit/tools/registry-scope.spec.ts does.
let toolRegistry: AnyToolDef[];

interface ManifestTool {
  name: string;
  description: string;
  mutating: boolean;
}

beforeAll(async () => {
  vi.resetModules();
  vi.doMock('../../src/config/env.js', () => ({
    env: {
      FORMA_ALLOWED_HUBS: '*',
      FORMA_ALLOWED_PROJECTS: '*',
      FORMA_RATE_CONFIG_PATH: undefined,
    },
  }));
  ({ toolRegistry } = await import('../../src/tools/_registry.js'));
});

/**
 * mcp-manifest.json is the Autodesk marketplace submission artifact. A mismatch between it
 * and the real tool set (a tool missing from the manifest, a stale entry for a removed
 * tool, or a wrong `mutating` flag) is a failure mode Autodesk explicitly flags in review.
 * This has drifted before and was only ever caught by hand — these tests catch it in CI.
 */
describe('mcp-manifest.json stays in sync with the tool registry', () => {
  const manifest = JSON.parse(readFileSync('mcp-manifest.json', 'utf-8')) as {
    tools: ManifestTool[];
  };

  it('the set of tool names in the manifest exactly equals the registry', () => {
    const manifestNames = new Set(manifest.tools.map((t) => t.name));
    const registryNames = new Set(toolRegistry.map((t) => t.name));

    const missingFromManifest = [...registryNames].filter((n) => !manifestNames.has(n)).sort();
    const extraInManifest = [...manifestNames].filter((n) => !registryNames.has(n)).sort();

    expect(
      missingFromManifest,
      `tools in the registry but missing from mcp-manifest.json: ${JSON.stringify(missingFromManifest)}`,
    ).toEqual([]);
    expect(
      extraInManifest,
      `tools in mcp-manifest.json but not in the registry (stale entries): ${JSON.stringify(extraInManifest)}`,
    ).toEqual([]);
  });

  it('every manifest tool\'s `mutating` flag matches the registry tool\'s `kind`', () => {
    const byName = new Map(toolRegistry.map((t) => [t.name, t]));
    const mismatches: string[] = [];

    for (const mt of manifest.tools) {
      const rt = byName.get(mt.name);
      if (!rt) continue; // covered by the name-sync test above
      const expectedMutating = rt.kind === 'mutation';
      if (mt.mutating !== expectedMutating) {
        mismatches.push(
          `${mt.name}: manifest says mutating=${mt.mutating}, registry kind is '${rt.kind}' (expected mutating=${expectedMutating})`,
        );
      }
    }

    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });

  it('every manifest tool has a non-empty description', () => {
    const empty = manifest.tools.filter((t) => !t.description || !t.description.trim()).map((t) => t.name);
    expect(empty, `manifest tools with an empty description: ${JSON.stringify(empty)}`).toEqual([]);
  });

  it('has no duplicate tool names', () => {
    const seen = new Map<string, number>();
    for (const t of manifest.tools) {
      seen.set(t.name, (seen.get(t.name) ?? 0) + 1);
    }
    const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([name]) => name);
    expect(duplicates, `duplicate tool names in mcp-manifest.json: ${JSON.stringify(duplicates)}`).toEqual([]);
  });
});
