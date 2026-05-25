import { createApprovalToken } from './approval.js';
import { env } from '../config/env.js';

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
}): DryRunPreview {
  const token = createApprovalToken(params.toolName, params.executePayload);

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
    next_step:
      `To execute this action, call tool "${params.toolName}" again with ` +
      `the same inputs plus dry_run=false and approval_token="${token}". ` +
      `Token expires in ${env.FORMA_APPROVAL_TOKEN_TTL}s and is single-use.`,
  };
}
