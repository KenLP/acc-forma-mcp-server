import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        // scripts/*.ts is a separate program (tsconfig.scripts.json) rather than being
        // folded into the main tsconfig.json's `include` — that keeps `npm run typecheck`
        // (which uses tsconfig.json directly) scoped to src+tests, unchanged. Passing both
        // projects here lets typescript-eslint pick whichever program contains the file
        // currently being linted.
        project: ['./tsconfig.json', './tsconfig.scripts.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...tsPlugin.configs['recommended-type-checked'].rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
    },
  },
  {
    // Plain Node scripts (build/release/setup helpers) — not part of the tsconfig program,
    // just needs `console`/`process`/etc. recognized so `no-undef` (from js.configs.recommended
    // above, which applies file-type-agnostically) doesn't misfire on Node globals.
    files: ['scripts/**/*.mjs', 'scripts/**/*.cjs'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // Local, gitignored diagnostic/live-test scratch scripts (see .gitignore's
    // `scripts/diag-*.ts` / `scripts/test-*.ts` / `scripts/probe-*.ts` rules) — one-off
    // live-API probes written fast, never committed, not part of the shipped surface. A
    // clean CI checkout never has these files on disk at all; this ignore only matters for
    // `npm run lint` on a dev machine where dozens of them accumulate locally.
    ignores: ['dist/**', 'node_modules/**', 'scripts/diag-*.ts', 'scripts/test-*.ts', 'scripts/probe-*.ts'],
  },
];
