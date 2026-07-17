import { z } from 'zod';
import type { ReadToolDef, MutationToolDef, McpToolResult, ToolContext, ToolScope } from './_types.js';
import {
  checkHubAllowed,
  checkProjectAllowed,
  checkUnmappableToolAllowed,
  AllowlistError,
} from '../safety/allowlist.js';
import { checkNotReadonly, ReadonlyModeError } from '../safety/readonly-mode.js';
import { checkRateLimit, RateGovernanceError } from '../safety/rate-governance.js';
import { runBusinessRules, BusinessRuleError } from '../safety/business-rules.js';
import { buildDryRunPreview } from '../safety/dry-run.js';
import { verifyAndConsumeToken, ApprovalError, hashPayload, fingerprintToken } from '../safety/approval.js';
import { appendAuditEntry, AuditPersistenceError } from '../safety/audit-log.js';
import { checkIdempotency, storeIdempotencyResult, IdempotencyError } from '../safety/idempotency.js';
import { ApsApiError, ApsIndeterminateError } from '../http/errors.js';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

/** Extra fields injected into every mutation tool's inputSchema */
export const MutationBaseFields = {
  dry_run: z
    .boolean()
    .default(true)
    .describe(
      'Preview mode (default: true). When true, returns a preview of the intended API call ' +
        'and an approval_token without executing. Set to false with a valid approval_token to execute.',
    ),
  approval_token: z
    .string()
    .optional()
    .describe(
      'Approval token from a prior dry_run=true call. Required when dry_run=false and ' +
        'FORMA_MUTATION_MODE=preview_required (the default). Expires after FORMA_APPROVAL_TOKEN_TTL seconds.',
    ),
  idempotency_key: z
    .string()
    .optional()
    .describe(
      'Optional client-supplied key for idempotent execution. If a prior dry_run=false call with this ' +
        'key succeeded, the cached result is returned without re-executing. ' +
        'Use a unique value per intended operation (e.g. a UUID). ' +
        'Records expire after FORMA_APPROVAL_TOKEN_TTL seconds.',
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

// ---- Allow-list enforcement ------------------------------------------------

/**
 * Apply the hub/project allow-list according to the tool's declared scope.
 *
 * Driven by `tool.scope`, never by input field names: only the tool itself knows whether
 * its `project_id` holds a DM id (checkable) or an AECDM-native one (a different id space,
 * where a DM allow-list means nothing).
 */
function enforceScope<T extends z.ZodTypeAny>(
  tool: { name: string; scope: ToolScope; getHubId?: (i: z.infer<T>) => string | undefined; getProjectId?: (i: z.infer<T>) => string | undefined },
  input: z.infer<T>,
): void {
  switch (tool.scope.kind) {
    case 'dm': {
      const hubId = tool.getHubId?.(input);
      const projectId = tool.getProjectId?.(input);
      if (hubId) checkHubAllowed(hubId);
      if (projectId) checkProjectAllowed(projectId);
      return;
    }
    case 'unmappable':
      checkUnmappableToolAllowed(tool.name, tool.scope.resource);
      return;
    // 'discovery' filters its own output inside execute(); 'no-resource' touches no
    // ACC hub or project. Neither has an input id to check here.
    case 'discovery':
    case 'no-resource':
      return;
  }
}

// ---- Wrapped read tool -----------------------------------------------------

export function wrapReadTool<T extends z.ZodTypeAny>(
  tool: ReadToolDef<T>,
  ctx: ToolContext,
): (input: z.infer<T>) => Promise<McpToolResult> {
  return async (input: z.infer<T>) => {
    const projectId = tool.getProjectId?.(input);

    try {
      // Auth mode gate — fail fast before any API call
      const authCheck = checkAuthMode(tool.name, tool.requiredAuthModes, ctx.env.APS_AUTH_MODE);
      if (authCheck) {
        appendAuditEntry({
          tool: tool.name,
          kind: 'read',
          stage: 'denied_auth_mode',
          ...(projectId !== undefined ? { projectId } : {}),
          inputRedacted: input,
          outputSummary: { reason: authCheck.content[0]?.text },
        });
        return authCheck;
      }

      enforceScope(tool, input);

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
  idempotency_key?: string;
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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const idempotency_key: string | undefined =
      typeof rawInput.idempotency_key === 'string' ? rawInput.idempotency_key : undefined;
    const { dry_run: _d, approval_token: _a, idempotency_key: _ik, ...rest } =
      rawInput as Record<string, unknown>;
    void _d; void _a; void _ik;
    const input = rest as z.infer<T>;
    const projectId = tool.getProjectId?.(input);

    // In client_approval_only mode, skip the two-step flow
    const requirePreview = env.FORMA_MUTATION_MODE === 'preview_required';
    const effectiveDryRun = requirePreview ? dry_run : false;

    // Track whether tool.execute() completed so AuditPersistenceError can report accurately
    let apsExecutionCompleted = false;

    try {
      // 0. Auth mode gate
      const authCheck = checkAuthMode(tool.name, tool.requiredAuthModes, ctx.env.APS_AUTH_MODE);
      if (authCheck) {
        appendAuditEntry({
          tool: tool.name,
          kind: 'mutation',
          stage: 'denied_auth_mode',
          ...(projectId !== undefined ? { projectId } : {}),
          inputRedacted: input,
          outputSummary: { reason: authCheck.content[0]?.text },
        });
        return authCheck;
      }

      // 1. Allow-list, per the tool's declared scope
      enforceScope(tool, input);

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

        // Audit the token's FINGERPRINT, never the live token — the JSONL is readable
        // on disk and the token stays valid for the whole TTL.
        appendAuditEntry({
          tool: tool.name,
          kind: 'mutation',
          stage: 'preview',
          ...(projectId !== undefined ? { projectId } : {}),
          inputRedacted: input,
          outputSummary: { approval_token_fp: fingerprintToken(dryResult.approval_token) },
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(dryResult, null, 2) }],
          structuredContent: dryResult as unknown as Record<string, unknown>,
        };
      }

      // 6b. Idempotency check (only on execute path — dry-run is never cached).
      // The key is bound to (tool, payload hash): the same key with a different
      // operation is rejected instead of silently returning the older result.
      const payloadHash = hashPayload(preview.executePayload);
      if (idempotency_key) {
        const cached = checkIdempotency(idempotency_key, tool.name, payloadHash);
        if (cached) {
          logger.info({ toolName: tool.name, idempotency_key }, 'idempotency: returning cached result');
          appendAuditEntry({
            tool: tool.name,
            kind: 'mutation',
            stage: 'idempotent_replay',
            ...(projectId !== undefined ? { projectId } : {}),
            inputRedacted: input,
            outputSummary: { note: 'cached result returned; the APS call did NOT re-execute', idempotency_key },
          });
          return cached;
        }
      }

      // 7. Approval token check (only in preview_required mode)
      if (requirePreview) {
        if (!approval_token) {
          const missingTokenResult: McpToolResult = {
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
          appendAuditEntry({
            tool: tool.name,
            kind: 'mutation',
            stage: 'denied_missing_approval',
            ...(projectId !== undefined ? { projectId } : {}),
            inputRedacted: input,
            outputSummary: { error: missingTokenResult.content[0]?.text },
          });
          return missingTokenResult;
        }
        verifyAndConsumeToken(approval_token, tool.name, preview.executePayload);
      }

      // 8. Execute
      const result = await tool.execute(input, effectiveCtx(tool, ctx));
      apsExecutionCompleted = true; // set BEFORE audit so error reporting is accurate

      appendAuditEntry({
        tool: tool.name,
        kind: 'mutation',
        stage: 'executed',
        ...(projectId !== undefined ? { projectId } : {}),
        inputRedacted: input,
        outputSummary: result.structuredContent ?? { success: true },
        // Fingerprint only — matches the preview entry's approval_token_fp.
        ...(approval_token !== undefined ? { approvalToken: fingerprintToken(approval_token) } : {}),
      });

      if (idempotency_key) storeIdempotencyResult(idempotency_key, tool.name, payloadHash, result);

      return result;
    } catch (err) {
      return handleError(err, tool.name, 'mutation', projectId, input, apsExecutionCompleted);
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
  apsExecutionCompleted = false,
): McpToolResult {
  type Stage =
    | 'denied_readonly'
    | 'denied_allowlist'
    | 'denied_rate_limit'
    | 'denied_business_rule'
    | 'denied_approval'
    | 'denied_idempotency'
    | 'failed_api'
    | 'outcome_unknown';

  let stage: Stage = 'failed_api';
  let message: string;

  // Audit failure already logged inside appendAuditEntry — skip re-audit to avoid looping
  if (err instanceof AuditPersistenceError) {
    const text = apsExecutionCompleted
      ? 'The APS mutation was executed successfully but the audit log write failed ' +
        '(FORMA_AUDIT_FAIL_CLOSED=true). The change HAS been applied in APS — do NOT retry to avoid ' +
        'duplicates. Investigate FORMA_AUDIT_DIR for disk/permission issues.'
      : 'Audit log write failed before the APS call was made ' +
        '(FORMA_AUDIT_FAIL_CLOSED=true). The mutation was NOT executed — it is safe to retry.';
    return { isError: true, content: [{ type: 'text', text }] };
  }

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
    stage = 'denied_approval';
    message = err.message;
  } else if (err instanceof IdempotencyError) {
    stage = 'denied_idempotency';
    message = err.message;
  } else if (err instanceof ApsIndeterminateError) {
    // The request never got a response, so we cannot claim it failed — record that the
    // outcome is unknown rather than logging it as a clean failure.
    stage = 'outcome_unknown';
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
