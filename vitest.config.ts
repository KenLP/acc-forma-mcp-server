import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    // Several suites dynamically import a large module graph (src/core.ts, src/tools/_wrap.ts).
    // Their runtime is dominated by transform cost on a cold cache — which CI always has — not
    // by the assertions. The 5s default trips there and reads as a logic failure when it is only
    // slowness, so give those imports a real budget.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/index.ts', 'src/server.ts'],
    },
    exclude: [
      'node_modules',
      'dist',
      ...(process.env['INTEGRATION'] !== 'true' ? ['tests/integration/**'] : []),
    ],
  },
});
