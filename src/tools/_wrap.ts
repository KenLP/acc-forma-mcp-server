import { z } from 'zod';
import type { ReadToolDef, MutationToolDef, McpToolResult, ToolContext } from './_types.js';
import { checkHubAllowed, checkProjectAllowed, AllowlistError } from '../safety/allowlist.js';
import { checkNotReadonly, ReadonlyModeError } from '../safety/readonly-mode.js';
import { checkRateLimit, RateGovernanceError } from '../safety/rate-governance.js';
import { runBusinessRules, BusinessRuleError } from '../safety/business-rules.js';
import { buildDryRunPreview } from '../safety/dry-run.js';
import { verifyAndConsumeToken, ApprovalError } from '../safety/approval.js';
import { appendAuditEntry } from '../safety/audit-log.js';
import { ApsApiError } from '../http/errors.js';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

/** Extra fields injected into every mutation tool's inputSchema */
export const MutationBaseFields = {
  dry_run: z
    .boolean()
    .default(true)
    .describe(
      'Preview mode (default: true). When true, returns a preview of the intended API call ' +
        'and an approval_token without executing. Set to false with a valid approval_token to execute. ' +
        'Set FORMA_MUTATION_MODE=client_approval_only in env to skip the two-step flow.',
    ),
  approval_token: z
    .string()
    .optional()
    .describe(
      'Approval token from a prior dry_run=true call. Required when dry_run=false and ' +
        'FORMA_MUTATION_MODE=preview_required (the default). Expires after FORMA_APPROVAL_TOKEN_TTL seconds.',
    ),
};

// ---- Effective auth provider -----------------------------------------------

function effectiveCtx(tool: { preferredAuth?: '2lo' }, ctx: ToolContext): ToolContext {
  if (tool.preferredAuth === '2lo' && ctx.auth2lo) {
    return { ...ctx, auth: ctx.auth2lo };
  }
  return ctx;
}

// ---- Auth mode check -------------------------------------------------------

const AUTH_MODE_LABELS: Record<string, string> = {
  '2lo': '2-legged (client_credentials)',
  ssa: 'SSA (Secure Service Account)',
  '3lo': '3-legged OAuth',
};

function checkAuthMode(
  toolName: string,
  requiredAuthModes: string[] | undefined,
  currentMode: string,
): McpToolResult | null {
  if (!requiredAuthModes || requiredAuthModes.includes(currentMode)) return null;
  const required = requiredAuthModes.map((m) => AUTH_MODE_LABELS[m] ?? m).join(' or ');
  const current = AUTH_MODE_LABELS[currentMode] ?? currentMode;
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text:
          `Tool "${toolName}" requires ${required} but current auth mode is ${current}.\n\n` +
          `To fix: set APS_AUTH_MODE=ssa in your MCP server env and configure SSA credentials.\n` +
          `See docs/AUTH.md for SSA setup instructions.`,
      },
    ],
  };
}

// ---- Wrapped read tool -----------------------------------------------------

export function wrapReadTool<T extends z.ZodTypeAny>(
  tool: ReadToolDef<T>,
  ctx: ToolContext,
): (input: z.infer<T>) => Promise<McpToolResult> {
  return async (input: z.infer<T>) => {
    const projectId = (input as Record<string, unknown>)['project_id'] as string | undefined;
    const hubId = (input as Record<string, unknown>)['hub_id'] as string | undefined;

    try {
      // Auth mode gate — fail fast before any API call
      const authCheck = checkAuthMode(tool.name, tool.requiredAuthModes, ctx.env.APS_AUTH_MODE);
      if (authCheck) return authCheck;

      if (hubId) checkHubAllowed(hubId);
      if (projectId) checkProjectAllowed(projectId);

      const result = await tool.execute(input, effectiveCtx(tool, ctx));

      appendAuditEntry({
        tool: tool.name,
        kind: 'read',
        stage: 'executed',
        ...(projectId !== undefined ? { projectId } : {}),
        inputRedacted: input,
        outputSummary: { success: true },
      });

      return result;
    } catch (err) {
      return handleError(err, tool.name, 'read', projectId, input);
    }
  };
}

// ---- Wrapped mutation tool -------------------------------------------------

type MutationInput<T extends z.ZodTypeAny> = z.infer<T> & {
  dry_run: boolean;
  approval_token?: string;
};

export function wrapMutationTool<T extends z.ZodTypeAny>(
  tool: MutationToolDef<T>,
  ctx: ToolContext,
): (input: MutationInput<T>) => Promise<McpToolResult> {
  return async (rawInput: MutationInput<T>) => {
    const dry_run = Boolean(rawInput.dry_run);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const approval_token: string | undefined =
      typeof rawInput.approval_token === 'string' ? rawInput.approval_token : undefined;
    const { dry_run: _d, approval_token: _a, ...rest } = rawInput as Record<string, unknown>;
    void _d; void _a;
    const input = rest as z.infer<T>;
    const projectId = tool.getProjectId?.(input);

    // In client_approval_only mode, skip the two-step flow
    const requirePreview = env.FORMA_MUTATION_MODE === 'preview_required';
    const effectiveDryRun = requirePreview ? dry_run : false;

    try {
      // 0. Auth mode gate
      const authCheck = checkAuthMode(tool.name, tool.requiredAuthModes, ctx.env.APS_AUTH_MODE);
      if (authCheck) return authCheck;

      // 1. Allow-list
      const hubId = tool.getHubId?.(input);
      if (hubId) checkHubAllowed(hubId);
      if (projectId) checkProjectAllowed(projectId);

      // 2. Readonly mode
      checkNotReadonly(tool.name);

      // 3. Rate governance
      if (projectId) checkRateLimit(tool.name, projectId);

      // 4. Local business rule validators (no APS call, fast)
      const rulesPassed = await runBusinessRules(
        tool.name,
        input,
        { ...(projectId !== undefined ? { projectId } : {}) },
      );

      // 5. Build preview (includes API-dependent validation, e.g. subtype lookup)
      const preview = await tool.buildPreview(input, effectiveCtx(tool, ctx));
      preview.businessRulesPassed = [...rulesPassed, ...preview.businessRulesPassed];

      // 6. Dry-run: return preview + token, do NOT execute
      if (effectiveDryRun) {
        const dryResult = buildDryRunPreview({
          toolName: tool.name,
          method: preview.method,
          url: preview.url,
          body: preview.body,
          scopeRequired: tool.scopes,
          sideEffects: preview.sideEffects,
          businessRulesPassed: preview.businessRulesPassed,
          executePayload: preview.executePayload,
        });

        appendAuditEntry({
          tool: tool.name,
          kind: 'mutation',
          stage: 'preview',
          ...(projectId !== undefined ? { projectId } : {}),
          inputRedacted: input,
          outputSummary: { approval_token: dryResult.approval_token },
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(dryResult, null, 2) }],
          structuredContent: dryResult as unknown as Record<string, unknown>,
        };
      }

      // 7. Approval token check (only in preview_required mode)
      if (requirePreview) {
        if (!approval_token) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text:
                  `approval_token is required when dry_run=false and FORMA_MUTATION_MODE=preview_required. ` +
                  `First call this tool with dry_run=true (the default) to get an approval_token, ` +
                  `then re-call with dry_run=false and that token.`,
              },
            ],
          };
        }
        verifyAndConsumeToken(approval_token, tool.name, preview.executePayload);
      }

      // 8. Execute
      const result = await tool.execute(input, effectiveCtx(tool, ctx));

      appendAuditEntry({
        tool: tool.name,
        kind: 'mutation',
        stage: 'executed',
        ...(projectId !== undefined ? { projectId } : {}),
        inputRedacted: input,
        outputSummary: result.structuredContent ?? { success: true },
        ...(approval_token !== undefined ? { approvalToken: approval_token } : {}),
      });

      return result;
    } catch (err) {
      return handleError(err, tool.name, 'mutation', projectId, input);
    }
  };
}

// ---- Error handler ---------------------------------------------------------

function handleError(
  err: unknown,
  toolName: string,
  kind: 'read' | 'mutation',
  projectId: string | undefined,
  input: unknown,
): McpToolResult {
  type Stage =
    | 'denied_readonly'
    | 'denied_allowlist'
    | 'denied_rate_limit'
    | 'denied_business_rule'
    | 'failed_api';

  let stage: Stage = 'failed_api';
  let message: string;

  if (err instanceof AllowlistError) {
    stage = 'denied_allowlist';
    message = err.message;
  } else if (err instanceof ReadonlyModeError) {
    stage = 'denied_readonly';
    message = err.message;
  } else if (err instanceof RateGovernanceError) {
    stage = 'denied_rate_limit';
    message = err.message;
  } else if (err instanceof BusinessRuleError) {
    stage = 'denied_business_rule';
    message = err.message;
  } else if (err instanceof ApsApiError) {
    stage = 'failed_api';
    message = err.toMcpText();
  } else if (err instanceof ApprovalError) {
    stage = 'failed_api';
    message = err.message;
  } else {
    message = err instanceof Error ? err.message : String(err);
    logger.error({ err, toolName }, 'Unexpected error in tool execution');
  }

  appendAuditEntry({
    tool: toolName,
    kind,
    stage,
    ...(projectId !== undefined ? { projectId } : {}),
    inputRedacted: input,
    outputSummary: { error: message },
  });

  return { isError: true, content: [{ type: 'text', text: message }] };
}
