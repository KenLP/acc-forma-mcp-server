import { defineConfig } from 'tsup';

// CJS bundle for @yao-pkg/pkg SEA packaging.
// All JS/TS deps are inlined (noExternal bundles node_modules into the output).
// Only better-sqlite3 stays external — it's a native .node addon that pkg
// embeds as an asset and extracts to a temp path at runtime.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  outDir: 'dist-cjs',
  target: 'node20',
  clean: true,
  sourcemap: false,
  noExternal: [/.*/],    // bundle all node_modules into the CJS file
  external: ['better-sqlite3'],
});
