import type { z } from 'zod';
import type { AuthProvider } from '../auth/index.js';
import type { Env } from '../config/env.js';

export type ToolKind = 'read' | 'mutation';

/**
 * Auth modes that support this tool.
 * '2lo' = client_credentials (DM + Admin only — sees all hub projects)
 * 'ssa' = Secure Service Account JWT (Issues, Reviews, AECDM — sees assigned projects)
 * '3lo' = 3-legged OAuth (Phase 3, user context)
 * Omit field = supported by all modes.
 */
export type AuthMode = '2lo' | 'ssa' | '3lo';

/**
 * How a tool's input binds to the hub/project allow-list.
 *
 * The allow-list holds Data Management ids (`b.<guid>`), so a tool can only be checked
 * against it when its input carries an id from that namespace. The wrapper used to find
 * that id by *field name* — reading whatever was called `project_id` or `hub_id`. That was
 * wrong twice over: tools whose scoping id has another name (`element_group_id`, `urn`)
 * were never checked at all, and `aecdm_list_element_groups` — whose `project_id` field
 * holds an AECDM-native id, a different namespace — was checked against DM ids, which both
 * fails to protect anything and rejects legitimate calls.
 *
 * Every tool must now declare its case. The field is required, so a new tool cannot
 * silently inherit "unchecked": omitting it is a type error.
 */
export type ToolScope =
  /** Input carries DM-format ids. The wrapper reads them via getHubId / getProjectId. */
  | { kind: 'dm' }
  /** No scoping input; execute() filters its own results against the allow-list. */
  | { kind: 'discovery' }
  /** Touches no ACC hub or project at all (e.g. reads the local audit log). */
  | { kind: 'no-resource' }
  /**
   * Acts on an id that cannot be mapped back to a DM hub/project — an AECDM-native id or
   * a Model Derivative URN, whose endpoints are not project-scoped. While either allow-list
   * is active such a tool is refused: we cannot prove the resource is inside the allow-list,
   * and proceeding anyway would break the promise the manifest makes.
   */
  | { kind: 'unmappable'; resource: string };

export interface ToolContext {
  auth: AuthProvider;
  /** 2-legged provider for tools that need hub-wide project visibility. */
  auth2lo?: AuthProvider;
  env: Env;
}

export type McpToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export interface ReadToolDef<TSchema extends z.ZodTypeAny> {
  name: string;
  title: string;
  description: string;
  kind: 'read';
  scopes: string[];
  /** If set, tool only works in these auth modes. Omit = all modes supported. */
  requiredAuthModes?: AuthMode[];
  /**
   * '2lo' = prefer 2-legged auth (hub-wide visibility: all projects).
   * Omit = use default SSA auth.
   */
  preferredAuth?: '2lo';
  /** How this tool binds to the hub/project allow-list. Enforced by wrapReadTool. */
  scope: ToolScope;
  /** Extract the DM hub ID for the hub allow-list check. Required when scope.kind is 'dm'. */
  getHubId?: (input: z.infer<TSchema>) => string | undefined;
  /** Extract the DM project ID for the project allow-list check. Required when scope.kind is 'dm'. */
  getProjectId?: (input: z.infer<TSchema>) => string | undefined;
  inputSchema: TSchema;
  execute: (input: z.infer<TSchema>, ctx: ToolContext) => Promise<McpToolResult>;
}

export interface MutationPreviewResult {
  method: string;
  url: string;
  body: unknown;
  sideEffects: string[];
  businessRulesPassed: string[];
  /** Exact payload that gets hashed and bound to the approval token */
  executePayload: unknown;
}

export interface MutationToolDef<TSchema extends z.ZodTypeAny> {
  name: string;
  title: string;
  description: string;
  kind: 'mutation';
  scopes: string[];
  /** If set, tool only works in these auth modes. Omit = all modes supported. */
  requiredAuthModes?: AuthMode[];
  /**
   * '2lo' = prefer 2-legged auth (hub-wide visibility: all projects).
   * Omit = use default SSA auth.
   */
  preferredAuth?: '2lo';
  /** How this tool binds to the hub/project allow-list. Enforced by wrapMutationTool. */
  scope: ToolScope;
  inputSchema: TSchema;
  /** Extract hub ID for hub allow-list check */
  getHubId?: (input: z.infer<TSchema>) => string | undefined;
  /**
   * Extract the DM project ID. Drives the allow-list check when scope.kind is 'dm', and
   * always drives rate governance + the audit entry's project_id — an 'unmappable' tool
   * such as issues_pin_element still writes to a known project even though its AECDM/URN
   * cross-references cannot be checked.
   */
  getProjectId?: (input: z.infer<TSchema>) => string | undefined;
  /** Build preview (validates business rules, resolves IDs, no APS write) */
  buildPreview: (input: z.infer<TSchema>, ctx: ToolContext) => Promise<MutationPreviewResult>;
  /** Execute the actual APS call */
  execute: (input: z.infer<TSchema>, ctx: ToolContext) => Promise<McpToolResult>;
}

export type AnyToolDef = ReadToolDef<z.ZodTypeAny> | MutationToolDef<z.ZodTypeAny>;
