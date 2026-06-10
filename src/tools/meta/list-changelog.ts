import { z } from 'zod';
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ReadToolDef } from '../_types.js';
import type { AuditEntry } from '../../safety/audit-log.js';

const inputSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(50)
    .describe('Max number of recent entries to return (newest first).'),
  tool_filter: z
    .string()
    .optional()
    .describe('Optional tool name prefix filter (e.g., "issues", "reviews_create").'),
  stage_filter: z
    .enum(['preview', 'executed', 'denied_readonly', 'denied_allowlist', 'denied_rate_limit', 'denied_business_rule', 'failed_api'])
    .optional()
    .describe('Optional filter by audit stage.'),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Specific date to read (YYYY-MM-DD). Defaults to today.'),
});

async function readAuditFile(filePath: string): Promise<AuditEntry[]> {
  if (!existsSync(filePath)) return [];

  const entries: AuditEntry[] = [];
  const rl = createInterface({ input: createReadStream(filePath, 'utf-8') });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch {
      // skip malformed lines
    }
  }

  return entries;
}

export const metaListChangelogTool: ReadToolDef<typeof inputSchema> = {
  name: 'meta_list_changelog',
  title: 'List Audit Changelog',
  description:
    'Lists recent audit log entries from the MCP server changelog. ' +
    'Each entry records a tool call: its inputs, outputs, stage (preview/executed/denied), ' +
    'and hash-chain position for tamper detection. ' +
    'Use meta_verify_audit_chain to check integrity.',
  kind: 'read',
  scopes: [],
  inputSchema,

  execute: async (input, ctx) => {
    const auditDir = ctx.env.FORMA_AUDIT_DIR;

    if (!existsSync(auditDir)) {
      return {
        content: [
          {
            type: 'text',
            text: `Audit directory not found: ${auditDir}. No entries written yet.`,
          },
        ],
        structuredContent: { entries: [] },
      };
    }

    // Determine which file(s) to read
    const targetDate =
      input.date ??
      new Date().toISOString().slice(0, 10);
    const filePath = join(auditDir, `audit-${targetDate}.jsonl`);

    let entries = await readAuditFile(filePath);

    // Apply filters
    if (input.tool_filter) {
      entries = entries.filter((e) => e.tool.startsWith(input.tool_filter!));
    }
    if (input.stage_filter) {
      entries = entries.filter((e) => e.stage === input.stage_filter);
    }

    // Newest first, limited
    entries = entries.reverse().slice(0, input.limit);

    if (entries.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No audit entries found for ${targetDate}${input.tool_filter ? ` (tool: ${input.tool_filter})` : ''}.`,
          },
        ],
        structuredContent: { entries: [], date: targetDate },
      };
    }

    const lines = entries.map(
      (e) =>
        `[${e.ts.slice(11, 19)}] [${e.stage.toUpperCase().padEnd(22)}] ${e.tool}` +
        (e.project_id ? `  project:${e.project_id}` : ''),
    );

    // List available dates for reference
    const allFiles = readdirSync(auditDir)
      .filter((f) => f.startsWith('audit-') && f.endsWith('.jsonl'))
      .map((f) => f.replace('audit-', '').replace('.jsonl', ''))
      .sort()
      .reverse()
      .slice(0, 7);

    return {
      content: [
        {
          type: 'text',
          text:
            `${entries.length} audit entries for ${targetDate}:\n\n` +
            lines.join('\n') +
            `\n\nAvailable dates: ${allFiles.join(', ')}`,
        },
      ],
      structuredContent: { entries, date: targetDate, availableDates: allFiles },
    };
  },
};
