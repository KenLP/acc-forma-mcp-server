import { describe, it, expect } from 'vitest';
import { readNdjsonStream } from '../../../src/apis/model-properties.js';

/** Build a Web ReadableStream<Uint8Array> from a list of string chunks — simulates the
 *  network delivering the response body in arbitrary pieces, independent of line boundaries. */
function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]));
        i++;
      } else {
        controller.close();
      }
    },
  });
}

describe('readNdjsonStream — streaming NDJSON parse with caps', () => {
  it('parses multiple complete lines delivered in one chunk', async () => {
    const stream = makeStream(['{"a":1}\n{"a":2}\n{"a":3}\n']);
    const { rows, truncated } = await readNdjsonStream(stream, { maxBytes: 1_000_000 });
    expect(rows).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
    expect(truncated).toBe(false);
  });

  it('reassembles a JSON row split across two chunks', async () => {
    // The middle of the second row's line lands exactly on a chunk boundary.
    const stream = makeStream(['{"a":1}\n{"a":2', ',"b":"x"}\n{"a":3}\n']);
    const { rows } = await readNdjsonStream(stream, { maxBytes: 1_000_000 });
    expect(rows).toEqual([{ a: 1 }, { a: 2, b: 'x' }, { a: 3 }]);
  });

  it('parses a trailing line with no final newline', async () => {
    const stream = makeStream(['{"a":1}\n{"a":2}']);
    const { rows } = await readNdjsonStream(stream, { maxBytes: 1_000_000 });
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('skips blank lines', async () => {
    const stream = makeStream(['{"a":1}\n\n\n{"a":2}\n']);
    const { rows } = await readNdjsonStream(stream, { maxBytes: 1_000_000 });
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('stops at maxLines instead of parsing the whole stream', async () => {
    const stream = makeStream(['{"a":1}\n{"a":2}\n{"a":3}\n{"a":4}\n']);
    const { rows, truncated } = await readNdjsonStream(stream, { maxBytes: 1_000_000, maxLines: 2 });
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
    expect(truncated).toBe(true);
  });

  it('stops at maxLines even when the cutoff falls mid-chunk', async () => {
    const stream = makeStream(['{"a":1}\n{"a":2}\n{"a":3}\n', '{"a":4}\n{"a":5}\n']);
    const { rows, truncated } = await readNdjsonStream(stream, { maxBytes: 1_000_000, maxLines: 3 });
    expect(rows).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
    expect(truncated).toBe(true);
  });

  it('throws once bytes read exceed maxBytes, without finishing the stream', async () => {
    const bigLine = `{"a":"${'x'.repeat(100)}"}\n`;
    const stream = makeStream([bigLine, bigLine, bigLine]);
    await expect(readNdjsonStream(stream, { maxBytes: 50 })).rejects.toThrow(/exceeded the 50-byte cap/);
  });
});
