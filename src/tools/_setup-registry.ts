import type { z } from 'zod';
import type { AnyToolDef, MutationToolDef } from './_types.js';
import { setupStatusTool } from './setup/status.js';
import { setupCreateRobotTool } from './setup/create-robot.js';

/**
 * Tools registered while the self-host server is in setup mode — no SSA robot yet, so the
 * product tools in `_registry.ts` could not authenticate (src/selfhost/credentials.ts).
 *
 * Kept out of `_registry.ts` on purpose: that list is the product surface locked to
 * mcp-manifest.json by tests/unit/manifest-sync.spec.ts, and these two are never served
 * alongside it.
 */
export const setupToolRegistry: AnyToolDef[] = [
  setupStatusTool as AnyToolDef,
  // Concrete TPayload — same widening cast as issues_pin_element in _registry.ts.
  setupCreateRobotTool as unknown as MutationToolDef<z.ZodTypeAny>,
];
