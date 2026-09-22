import { describe, expect, it } from 'vitest';
import { readStreamLines } from './read-stream-lines';

function stream({ chunks }: { chunks: readonly Uint8Array[] }): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk); controller.close();
  } });
}
async function read({ source, maxLineLength }: { source: ReadableStream<Uint8Array>, maxLineLength: number }): Promise<string[]> {
  const lines = [];
  for await (const line of readStreamLines({ stream: source, signal: new AbortController().signal, maxLineLength })) lines.push(line);
  return lines;
}
describe('stream line reader', () => {
  it('decodes split multibyte characters and CRLF without losing a final unterminated line', async () => {
    // Explicit framing bytes keep this test independent of source newline normalization.
    const bytes = new Uint8Array([...new TextEncoder().encode('日本🙂'), 13, 10, ...new TextEncoder().encode('最後')]);
    const lines = await read({ source: stream({ chunks: [...bytes].map(byte => new Uint8Array([byte])) }), maxLineLength: 100 });
    expect(lines).toEqual(['日本🙂', '最後']);
  });
  it('does not silently replace corrupt UTF8', async () => {
    await expect(read({ source: stream({ chunks: [new Uint8Array([0xff])] }), maxLineLength: 100 })).rejects.toThrow();
  });
  it('caps a pending line without inventing a delimiter', async () => {
    await expect(read({ source: stream({ chunks: [new TextEncoder().encode('123456')] }), maxLineLength: 5 })).rejects.toThrow();
  });
  it('aborts a pending read through the source cancellation hook', async () => {
    let cancelled = false;
    const controller = new AbortController();
    const source = new ReadableStream<Uint8Array>({ cancel() {
      cancelled = true;
    } });
    const iterator = readStreamLines({ stream: source, signal: controller.signal, maxLineLength: 100 });
    const next = iterator.next(); controller.abort();
    await expect(next).rejects.toThrow(); expect(cancelled).toBe(true); expect(source.locked).toBe(false);
  });
  it('cancels and releases an unread source when the consumer stops', async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`\
first
second
`));
    }, cancel() {
      cancelled = true;
    } });
    for await (const _line of readStreamLines({ stream: source, signal: new AbortController().signal, maxLineLength: 100 })) break;
    expect(cancelled).toBe(true); expect(source.locked).toBe(false);
  });
});
