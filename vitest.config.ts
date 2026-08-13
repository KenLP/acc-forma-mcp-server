import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    // Several suites dynamically import a large module graph (src/core.ts, src/tools/_wrap.ts,
    // src/tools/_registry.ts). Their runtime is dominated by transform cost on a cold cache —
    // which CI always has — not by the assertions. The 5s default trips there and reads as a
    // logic failure when it is only slowness, so give those imports a real budget.
    testTimeout: 30_000,
    // Cap the worker pool. Vitest defaults to roughly one worker per core; on a 16-core machine
    // that meant ~15 workers each transforming the same large graph independently, so aggregate
    // transform cost hit ~216s and the heavy suites blew their beforeAll budget — the run then
    // reported them as "skipped" rather than failed, which reads as a pass at a glance. Measured
    // on this repo: 15 workers → 340 passed / 38 SKIPPED, 5 files timing out; 4 workers → 378
    // passed / 0 skipped, transform down to ~21s, same wall-clock. This is an upper bound, not a
    // floor, so a 2-core CI runner is unaffected. Raise the timeouts below only if a suite is
    // genuinely slow — do not raise them to paper over contention again.
    maxWorkers: 4,
    // Same reasoning, separate budget: a suite that does the import inside beforeAll (so the
    // whole file shares one registry) is governed by hookTimeout, whose default is 10s. Setting
    // only testTimeout left those suites failing under full-suite contention.
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/index.ts', 'src/server.ts'],
    },
    exclude: [
      'node_modules',
      'dist',
      // Claude Code checks out agent worktrees at .claude/worktrees/<name>/ — a full copy of
      // the repo, tests included. Git ignores them; vitest does not read gitignore, so without
      // this it collects each worktree's suites too and reports failures from a stale checkout
      // as if they were failures here. False red is as misleading as false green.
      '.claude/worktrees/**',
      ...(process.env['INTEGRATION'] !== 'true' ? ['tests/integration/**'] : []),
    ],
  },
});
