/**
 * Copies the built forma-mcp.exe into the bim-orchestrator vendor directory.
 * Run via: npm run sea:copy
 * Target: ../MultiAIagents/bim-orchestrator/vendor/forma-mcp/forma-mcp.exe
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const src = resolve(repoRoot, 'forma-mcp.exe');
const vendorDir = resolve(repoRoot, '..', 'MultiAIagents', 'bim-orchestrator', 'vendor', 'forma-mcp');
const dst = resolve(vendorDir, 'forma-mcp.exe');

if (!existsSync(src)) {
  console.error(`forma-mcp.exe not found at ${src} — run npm run sea:build first`);
  process.exit(1);
}

mkdirSync(vendorDir, { recursive: true });
copyFileSync(src, dst);
console.log(`Copied forma-mcp.exe → ${dst}`);
