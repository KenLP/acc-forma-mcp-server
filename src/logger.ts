import pino from 'pino';

// MCP stdio transport uses stdout for JSON-RPC — logs MUST go to stderr
export const logger = pino(
  {
    level: process.env['LOG_LEVEL'] ?? 'info',
    ...(process.env['LOG_PRETTY'] === 'true'
      ? { transport: { target: 'pino-pretty', options: { colorize: true, destination: 2 } } }
      : {}),
  },
  process.env['LOG_PRETTY'] === 'true' ? undefined : pino.destination(2),
);
