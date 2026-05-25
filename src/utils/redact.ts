const REDACT_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer [A-Za-z0-9\-._~+/]+=*/g, 'Bearer [REDACTED]'],
  [/client_secret=[^&\s]*/gi, 'client_secret=[REDACTED]'],
  // JWT (3-part base64url structure)
  [/eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]*/g, '[JWT_REDACTED]'],
];

const SENSITIVE_KEYS = new Set([
  'access_token',
  'refresh_token',
  'client_secret',
  'password',
  'authorization',
  'x-api-key',
  'api_key',
  'private_key',
  'assertion',
]);

export function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    return REDACT_PATTERNS.reduce(
      (s, [pattern, replacement]) => s.replace(pattern, replacement),
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : redact(val);
    }
    return result;
  }
  return value;
}
