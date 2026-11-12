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
//
// It then starts the same file twice more with a robot already in the data folder (a
// throwaway key generated here, never sent anywhere): once as Claude Desktop would, and once
// with SSA_* vars leaking in from the OS environment. Both must serve the self-host tool set
// — no account-level Admin tool, no 2-legged-only tool — which is what proves, on the built
// artifact rather than in a unit test, that the bundle reads only what the robot was invited
// to.
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// Self-host tool set: the product registry minus the 4 account-level Admin tools and the 3
// webhook tools (2-legged only). Change this number deliberately, together with the guide.
const SELF_HOST_TOOL_COUNT = 39;
const PLACEHOLDER_CLIENT_ID = 'verify-placeholder-client-id';

/** Writes robot.json + a throwaway robot-key.pem, as setup_create_robot would. */
function seedRobot(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const keyPath = join(dataDir, 'robot-key.pem');
  writeFileSync(keyPath, privateKey, { mode: 0o600 });
  writeFileSync(
    join(dataDir, 'robot.json'),
    JSON.stringify({
      serviceAccountId: 'verify-robot-id',
      email: 'bimlynx-verify@example.adskserviceaccount.com',
      keyId: 'verify-key-id',
      createdAt: new Date().toISOString(),
      clientIdPrefix: PLACEHOLDER_CLIENT_ID.slice(0, 8),
    }),
  );
  return keyPath;
}

function listToolsInIsolation({ prepareData, extraEnv } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bimlynx-bundle-verify-'));
  const entry = join(dir, 'index.cjs');
  copyFileSync(ENTRY, entry);
  const dataDir = join(dir, 'data');
  const prepared = prepareData ? prepareData(dataDir) : undefined;

  const env = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, HOME: process.env.HOME };
  Object.assign(env, {
    USERPROFILE: process.env.USERPROFILE,
    APS_CLIENT_ID: PLACEHOLDER_CLIENT_ID,
    APS_CLIENT_SECRET: 'verify-placeholder-secret',
    APS_AUTH_MODE: 'ssa',
    FORMA_TRANSPORT: 'stdio',
    FORMA_PERSISTENCE_MODE: 'memory',
    BIMLYNX_DATA_DIR: dataDir,
  });
  if (extraEnv) Object.assign(env, extraEnv(prepared));

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

function assertSelfHostToolSet(label, tools) {
  const forbidden = tools.filter((n) => n.startsWith('admin_') || n.startsWith('webhooks_') || n.startsWith('setup_'));
  if (forbidden.length > 0) {
    throw new Error(`verify (${label}): tools outside the self-host set were registered: ${forbidden.join(', ')}`);
  }
  for (const must of ['dm_list_projects', 'issues_list', 'md_get_manifest']) {
    if (!tools.includes(must)) throw new Error(`verify (${label}): expected ${must} to be registered`);
  }
  if (tools.length !== SELF_HOST_TOOL_COUNT) {
    throw new Error(`verify (${label}): expected ${SELF_HOST_TOOL_COUNT} tools, got ${tools.length}: ${tools.join(', ')}`);
  }
}

const robotTools = await listToolsInIsolation({ prepareData: seedRobot });
assertSelfHostToolSet('robot in data folder', robotTools);
console.log(`verify: with a robot, the bundle serves ${robotTools.length} tools — no admin_*, no webhooks_*`);

// SSA_* in the OS environment win over robot.json for *which* robot (credentials.ts), but
// must not change *how* the server authenticates: still SSA only, same tool set.
const leakedTools = await listToolsInIsolation({
  prepareData: seedRobot,
  extraEnv: (keyPath) => ({ SSA_ID: 'leaked-ssa-id', SSA_KEY_ID: 'leaked-key-id', SSA_KEY_PATH: keyPath }),
});
assertSelfHostToolSet('SSA_* leaked from the environment', leakedTools);
console.log('verify: SSA_* vars leaking in from the environment do not widen the tool set');

if (pack) {
  const out = `bimlynx-local-${pkg.version}.mcpb`;
  run('npx', ['-y', '@anthropic-ai/mcpb@2.1.2', 'pack', 'bundle-local', out]);
  console.log(`packed: ${out}`);
}
