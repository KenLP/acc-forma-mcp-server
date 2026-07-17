import { describe, it, expect } from 'vitest';
import { toolRegistry } from '../../../src/tools/_registry.js';
import type { AnyToolDef } from '../../../src/tools/_types.js';

/**
 * Registry-wide invariants for the allow-list scope declaration.
 *
 * The bug these lock down: wrapReadTool used to find the id to allow-list check by *field
 * name*, reading whatever input was called `project_id` / `hub_id`. Tools whose scoping id
 * had a different name (`element_group_id`, `urn`) were never checked, and
 * aecdm_list_element_groups — whose `project_id` field holds an AECDM-native id from a
 * different id space — was checked against DM ids, which protects nothing.
 *
 * `scope` being a required field makes TypeScript catch a missing declaration. These tests
 * cover what the type system cannot: that the declaration is internally consistent, and
 * that a tool cannot claim 'dm' without supplying an id for the wrapper to check.
 */
describe('tool registry — allow-list scope declarations', () => {
  const byName = (n: string): AnyToolDef => {
    const t = toolRegistry.find((x) => x.name === n);
    if (!t) throw new Error(`tool ${n} not in registry`);
    return t;
  };

  it('every registered tool declares a scope', () => {
    const missing = toolRegistry.filter((t) => t.scope === undefined).map((t) => t.name);
    expect(missing, 'tools missing a scope declaration').toEqual([]);
  });

  it("every 'dm'-scoped tool supplies at least one id getter for the wrapper to check", () => {
    // A 'dm' scope with neither getter would silently pass the allow-list — the exact
    // hole this refactor closes, reintroduced by omission.
    const toothless = toolRegistry
      .filter((t) => t.scope.kind === 'dm')
      .filter((t) => t.getHubId === undefined && t.getProjectId === undefined)
      .map((t) => t.name);
    expect(toothless, "'dm' scope with no getHubId and no getProjectId").toEqual([]);
  });

  it("every 'unmappable' tool names the resource it cannot map", () => {
    const unnamed = toolRegistry
      .filter((t) => t.scope.kind === 'unmappable')
      .filter((t) => !(t.scope as { resource: string }).resource.trim())
      .map((t) => t.name);
    expect(unnamed).toEqual([]);
  });

  it('no tool declares a scope kind outside the union', () => {
    for (const t of toolRegistry) {
      expect(['dm', 'discovery', 'no-resource', 'unmappable'], t.name).toContain(t.scope.kind);
    }
  });

  // The AECDM id space is distinct from Data Management's: aecdm_list_projects returns the
  // AECDM project id and dataManagementProjectId side by side precisely because they differ.
  // So no AECDM tool may claim 'dm' — that claim is what produced a check against the wrong
  // id space.
  it('no AECDM tool claims dm scope', () => {
    const wrong = toolRegistry
      .filter((t) => t.name.startsWith('aecdm_'))
      .filter((t) => t.scope.kind === 'dm')
      .map((t) => t.name);
    expect(wrong).toEqual([]);
  });

  // Model Derivative is addressed by URN and is not project-scoped, so no md_/docs_ tool
  // can bind to the allow-list either.
  it('URN-addressed tools are declared unmappable', () => {
    for (const name of [
      'md_get_manifest',
      'md_get_properties',
      'md_trigger_translation',
      'docs_get_viewables',
    ]) {
      expect(byName(name).scope.kind, name).toBe('unmappable');
    }
  });

  // These call project-scoped endpoints (/construction/index/v2/projects/{id}/,
  // /bim360/*/v3/containers/{id}), so checking project_id genuinely bounds them.
  it('project-scoped API tools bind to the project allow-list', () => {
    for (const name of ['mp_diff_versions', 'mc_list_clashes', 'mc_list_modelsets']) {
      const t = byName(name);
      expect(t.scope.kind, name).toBe('dm');
      expect(t.getProjectId, `${name} must supply getProjectId`).toBeDefined();
    }
  });

  it('issues_pin_element is unmappable despite writing to a known project', () => {
    // It reads an AECDM element group + an MD URN to build the pin. project_id alone does
    // not bound those reads, so it must not claim 'dm' — but getProjectId still has to be
    // present for rate governance and the audit entry.
    const t = byName('issues_pin_element');
    expect(t.scope.kind).toBe('unmappable');
    expect(t.getProjectId).toBeDefined();
  });

  it('every mutation tool that buckets a rate limit exposes getProjectId', async () => {
    const { DEFAULT_RATE_CONFIG } = await import('../../../src/safety/rate-governance.js');
    for (const name of Object.keys(DEFAULT_RATE_CONFIG)) {
      const t = byName(name);
      expect(t.getProjectId, `${name} is rate-limited per project but has no getProjectId`).toBeDefined();
    }
  });
});
