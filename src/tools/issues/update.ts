import { z } from 'zod';
import type { MutationToolDef } from '../_types.js';
import { updateIssue } from '../../apis/issues.js';
import { stripBPrefix } from '../../utils/project-id.js';
import { registerValidator, BusinessRuleError } from '../../safety/business-rules.js';

const APS_BASE = 'https://developer.api.autodesk.com';

// ---- Input schema -----------------------------------------------------------

const inputSchema = z.object({
  project_id: z
    .string()
    .min(1)
    .describe(
      'ACC project ID (with or without b. prefix). ' +
        'Get from dm_list_projects or admin_list_projects.',
    ),
  issue_id: z
    .string()
    .min(1)
    .describe('ID of the issue to update. Get from issues_list or issues_get.'),

  // Updatable fields — all optional (at least one must be provided)
  status: z
    .enum(['draft', 'open', 'pending', 'in_review', 'closed', 'void'])
    .optional()
    .describe(
      'New status. Valid transitions depend on current status — use issues_get to check ' +
        '`permittedStatuses` before updating. ' +
        'Confirmed values from ACC API: draft | open | pending | in_review | closed | void.',
    ),
  issue_subtype_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Change the issue subtype (i.e. issue type/category). ' +
        'Use issues_list_types to get valid subtype IDs for this project.',
    ),
  title: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe('Updated issue title (max 500 characters).'),
  description: z
    .string()
    .max(10_000)
    .optional()
    .describe('Updated description (max 10,000 characters). Pass empty string to clear.'),
  assigned_to: z
    .string()
    .optional()
    .describe(
      'Autodesk user/company/role ID to assign this issue to. ' +
        'Pass empty string to unassign.',
    ),
  assigned_to_type: z
    .enum(['user', 'company', 'role'])
    .optional()
    .describe('Required when assigned_to is set (non-empty).'),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be ISO 8601 date: YYYY-MM-DD')
    .optional()
    .describe('Updated due date (YYYY-MM-DD). Must be today or in the future.'),
  root_cause_id: z
    .string()
    .optional()
    .describe('Root cause ID. Use issues_list_root_causes to get valid IDs.'),
  location_id: z
    .string()
    .optional()
    .describe('Location node ID from the project location tree.'),
});

type UpdateIssueInput = z.infer<typeof inputSchema>;

// ---- Business rules ---------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/require-await
registerValidator<UpdateIssueInput>('issues_update', async (input, _ctx) => {
  const passed: string[] = [];

  // At least one field to update must be provided
  const updatableFields = [
    'status', 'issue_subtype_id', 'title', 'description', 'assigned_to',
    'due_date', 'root_cause_id', 'location_id',
  ] as const;
  const hasUpdate = updatableFields.some((f) => input[f] !== undefined);
  if (!hasUpdate) {
    throw new BusinessRuleError(
      'at_least_one_field_required',
      'issues_update requires at least one field to update ' +
        '(status, title, description, assigned_to, due_date, root_cause_id, location_id).',
    );
  }

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
      'assigned_to_type is required when assigned_to is set. ' +
        'Provide one of: "user", "company", "role".',
    );
  }
  if (input.assigned_to) passed.push('assigned_to_type_present');

  return { passed };
});

// ---- Tool definition --------------------------------------------------------

export const updateIssueTool: MutationToolDef<typeof inputSchema> = {
  name: 'issues_update',
  title: 'Update ACC Issue',
  description:
    'Updates one or more fields of an existing ACC issue via a sparse PATCH — ' +
    'only the explicitly provided fields are changed; at least one field is required. ' +
    'Valid status transitions depend on the issue\'s current status and the calling ' +
    'user\'s permitted statuses/attributes, which vary per issue and project workflow. ' +
    'Auth: SSA or 3LO required (2LO is not supported for the Issues API).',
  kind: 'mutation',
  scopes: ['data:read', 'data:write'],
  requiredAuthModes: ['ssa', '3lo'],
  scope: { kind: 'dm' },
  inputSchema,

  getProjectId: (input) => input.project_id,

  // eslint-disable-next-line @typescript-eslint/require-await
  buildPreview: async (input, _ctx) => {
    const pid = stripBPrefix(input.project_id);
    const url = `${APS_BASE}/construction/issues/v1/projects/${pid}/issues/${input.issue_id}`;

    // Build sparse PATCH body — only include explicitly-set fields
    const body: Record<string, unknown> = {};
    if (input.status !== undefined) body['status'] = input.status;
    if (input.issue_subtype_id !== undefined) body['issueSubtypeId'] = input.issue_subtype_id;
    if (input.title !== undefined) body['title'] = input.title;
    if (input.description !== undefined) body['description'] = input.description;
    if (input.assigned_to !== undefined) body['assignedTo'] = input.assigned_to;
    if (input.assigned_to_type !== undefined) body['assignedToType'] = input.assigned_to_type;
    if (input.due_date !== undefined) body['dueDate'] = input.due_date;
    if (input.root_cause_id !== undefined) body['rootCauseId'] = input.root_cause_id;
    if (input.location_id !== undefined) body['locationId'] = input.location_id;

    const changedFields = Object.keys(body).join(', ');
    const sideEffects = [
      `PATCH issue ${input.issue_id} in project ${pid}`,
      `Fields to update: ${changedFields}`,
      ...(input.status ? [`Status → ${input.status}`] : []),
      ...(input.issue_subtype_id ? [`Subtype → ${input.issue_subtype_id}`] : []),
      ...(input.assigned_to
        ? [`Assignee → ${input.assigned_to_type ?? 'user'} ${input.assigned_to}`]
        : []),
    ];

    return {
      method: 'PATCH',
      url,
      body,
      sideEffects,
      businessRulesPassed: [
        ...(input.due_date ? ['due_date_is_current_or_future'] : []),
        ...(input.assigned_to ? ['assigned_to_type_present'] : []),
        'at_least_one_field_provided',
      ],
      executePayload: { toolName: 'issues_update', projectId: pid, issueId: input.issue_id, body },
    };
  },

  execute: async (input, ctx) => {
    const payload: Record<string, unknown> = {};
    if (input.status !== undefined) payload['status'] = input.status;
    if (input.issue_subtype_id !== undefined) payload['issueSubtypeId'] = input.issue_subtype_id;
    if (input.title !== undefined) payload['title'] = input.title;
    if (input.description !== undefined) payload['description'] = input.description;
    if (input.assigned_to !== undefined) payload['assignedTo'] = input.assigned_to;
    if (input.assigned_to_type !== undefined) payload['assignedToType'] = input.assigned_to_type;
    if (input.due_date !== undefined) payload['dueDate'] = input.due_date;
    if (input.root_cause_id !== undefined) payload['rootCauseId'] = input.root_cause_id;
    if (input.location_id !== undefined) payload['locationId'] = input.location_id;

    const issue = await updateIssue(
      ctx.auth,
      input.project_id,
      input.issue_id,
      payload,
    );

    return {
      content: [
        {
          type: 'text',
          text:
            `Issue updated successfully.\n` +
            `ID:     ${issue.id}\n` +
            `Title:  ${issue.title}\n` +
            `Status: ${issue.status}`,
        },
      ],
      structuredContent: { issue },
    };
  },
};
