import { defineConfig } from 'tsup';

export default defineConfig({
  // index.ts = MCP server bin; core.ts = `acc-forma-mcp-server/core` library
  // subpath for sibling products (n8n nodes, CDE Pulse). Same output dir —
  // the SEA/exe pipeline (tsup.sea.config.ts) still bundles index.ts only.
  entry: ['src/index.ts', 'src/core.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  sourcemap: true,
  dts: { entry: { core: 'src/core.ts' } },
  banner: { js: '#!/usr/bin/env node' },
  external: ['pino-pretty', 'better-sqlite3'],
});
