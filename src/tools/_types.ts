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
  /**
   * Remote multi-tenant caller identity (R1 remote transport). Undefined means local
   * single-tenant (stdio) mode — every safety module treats that the same as tenant `''`,
   * so local behavior (audit paths, store keys) is byte-identical to before per-tenant
   * support existed.
   */
  tenantId?: string;
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
  /**
   * Whether this tool is registered under the remote multi-tenant transport (R1,
   * `ctx.tenantId !== undefined`). Omit (or `true`) = available on every transport. `false` =
   * self-host/stdio only — for a tool whose auth model doesn't fit the per-tenant context,
   * e.g. it requires 2-legged auth but `buildTenantContext` deliberately never attaches
   * `auth2lo` (2LO sees every project in the hub, which would defeat tenant isolation).
   */
  remoteEnabled?: boolean;
  /** Extract the DM hub ID for the hub allow-list check. Required when scope.kind is 'dm'. */
  getHubId?: (input: z.infer<TSchema>) => string | undefined;
  /** Extract the DM project ID for the project allow-list check. Required when scope.kind is 'dm'. */
  getProjectId?: (input: z.infer<TSchema>) => string | undefined;
  inputSchema: TSchema;
  execute: (input: z.infer<TSchema>, ctx: ToolContext) => Promise<McpToolResult>;
}

/**
 * `TPayload` is the concrete shape of `executePayload` for one tool. It defaults to
 * `unknown` so the 8 mutation tools that don't need it are unaffected; a tool whose
 * `execute()` wants type-safe access to the approved payload (see `MutationToolDef.execute`
 * below) can parameterize its own `MutationToolDef<Schema, ThatPayloadType>` instead.
 */
export interface MutationPreviewResult<TPayload = unknown> {
  method: string;
  url: string;
  body: unknown;
  sideEffects: string[];
  businessRulesPassed: string[];
  /** Exact payload that gets hashed and bound to the approval token */
  executePayload: TPayload;
}

export interface MutationToolDef<TSchema extends z.ZodTypeAny, TPayload = unknown> {
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
  /**
   * Whether this tool is registered under the remote multi-tenant transport (R1,
   * `ctx.tenantId !== undefined`). Omit (or `true`) = available on every transport. `false` =
   * self-host/stdio only — for a tool whose auth model doesn't fit the per-tenant context,
   * e.g. it requires 2-legged auth but `buildTenantContext` deliberately never attaches
   * `auth2lo` (2LO sees every project in the hub, which would defeat tenant isolation).
   */
  remoteEnabled?: boolean;
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
  buildPreview: (input: z.infer<TSchema>, ctx: ToolContext) => Promise<MutationPreviewResult<TPayload>>;
  /**
   * Execute the actual APS call.
   *
   * `approvedPayload`, when present, is the *exact* `executePayload` that `buildPreview()`
   * produced earlier in THIS SAME request (in `preview_required` mode it is also the payload
   * whose hash was just verified against the approval token). `execute()` should build its
   * wire request from `approvedPayload` rather than re-deriving state itself — re-deriving
   * opens a TOCTOU window if the tool's resolution logic calls live APIs, since a second call
   * can return different data than the one `buildPreview` already committed to. The parameter
   * is optional so the 8 tools that build their request purely from `input` (no live
   * re-resolution) can ignore it entirely; only `issues_pin_element` currently uses it.
   *
   * Kept as property syntax (`execute: (…) => …`, not method shorthand `execute(…): …`) even
   * though a tool typed with a concrete `TPayload` (e.g. `MutationToolDef<Schema, PinPayload>`)
   * then needs an explicit cast to widen into `AnyToolDef`'s `MutationToolDef<ZodTypeAny>`
   * (TPayload defaulting to `unknown`) — see the cast + comment in `_registry.ts`. Method
   * shorthand would make that widening compile for free (TS checks method parameters
   * bivariantly), but it also makes every *other* interface method bivariant, including
   * `buildPreview`, and silently defeats `@typescript-eslint/unbound-method` for any bare
   * `tool.execute` reference (e.g. `expect(tool.execute).toHaveBeenCalled()` in a test) —
   * too broad a soundness trade for one tool's benefit. One local cast is cheaper to audit.
   */
  execute: (input: z.infer<TSchema>, ctx: ToolContext, approvedPayload?: TPayload) => Promise<McpToolResult>;
}

export type AnyToolDef = ReadToolDef<z.ZodTypeAny> | MutationToolDef<z.ZodTypeAny>;
