#!/usr/bin/env node
// Builds the self-host .mcpb (bundle-local/) and proves it starts without node_modules.
//
//   node scripts/build-local-bundle.mjs            build + verify + pack
//   node scripts/build-local-bundle.mjs --no-pack  build + verify only
//
// Verify step: copies server/index.cjs into an empty temp folder (no node_modules anywhere
// above it) and starts it in setup mode with placeholder credentials, the way Claude
// Desktop would on a fresh machine. It must answer tools/list with exactly the two setup
// tools. This is the check for SPEC_self-host-installer R1 — a static import of
// better-sqlite3 (or any other module left external) makes the process die before the
// handshake. Placeholder credentials never reach APS: tools/list makes no API call.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const BUNDLE = join(ROOT, 'bundle-local');
const ENTRY = join(BUNDLE, 'server', 'index.cjs');
const pack = !process.argv.includes('--no-pack');

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status})`);
}

function listToolsInIsolation() {
  const dir = mkdtempSync(join(tmpdir(), 'bimlynx-bundle-verify-'));
  const entry = join(dir, 'index.cjs');
  copyFileSync(ENTRY, entry);

  const env = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, HOME: process.env.HOME };
  Object.assign(env, {
    USERPROFILE: process.env.USERPROFILE,
    APS_CLIENT_ID: 'verify-placeholder-client-id',
    APS_CLIENT_SECRET: 'verify-placeholder-secret',
    APS_AUTH_MODE: 'ssa',
    FORMA_TRANSPORT: 'stdio',
    FORMA_PERSISTENCE_MODE: 'memory',
    BIMLYNX_DATA_DIR: join(dir, 'data'),
  });

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let outcome; // { error } | { names } — settled once the process is gone
    const timer = setTimeout(() => stop({ error: new Error('timed out waiting for tools/list') }), 20_000);
    function stop(result) {
      outcome ??= result;
      child.kill();
    }
    // Clean up only after exit: on Windows the running process holds its cwd open.
    child.on('exit', (code) => {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      const result = outcome ?? { error: new Error(`server exited (code ${code}) before answering`) };
      if (result.error) reject(new Error(`${result.error.message}\n--- server stderr ---\n${err.slice(-2000)}`));
      else resolve(result.names);
    });
    child.stderr.on('data', (d) => (err += d));
    child.stdout.on('data', (d) => {
      out += d;
      for (const line of out.split('\n').slice(0, -1)) {
        const msg = JSON.parse(line);
        if (msg.id === 2) stop({ names: msg.result.tools.map((t) => t.name).sort() });
      }
      out = out.slice(out.lastIndexOf('\n') + 1);
    });
    const send = (m) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify', version: '0' } } });
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/list', params: {} });
  });
}

const manifest = JSON.parse(readFileSync(join(BUNDLE, 'manifest.json'), 'utf-8'));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
if (manifest.version !== pkg.version) {
  throw new Error(`bundle-local/manifest.json version ${manifest.version} != package.json ${pkg.version}`);
}

run('npx', ['tsup', '--config', 'tsup.local.config.ts']);

const names = await listToolsInIsolation();
const expected = ['setup_create_robot', 'setup_status'];
if (JSON.stringify(names) !== JSON.stringify(expected)) {
  throw new Error(`verify: expected tools ${expected.join(', ')}, got ${names.join(', ')}`);
}
console.log(`verify: bundle starts with no node_modules, setup mode serves ${names.join(', ')}`);

if (pack) {
  const out = `bimlynx-local-${pkg.version}.mcpb`;
  run('npx', ['-y', '@anthropic-ai/mcpb@2.1.2', 'pack', 'bundle-local', out]);
  console.log(`packed: ${out}`);
}
