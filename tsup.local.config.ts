import { defineConfig } from 'tsup';

// Single-file CJS server for the self-host .mcpb (bundle-local/). Same shape as
// tsup.sea.config.ts: every JS dependency is inlined, so the bundle needs nothing but the
// Node.js runtime Claude Desktop ships with. better-sqlite3 stays external and is NOT
// shipped — the bundle runs FORMA_PERSISTENCE_MODE=memory, and persistence/db.ts only loads
// it on first use. Pure JS output → one .mcpb for Windows, macOS and Linux.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['cjs'],
  outDir: 'bundle-local/server',
  outExtension: () => ({ js: '.cjs' }),
  target: 'node20',
  clean: true,
  sourcemap: false,
  noExternal: [/.*/],
  external: ['better-sqlite3'],
  shims: true,
});
