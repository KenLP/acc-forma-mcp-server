import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SERVER_VERSION } from '../../src/version.js';

// The version is stated in four places that a human has to keep in step: the bundle
// constant, package.json, the MCP handshake, and the marketplace manifest. They drifted
// once already — the packaged exe announced 0.1.0 while the manifest said 0.1.1, which is
// exactly the "binary does not match the declaration" problem Autodesk rejects for. These
// tests fail on the next drift instead of leaving it to be found in a release.
describe('version is consistent across every declaration', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as { version: string };
  const manifest = JSON.parse(readFileSync('mcp-manifest.json', 'utf-8')) as {
    server: { version: string };
  };

  it('SERVER_VERSION matches package.json', () => {
    expect(SERVER_VERSION).toBe(pkg.version);
  });

  it('SERVER_VERSION matches mcp-manifest.json server.version', () => {
    expect(SERVER_VERSION).toBe(manifest.server.version);
  });

  it('is a plain semver triple', () => {
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('the MCP handshake and the startup log both read the shared constant', () => {
    // Guards against a fresh hard-coded literal being reintroduced next to either of them.
    for (const file of ['src/server.ts', 'src/index.ts']) {
      const src = readFileSync(file, 'utf-8');
      expect(src, `${file} must import SERVER_VERSION`).toContain(
        "from './version.js'",
      );
      expect(src, `${file} must not hard-code a version literal`).not.toMatch(
        /version:\s*'\d+\.\d+\.\d+'/,
      );
    }
  });
});
