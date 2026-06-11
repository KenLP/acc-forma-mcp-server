/**
 * Publish forma-mcp.exe to a GitHub Release so bim-orchestrator's
 * fetch-forma-mcp.ps1 can download it. Idempotent: creates the rolling
 * `forma-mcp-sea` release on first run, then re-uploads with --clobber.
 *
 * Prereqs: `npm run sea:build` produced forma-mcp.exe, and `gh auth login`.
 * Run via: npm run sea:publish
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const TAG = 'forma-mcp-sea';
const REPO = 'KenLP/acc-forma-mcp-server';
const ASSET = 'forma-mcp.exe';

if (!existsSync(ASSET)) {
  console.error(`${ASSET} not found — run 'npm run sea:build' first.`);
  process.exit(1);
}

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

function gh(args, opts = {}) {
  return execFileSync('gh', args, { stdio: 'inherit', ...opts });
}

// Create the rolling release if it doesn't exist yet, else reuse it.
let exists = true;
try {
  execFileSync('gh', ['release', 'view', TAG, '--repo', REPO], { stdio: 'ignore' });
} catch {
  exists = false;
}

if (!exists) {
  gh([
    'release', 'create', TAG,
    '--repo', REPO,
    '--title', `forma-mcp SEA build (v${version})`,
    '--notes', 'Standalone Windows executable (Node.js bundled). Fetched by bim-orchestrator scripts/fetch-forma-mcp.ps1.',
  ]);
}

gh(['release', 'upload', TAG, ASSET, '--repo', REPO, '--clobber']);
console.log(`Uploaded ${ASSET} to ${REPO} release '${TAG}'.`);
