import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, type EffectScope } from 'vue';
import { captureAudioSettings, useAudioHistory } from './useAudioHistory';
import { defaultAudioParameters, type AudioGenerationInput } from '@/features/audio-generation/types';
import { audioResult } from '@/features/audio-generation/test-utils/wav';
const scopes: EffectScope[] = [];
const urls = { create: vi.fn(), revoke: vi.fn() };
beforeEach(() => {
  let next = 0; urls.create.mockReset().mockImplementation(() => `blob:history-${++next}`); urls.revoke.mockReset();
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = urls.create; static override revokeObjectURL = urls.revoke;
  });
});
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop(); vi.unstubAllGlobals();
});
function input(): AudioGenerationInput {
  return { ...defaultAudioParameters(), model: 'user/model', text: 'Original text', language: 'ja', reference: new Blob(['reference']), options: { profile: 'auto' }, debug: 'off' };
}
function setup() {
  const scope = effectScope(); scopes.push(scope);
  return { scope, ...scope.run(useAudioHistory)! };
}
describe('page-owned audio history', () => {
  it('captures requested settings before mutation and excludes reference data entirely', () => {
    const request = input(); const settings = captureAudioSettings({ input: request, modelName: 'Original name' });
    request.text = 'Changed'; request.language = 'en'; request.contextTokens = 20000; request.options.profile = 'cpu-wasm32';
    expect(settings).toMatchObject({ text: 'Original text', language: 'ja', contextTokens: 4096, modelName: 'Original name', options: { profile: 'auto' } });
    expect(settings).not.toHaveProperty('reference');
  });
  it('prepends results without discarding or duplicating old WAV byte buffers', () => {
    const state = setup(); const settings = captureAudioSettings({ input: input(), modelName: 'Model' }); const result = audioResult();
    state.append({ result, settings }); state.append({ result, settings });
    expect(state.entries.value.map(e => e.id)).toEqual([2, 1]); expect(state.totalBytes.value).toBe(result.wav.byteLength * 2);
    expect(state.entries.value[0]!.result).not.toHaveProperty('wav'); expect(state.entries.value[0]!.settings).not.toHaveProperty('reference');
    expect(urls.revoke).not.toHaveBeenCalled(); expect(urls.create).toHaveBeenCalledTimes(2);
    const blob = urls.create.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe('audio/wav'); expect(blob.size).toBe(result.wav.byteLength);
  });
  it('deletes only the requested result and safely ignores repeated deletion', () => {
    const state = setup(); const settings = captureAudioSettings({ input: input(), modelName: 'Model' }); const result = audioResult();
    state.append({ result, settings }); state.append({ result, settings }); state.remove({ id: 1 }); state.remove({ id: 1 });
    expect(state.entries.value.map(e => e.id)).toEqual([2]); expect(state.totalBytes.value).toBe(result.wav.byteLength);
    expect(urls.revoke).toHaveBeenCalledExactlyOnceWith('blob:history-1');
    state.scope.stop(); expect(urls.revoke.mock.calls).toEqual([['blob:history-1'], ['blob:history-2']]);
  });
  it('clears all results while allowing later append with unique IDs', () => {
    const state = setup(); const settings = captureAudioSettings({ input: input(), modelName: 'Model' });
    state.append({ result: audioResult(), settings }); state.append({ result: audioResult(), settings }); state.clear();
    expect(state.entries.value).toEqual([]); expect(state.totalBytes.value).toBe(0); expect(urls.revoke).toHaveBeenCalledTimes(2);
    state.append({ result: audioResult(), settings }); expect(state.entries.value[0]!.id).toBe(3);
    state.scope.stop(); expect(urls.revoke).toHaveBeenCalledTimes(3);
  });
  it('keeps prior results when constructing a new Blob URL fails', () => {
    const state = setup(); const settings = captureAudioSettings({ input: input(), modelName: 'Model' });
    state.append({ result: audioResult(), settings }); urls.create.mockImplementationOnce(() => {
      throw new Error('no memory');
    });
    expect(() => state.append({ result: audioResult(), settings })).toThrow('no memory');
    expect(state.entries.value.map(e => e.id)).toEqual([1]); expect(urls.revoke).not.toHaveBeenCalled();
  });
});
