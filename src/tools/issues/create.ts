import { z } from 'zod';
import type { MutationToolDef } from '../_types.js';
import { createIssue, listIssueTypes } from '../../apis/issues.js';
import { stripBPrefix } from '../../utils/project-id.js';
import { registerValidator } from '../../safety/business-rules.js';
import { BusinessRuleError } from '../../safety/business-rules.js';

const APS_BASE = 'https://developer.api.autodesk.com';

// ---- Input schema ----------------------------------------------------------

const inputSchema = z.object({
  project_id: z
    .string()
    .min(1)
    .describe(
      'ACC project ID (with or without b. prefix). ' +
        'Get from dm.list_projects or admin.list_projects.',
    ),
  title: z
    .string()
    .min(1)
    .max(500)
    .describe('Issue title (required, max 500 characters).'),
  issue_subtype_id: z
    .string()
    .min(1)
    .describe(
      'Issue subtype ID (required). ' +
        'Use issues.list_types to get valid subtype IDs for this project. ' +
        'Note: the API requires issueSubtypeId (not issueTypeId).',
    ),
  description: z
    .string()
    .max(10_000)
    .optional()
    .describe('Optional long-form description (max 10,000 characters).'),
  assigned_to: z
    .string()
    .optional()
    .describe('Autodesk user ID to assign this issue to.'),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be ISO 8601 date: YYYY-MM-DD')
    .optional()
    .describe('Due date in YYYY-MM-DD format. Must be today or in the future.'),
  location_id: z
    .string()
    .optional()
    .describe('Location node ID from the project location tree.'),
  root_cause_id: z
    .string()
    .optional()
    .describe('Root cause ID. Use issues_list_root_causes to get valid IDs.'),
  status: z
    .enum(['open', 'pending', 'in_progress', 'completed', 'not_approved', 'in_dispute', 'closed'])
    .default('open')
    .describe('Initial status of the issue. Defaults to "open".'),
  assigned_to_type: z
    .enum(['user', 'company', 'role'])
    .optional()
    .describe(
      'Type of entity assigned to this issue. Required when assigned_to is set. ' +
        '"user" = individual Autodesk user, "company" = company entity, "role" = project role.',
    ),
  published: z
    .boolean()
    .default(false)
    .describe(
      'Whether the issue is visible to all project members. ' +
        'false (default) = draft/unpublished, visible only to creator. ' +
        'true = published, visible to all project members.',
    ),
});

type CreateIssueInput = z.infer<typeof inputSchema>;

// ---- Business rule: due_date must not be in the past -----------------------

// eslint-disable-next-line @typescript-eslint/require-await
registerValidator<CreateIssueInput>('issues_create', async (input, _ctx) => {
  const passed: string[] = [];

  if (input.due_date) {
    const today = new Date().toISOString().slice(0, 10);
    if (input.due_date < today) {
      throw new BusinessRuleError(
        'due_date_must_be_future',
        `due_date "${input.due_date}" is in the past (today is ${today}). ` +
          `Provide a current or future date.`,
      );
    }
    passed.push('due_date_is_current_or_future');
  }

  if (input.assigned_to && !input.assigned_to_type) {
    throw new BusinessRuleError(
      'assigned_to_type_required',
      `assigned_to_type is required when assigned_to is set. ` +
        `Provide one of: "user", "company", "role".`,
    );
  }
  if (input.assigned_to) passed.push('assigned_to_type_present');

  return { passed };
});

// ---- Tool definition -------------------------------------------------------

export const createIssueTool: MutationToolDef<typeof inputSchema> = {
  name: 'issues_create',
  title: 'Create ACC Issue',
  description:
    'Creates a new issue in an Autodesk Forma (ACC) project.\n\n' +
    'WORKFLOW (FORMA_MUTATION_MODE=preview_required, the default):\n' +
    '  1. Call with dry_run=true (default) — returns a preview + approval_token.\n' +
    '  2. Call again with dry_run=false and approval_token=<token> to execute.\n\n' +
    'Requires issue_subtype_id — call issues.list_types first to get valid IDs.\n' +
    'The server validates that the subtype exists before issuing the approval_token.',
  kind: 'mutation',
  scopes: ['data:read', 'data:write'],
  requiredAuthModes: ['ssa', '3lo'],
  inputSchema,

  getProjectId: (input) => input.project_id,

  buildPreview: async (input, ctx) => {
    const pid = stripBPrefix(input.project_id);
    const url = `${APS_BASE}/construction/issues/v1/projects/${pid}/issues`;

    // Validate issue_subtype_id exists AND is active in this project. APS will return
    // 400 "issueSubtype should be active" on execute if we send an inactive id, so the
    // dry-run preview must reject it up front for the trust pipeline to mean anything.
    const types = await listIssueTypes(ctx.auth, input.project_id);
    const subtype = types
      .flatMap((t) => t.subtypes)
      .find((s) => s.id === input.issue_subtype_id);
    if (!subtype) {
      throw new BusinessRuleError(
        'issue_subtype_id_must_exist',
        `issue_subtype_id "${input.issue_subtype_id}" not found in project ${input.project_id}. ` +
          `Call issues.list_types to get valid subtype IDs.`,
      );
    }
    if (!subtype.isActive) {
      throw new BusinessRuleError(
        'issue_subtype_must_be_active',
        `issue_subtype_id "${input.issue_subtype_id}" ("${subtype.title}") is inactive in project ${input.project_id}. ` +
          `APS rejects POST /issues with an inactive subtype. ` +
          `Call issues.list_types and pick a subtype without the [INACTIVE] tag.`,
      );
    }

    const body = {
      title: input.title,
      issueSubtypeId: input.issue_subtype_id,
      status: input.status,
      published: input.published,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.assigned_to !== undefined ? { assignedTo: input.assigned_to } : {}),
      ...(input.assigned_to_type !== undefined ? { assignedToType: input.assigned_to_type } : {}),
      ...(input.due_date !== undefined ? { dueDate: input.due_date } : {}),
      ...(input.location_id !== undefined ? { locationId: input.location_id } : {}),
      ...(input.root_cause_id !== undefined ? { rootCauseId: input.root_cause_id } : {}),
    };

    const sideEffects = [
      `Create 1 issue titled "${input.title}" (status: ${input.status}, published: ${String(input.published)}) in project ${input.project_id}`,
      ...(input.assigned_to ? [`Assign to ${input.assigned_to_type ?? 'user'} ${input.assigned_to}`] : []),
    ];

    return {
      method: 'POST',
      url,
      body,
      sideEffects,
      businessRulesPassed: [
        'issue_subtype_id_exists_in_project',
        'issue_subtype_is_active',
        ...(input.due_date ? ['due_date_is_current_or_future'] : []),
      ],
      // executePayload is what gets hashed for the approval token
      executePayload: { toolName: 'issues_create', projectId: pid, body },
    };
  },

  execute: async (input, ctx) => {
    const issue = await createIssue(ctx.auth, input.project_id, {
      title: input.title,
      issueSubtypeId: input.issue_subtype_id,
      status: input.status,
      published: input.published,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.assigned_to !== undefined ? { assignedTo: input.assigned_to } : {}),
      ...(input.assigned_to_type !== undefined ? { assignedToType: input.assigned_to_type } : {}),
      ...(input.due_date !== undefined ? { dueDate: input.due_date } : {}),
      ...(input.location_id !== undefined ? { locationId: input.location_id } : {}),
      ...(input.root_cause_id !== undefined ? { rootCauseId: input.root_cause_id } : {}),
    });

    return {
      content: [
        {
          type: 'text',
          text:
            `Issue created successfully.\n` +
            `ID:     ${issue.id}\n` +
            `Title:  ${issue.title}\n` +
            `Status: ${issue.status}`,
        },
      ],
      structuredContent: { issue },
    };
  },
};
