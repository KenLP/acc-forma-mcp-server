import { createApprovalToken } from './approval.js';
import type { Env } from '../config/env.js';

export interface DryRunPreview {
  preview: {
    method: string;
    url: string;
    body: unknown;
    scope_required: string[];
    estimated_side_effects: string[];
    business_rules_passed: string[];
  };
  approval_token: string;
  /**
   * Always true on a preview. A host that wants a human gate can key its UI off this
   * rather than parsing prose — the server cannot see the user, so it can only state
   * that confirmation is owed, never enforce that one happened.
   */
  awaiting_user_confirmation: true;
  next_step: string;
}

export function buildDryRunPreview(params: {
  toolName: string;
  method: string;
  url: string;
  body: unknown;
  scopeRequired: string[];
  sideEffects: string[];
  businessRulesPassed: string[];
  executePayload: unknown;
  env: Env;
  /** Remote multi-tenant caller (see ToolContext.tenantId). Undefined = local mode. */
  tenantId?: string;
}): DryRunPreview {
  const token = createApprovalToken(params.toolName, params.executePayload, params.env, params.tenantId);

  return {
    preview: {
      method: params.method,
      url: params.url,
      body: params.body,
      scope_required: params.scopeRequired,
      estimated_side_effects: params.sideEffects,
      business_rules_passed: params.businessRulesPassed,
    },
    approval_token: token,
    awaiting_user_confirmation: true,
    // Phrased to put the human step first. The previous wording opened with "To execute
    // this action, call ... again with dry_run=false", which reads as an instruction to
    // proceed — observed 2026-08-12 with a real client running both calls in one turn
    // without ever showing the preview to the user.
    next_step:
      `Nothing has been created or changed yet — this is a preview. Show it to the user ` +
      `and get their explicit confirmation before going further. Once they confirm, call ` +
      `"${params.toolName}" again with the same inputs plus dry_run=false and ` +
      `approval_token="${token}". The token is single-use, expires in ` +
      `${params.env.FORMA_APPROVAL_TOKEN_TTL}s, and is bound to this exact payload — ` +
      `changing any input invalidates it, so the executed write can never differ from ` +
      `what was previewed.`,
  };
}
