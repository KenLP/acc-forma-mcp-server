import { z } from 'zod';
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ReadToolDef } from '../_types.js';
import type { AuditEntry } from '../../safety/audit-log.js';
import { verifyChain, type ChainEntry } from '../../safety/hash-chain.js';

const inputSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Date of the audit file to verify (YYYY-MM-DD). Defaults to today.'),
});

type ReadAuditResult =
  | { ok: true; entries: AuditEntry[] }
  | { ok: false; firstMalformedLineIndex: number };

async function readAuditEntries(filePath: string): Promise<ReadAuditResult> {
  if (!existsSync(filePath)) return { ok: true, entries: [] };

  const entries: AuditEntry[] = [];
  const rl = createInterface({ input: createReadStream(filePath, 'utf-8') });
  let lineIndex = 0;

  for await (const line of rl) {
    if (!line.trim()) { lineIndex++; continue; }
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch {
      rl.close();
      return { ok: false, firstMalformedLineIndex: lineIndex };
    }
    lineIndex++;
  }

  return { ok: true, entries };
}

export const metaVerifyAuditChainTool: ReadToolDef<typeof inputSchema> = {
  name: 'meta_verify_audit_chain',
  title: 'Verify Audit Log Integrity',
  description:
    'Verifies the SHA-256 hash chain of the audit log for a given date. ' +
    'Each entry\'s hash is computed from the previous entry\'s hash + the entry data. ' +
    'A valid chain proves no entries have been modified, inserted, or deleted after the fact. ' +
    'Returns the first invalid entry index if tampering is detected.',
  kind: 'read',
  scopes: [],
  // Reads the local audit JSONL — no ACC hub or project is touched.
  scope: { kind: 'no-resource' },
  inputSchema,

  execute: async (input, ctx) => {
    const auditDir = ctx.env.FORMA_AUDIT_DIR;
    const targetDate = input.date ?? new Date().toISOString().slice(0, 10);
    const filePath = join(auditDir, `audit-${targetDate}.jsonl`);

    if (!existsSync(filePath)) {
      return {
        content: [
          {
            type: 'text',
            text: `No audit file found for ${targetDate} at ${filePath}.`,
          },
        ],
        structuredContent: { valid: null, date: targetDate, entryCount: 0 },
      };
    }

    const readResult = await readAuditEntries(filePath);

    if (!readResult.ok) {
      return {
        content: [
          {
            type: 'text',
            text:
              `⚠ Audit chain INVALID for ${targetDate}!\n` +
              `  Line ${readResult.firstMalformedLineIndex} contains malformed JSON — ` +
              `possible file corruption or tampering.`,
          },
        ],
        structuredContent: {
          valid: false,
          date: targetDate,
          reason: 'malformed_json',
          firstInvalidIndex: readResult.firstMalformedLineIndex,
        },
      };
    }

    const { entries } = readResult;

    if (entries.length === 0) {
      return {
        content: [{ type: 'text', text: `Audit file for ${targetDate} is empty.` }],
        structuredContent: { valid: true, date: targetDate, entryCount: 0 },
      };
    }

    const result = verifyChain(entries as unknown as ChainEntry[]);

    if (result.valid) {
      return {
        content: [
          {
            type: 'text',
            text:
              `✓ Audit chain VALID for ${targetDate}.\n` +
              `  Entries verified: ${entries.length}\n` +
              `  First entry ID:   ${entries[0]?.id ?? 'n/a'}\n` +
              `  Last entry ID:    ${entries[entries.length - 1]?.id ?? 'n/a'}`,
          },
        ],
        structuredContent: {
          valid: true,
          date: targetDate,
          entryCount: entries.length,
          firstEntryId: entries[0]?.id,
          lastEntryId: entries[entries.length - 1]?.id,
        },
      };
    }

    const badEntry = result.first_invalid_index !== undefined
      ? entries[result.first_invalid_index]
      : null;

    return {
      content: [
        {
          type: 'text',
          text:
            `⚠ Audit chain INVALID for ${targetDate}!\n` +
            `  First invalid index: ${result.first_invalid_index}\n` +
            `  Entry ID at that position: ${badEntry?.id ?? 'n/a'}\n` +
            `  Tool: ${badEntry?.tool ?? 'n/a'}  Stage: ${badEntry?.stage ?? 'n/a'}\n\n` +
            `  This may indicate the audit file was modified after writing. ` +
            `Entries after index ${result.first_invalid_index} cannot be trusted.`,
        },
      ],
      structuredContent: {
        valid: false,
        date: targetDate,
        entryCount: entries.length,
        firstInvalidIndex: result.first_invalid_index,
        firstInvalidEntry: badEntry,
      },
    };
  },
};
