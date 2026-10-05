// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createTextExportStream } from './text-export-stream';

describe('streamed text export', () => {
  it('encodes split surrogate pairs, lone surrogates and Blob text without whole-output buffering', async () => {
    const text = 'a'.repeat(16 * 1024 - 1) + '😀日本語' + '\ud800';
    const file = new Blob(['\ufeff', 'disk text 😀']);
    vi.spyOn(file, 'text').mockRejectedValue(new Error('whole-file read forbidden'));
    vi.spyOn(file, 'arrayBuffer').mockRejectedValue(new Error('whole-file read forbidden'));
    const stream = createTextExportStream({ produce: async ({ write }) => {
      await write({ text }); await write({ text: file }); await write({ text: '\nend' });
    } });
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    await stream.pipeTo(new WritableStream({ write(chunk) {
      expect(chunk.byteLength).toBeLessThanOrEqual(64 * 1024); chunks.push(Uint8Array.from(chunk));
    } }));
    expect(await new Blob(chunks).text()).toBe(text.toWellFormed() + `\
disk text 😀
end`);
    expect(file.text).not.toHaveBeenCalled(); expect(file.arrayBuffer).not.toHaveBeenCalled();
  });

  it('stops a cancelled producer under backpressure instead of building the remaining output', async () => {
    let writes = 0;
    const finished = Promise.withResolvers<void>();
    const stream = createTextExportStream({ produce: async ({ write }) => {
      try {
        for (let i = 0; i < 10000; i++) {
          await write({ text: 'x'.repeat(64 * 1024) }); writes += 1;
        }
      } finally {
        finished.resolve();
      }
    } });
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel(); await finished.promise;
    expect(writes).toBeLessThanOrEqual(3);
  });

  it('reports producer failures through the readable side', async () => {
    const stream = createTextExportStream({ produce: async ({ write }) => {
      await write({ text: 'prefix' }); throw new Error('export failed');
    } });
    await expect(new Response(stream).text()).rejects.toThrow('export failed');
  });
});
