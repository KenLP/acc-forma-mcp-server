# ADR 0001: TypeScript Strict Mode

**Status:** Accepted  
**Date:** 2026-04-16

## Context

The official `aps-mcp-server-nodejs` is plain JavaScript with no type checking. This leads to subtle bugs (wrong field names, missing `b.` prefix, null pointer crashes) that are hard to catch without real APS credentials.

## Decision

Use TypeScript 5.x with `strict: true`, `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true`, and `noImplicitReturns: true`.

## Consequences

- Errors caught at compile time rather than at runtime in production
- IDE autocompletion for all APS API payloads
- Slightly higher initial setup cost; zero runtime overhead (compiles to JS)
- `skipLibCheck: true` avoids noise from APS SDK type declaration quirks
