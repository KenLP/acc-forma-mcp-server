/**
 * Shared `--flag value` parsing for the operator CLIs in this directory. One copy, one
 * contract — this used to be pasted into each script, and the copies had quietly diverged
 * (one tolerated a flag with no value, the others threw), which matters when the flag whose
 * value went missing is `--db` and the fallback is the production database.
 */

export interface ParseFlagsOptions {
  /** Flags that take no value (`--apply`, `--stdin`). Recorded as present with value ''. */
  booleans?: ReadonlySet<string>;
  /**
   * When given, any flag outside this set (and outside `booleans`) is an error. Commands
   * with a small fixed surface should pass it — a typo like `--output` then fails instead
   * of being silently ignored while the default path is used.
   */
  allowed?: ReadonlySet<string>;
}

export function parseFlags(argv: string[], opts: ParseFlagsOptions = {}): Map<string, string> {
  const booleans = opts.booleans ?? new Set<string>();
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--')) continue;
    const key = token.slice(2);

    if (opts.allowed && !opts.allowed.has(key) && !booleans.has(key)) {
      const known = [...opts.allowed, ...booleans].map((k) => `--${k}`).join(', ');
      throw new Error(`unknown flag --${key} (expected one of: ${known})`);
    }

    if (booleans.has(key)) {
      flags.set(key, '');
      continue;
    }

    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`--${key} requires a value`);
    }
    flags.set(key, value);
    i++;
  }
  return flags;
}

export function requireFlag(flags: Map<string, string>, key: string): string {
  const value = flags.get(key);
  if (!value) throw new Error(`missing required --${key}`);
  return value;
}
