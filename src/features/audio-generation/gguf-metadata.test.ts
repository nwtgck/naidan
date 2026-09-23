import { Blob as NativeBlob } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { AUDIO_METADATA_SCAN_BYTES, readAudioGgufMetadata, type GgufMetadataFile } from './gguf-metadata';
import { concatenateGguf, ggufFixture, ggufInteger, ggufString, textMetadata, boolMetadata } from './test-utils/gguf';

const architecture = textMetadata({ key: 'general.architecture', value: 'qwen3tts' });
async function read({ file, signal, keys = ['general.architecture'] }: { file: GgufMetadataFile, signal?: AbortSignal, keys?: string[] }) {
  return readAudioGgufMetadata({ file, keys, signal });
}
describe('bounded advisory GGUF inspection', () => {
  it.each([2, 3])('reads version %i without inspecting tensors', async version => {
    const head = ggufFixture({ entries: [architecture], version });
    const file = new NativeBlob([head, new Uint8Array(1024 * 1024)]);
    const slice = vi.spyOn(file, 'slice'); const whole = vi.spyOn(file, 'arrayBuffer');
    expect((await read({ file })).get('general.architecture')).toBe('qwen3tts');
    expect(whole).not.toHaveBeenCalled(); expect(slice).toHaveBeenCalledOnce();
    expect(slice.mock.calls[0]?.[1]).toBeLessThanOrEqual(65536);
  });
  it('skips tokenizer strings, numeric arrays and unselected long strings without retaining them', async () => {
    const values = Array.from({ length: 2100 }, (_, i) => ggufString({ value: `token-${i}` }));
    const file = ggufFixture({ entries: [
      { key: 'tokenizer.ggml.tokens', type: 9, value: concatenateGguf({ parts: [ggufInteger({ value: 8, bytes: 4 }), ggufInteger({ value: values.length, bytes: 8 }), ...values] }) },
      { key: 'tokenizer.ggml.scores', type: 9, value: concatenateGguf({ parts: [ggufInteger({ value: 6, bytes: 4 }), ggufInteger({ value: 3, bytes: 8 }), new Uint8Array(12)] }) },
      textMetadata({ key: 'general.description', value: 'x'.repeat(200000) }), architecture,
    ] });
    const slice = vi.spyOn(file, 'slice');
    expect([...await read({ file })]).toEqual([['general.architecture', 'qwen3tts']]);
    expect(slice.mock.calls.length).toBeLessThan(10);
    expect(slice.mock.calls.every(([start = 0, end = 0]) => end - start <= 65536)).toBe(true);
  });
  it('reads companion keys in either order with strict boolean type', async () => {
    const file = ggufFixture({ entries: [textMetadata({ key: 'clip.gen.audio.projector_type', value: 'pockettts_gen' }), boolMetadata({ key: 'clip.has_gen_audio_encoder', value: true })] });
    expect([...await read({ file, keys: ['clip.has_gen_audio_encoder', 'clip.gen.audio.projector_type'] })]).toEqual([
      ['clip.gen.audio.projector_type', 'pockettts_gen'], ['clip.has_gen_audio_encoder', true],
    ]);
  });
  it('returns missing keys without making up values', async () => {
    expect((await read({ file: ggufFixture({ entries: [] }) })).size).toBe(0);
  });
  it.each([0, 1, 4])('rejects an unsupported header version %i', async version => {
    await expect(read({ file: ggufFixture({ entries: [architecture], version }) })).rejects.toThrow();
  });
  it('rejects bad magic, short header and truncated string values', async () => {
    await expect(read({ file: new NativeBlob(['not a model']) })).rejects.toThrow();
    const bytes = new Uint8Array(await ggufFixture({ entries: [architecture] }).arrayBuffer());
    await expect(read({ file: new NativeBlob([bytes.subarray(0, bytes.length - 1)]) })).rejects.toThrow();
    bytes[0] = 0;
    await expect(read({ file: new NativeBlob([bytes]) })).rejects.toThrow();
  });
  it.each([
    { key: 'general.architecture', type: 8, value: ggufInteger({ value: 2n ** 63n, bytes: 8 }) },
    { key: 'general.architecture', type: 8, value: ggufString({ value: 'x'.repeat(4097) }) },
    { key: 'general.architecture', type: 7, value: new Uint8Array([2]) },
    { key: 'general.architecture', type: 500, value: new Uint8Array() },
    { key: 'before', type: 9, value: concatenateGguf({ parts: [ggufInteger({ value: 8, bytes: 4 }), ggufInteger({ value: 1000001, bytes: 8 })] }) },
  ])('fails closed for unknown/malformed metadata without allocating its declared length: %j', async entry => {
    await expect(read({ file: ggufFixture({ entries: [entry, architecture] }) })).rejects.toThrow();
  });
  it('enforces the metadata offset budget before reading a later key', async () => {
    const file = ggufFixture({ entries: [textMetadata({ key: 'long', value: 'x'.repeat(AUDIO_METADATA_SCAN_BYTES) }), architecture] });
    const slice = vi.spyOn(file, 'slice');
    await expect(read({ file })).rejects.toThrow();
    expect(slice).toHaveBeenCalledOnce();
  });
  it('checks abort before and after IO', async () => {
    const controller = new AbortController(); const file = ggufFixture({ entries: [architecture] });
    controller.abort(); const slice = vi.spyOn(file, 'slice');
    await expect(read({ file, signal: controller.signal })).rejects.toThrow(); expect(slice).not.toHaveBeenCalled();
    const later = new AbortController(); const original = file.slice.bind(file);
    slice.mockImplementation((...args) => {
      const part = original(...args); later.abort(); return part;
    });
    await expect(read({ file, signal: later.signal })).rejects.toThrow();
  });
});
