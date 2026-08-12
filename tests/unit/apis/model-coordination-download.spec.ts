import { gzipSync } from 'node:zlib';
import { describe, it, expect } from 'vitest';
import { readCappedBuffer, decodeResource } from '../../../src/apis/model-coordination.js';

/** Build a Web ReadableStream<Uint8Array> from a list of byte chunks. */
function makeStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i]!);
        i++;
      } else {
        controller.close();
      }
    },
  });
}

describe('readCappedBuffer — byte-counted buffering for the single-JSON-object resource files', () => {
  it('concatenates chunks into the original bytes when under the cap', async () => {
    const a = new TextEncoder().encode('{"clashes":');
    const b = new TextEncoder().encode('[]}');
    const buf = await readCappedBuffer(makeStream([a, b]), 1_000_000);
    expect(buf.toString('utf-8')).toBe('{"clashes":[]}');
  });

  it('throws once the running byte count exceeds maxBytes, before finishing the stream', async () => {
    const chunk = new Uint8Array(40).fill(0x61); // 40 bytes of 'a'
    await expect(readCappedBuffer(makeStream([chunk, chunk, chunk]), 50)).rejects.toThrow(
      /exceeded the 50-byte cap/,
    );
  });

  it('returns an empty buffer for an empty stream', async () => {
    const buf = await readCappedBuffer(makeStream([]), 1_000_000);
    expect(buf.length).toBe(0);
  });
});

describe('decodeResource — BOM strip + gzip + decompression-bomb guard', () => {
  it('strips a leading UTF-8 BOM from a plain-text buffer', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}', 'utf-8')]);
    expect(decodeResource(withBom)).toBe('{"a":1}');
  });

  it('passes through a plain-text buffer with no BOM unchanged', () => {
    expect(decodeResource(Buffer.from('{"a":1}', 'utf-8'))).toBe('{"a":1}');
  });

  it('gunzips a gzip-magic buffer', () => {
    const gz = gzipSync(Buffer.from('{"a":1}', 'utf-8'));
    expect(decodeResource(gz)).toBe('{"a":1}');
  });

  it('refuses to decompress past an explicit byte cap (decompression-bomb guard)', () => {
    // A small compressed payload that expands well past a tiny cap must throw rather than
    // allocate the full decompressed size — this is what protects against a hostile or
    // corrupted resource compressing to a tiny transfer size but exploding on decode.
    const gz = gzipSync(Buffer.alloc(10_000, 'a'));
    expect(() => decodeResource(gz, 100)).toThrow();
    // Comfortably under the cap still decodes fine.
    expect(() => decodeResource(gz, 1_000_000)).not.toThrow();
  });
});
