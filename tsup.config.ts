import { defineConfig } from 'tsup';

// Two separate build steps (not one config with 4 entries) so the CLI scripts never share
// an esbuild code-splitting chunk with core.ts. tsup's default ESM splitting hoists modules
// common to multiple entries in the SAME build into a shared chunk file; tenant-admin.ts /
// tenant-seed.ts import config/env.js (legitimate — they are server-side scripts), and if
// that pulled auth/http modules into a chunk shared with core.js, core.js would transitively
// reach config/env.js through the chunk and violate the ENV-FREE INVARIANT (see CLAUDE.md).
// Keeping them as an independent tsup build (own esbuild pass, `splitting: false`) rules
// that out structurally rather than relying on the invariant test to catch it after the fact.
export default defineConfig([
  {
    // index.ts = MCP server bin; core.ts = `acc-forma-mcp-server/core` library
    // subpath for sibling products (n8n nodes, CDE Pulse). Same output dir —
    // the SEA/exe pipeline (tsup.sea.config.ts) still bundles index.ts only.
    entry: ['src/index.ts', 'src/core.ts'],
    format: ['esm'],
    target: 'node20',
    // tsup runs every config in this array concurrently (Promise.all internally), sharing
    // this outDir — so this clean step's "remove dist/**" can race the CLI build below in
    // either order. `clean: true` alone would non-deterministically delete tenant-admin.js /
    // tenant-seed.js if this step wins the race after they've already been written. The
    // negated globs exclude those filenames from the wipe; the CLI build's own esbuild write
    // still overwrites them fresh on every `npm run build`, so this doesn't skip a rebuild —
    // it only stops this step from racing the other build's *output*.
    clean: ['!tenant-admin.*', '!tenant-seed.*'],
    sourcemap: true,
    dts: { entry: { core: 'src/core.ts' } },
    banner: { js: '#!/usr/bin/env node' },
    external: ['pino-pretty', 'better-sqlite3'],
  },
  {
    // Tenant provisioning CLIs, built so they run on plain `node` inside the runtime
    // container (no tsx / devDependencies there — see Dockerfile prod prune). Dev usage via
    // `npm run tenant` / `npm run tenant-admin` (tsx) is unchanged; this is the container path.
    entry: { 'tenant-admin': 'scripts/tenant-admin.ts', 'tenant-seed': 'scripts/tenant-seed.ts' },
    format: ['esm'],
    target: 'node20',
    clean: false, // must not wipe the index/core output built above
    splitting: false, // see note above — no shared chunk with the core build
    sourcemap: true,
    dts: false,
    banner: { js: '#!/usr/bin/env node' },
    external: ['pino-pretty', 'better-sqlite3'],
  },
]);
