// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPatchLineSourceFromBytes } from './source';

afterEach(() => vi.restoreAllMocks());
describe('patch line indexing directly from owned bytes', () => {
  it.each(['', 'one', 'one\n', `\
one

two`, 'one\t two\r\n日本語'])('keeps byte boundaries and line endings for %j', async text => {
    const bytes = new TextEncoder().encode(text);
    vi.spyOn(Blob.prototype, 'arrayBuffer').mockRejectedValue(new Error('Unsafe Blob read'));
    const source = await createPatchLineSourceFromBytes({ bytes });
    expect(source.byteLength).toBe(bytes.length);
    const lines = text === '' ? [] : text.split('\n');
    if (text.endsWith('\n')) lines.pop();
    expect(source.lineCount).toBe(lines.length);
    expect(source.boundaryOffset({ lineIndex: source.lineCount })).toBe(bytes.length);
    for (let i = 0; i < lines.length; i++) {
      expect(await source.lineMatches({ lineIndex: i, patchLine: {
        kind: 'context', content: new TextEncoder().encode(lines[i]), terminator: i === lines.length - 1 && !text.endsWith('\n') ? 'none' : 'lf',
      }, whitespaceMode: 'exact' })).toBe(true);
    }
  });

  it('owns its input and emits fresh chunks even if an output consumer changes them', async () => {
    const bytes = new Uint8Array([0, 255, 128, 10, 195, 40]);
    const expected = bytes.slice();
    const source = await createPatchLineSourceFromBytes({ bytes });
    bytes.fill(0);
    await source.forEachChunk({ start: 0, end: expected.length, consume: async ({ chunk }) => {
      expect(chunk).toEqual(expected); chunk.fill(9);
    } });
    await source.forEachChunk({ start: 0, end: expected.length, consume: async ({ chunk }) => {
      expect(chunk).toEqual(expected);
    } });
    await expect(source.forEachChunk({ start: -1, end: 1, consume: async () => undefined })).rejects.toThrow();
  });
});
