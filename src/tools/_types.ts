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
  inputSchema: TSchema;
  /** Extract project ID for allow-list + rate-governance checks */
  getProjectId?: (input: z.infer<TSchema>) => string | undefined;
  /** Build preview (validates business rules, resolves IDs, no APS write) */
  buildPreview: (input: z.infer<TSchema>, ctx: ToolContext) => Promise<MutationPreviewResult>;
  /** Execute the actual APS call */
  execute: (input: z.infer<TSchema>, ctx: ToolContext) => Promise<McpToolResult>;
}

export type AnyToolDef = ReadToolDef<z.ZodTypeAny> | MutationToolDef<z.ZodTypeAny>;
