import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
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
