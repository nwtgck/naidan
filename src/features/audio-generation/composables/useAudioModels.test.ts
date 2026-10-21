import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope, type EffectScope } from 'vue';
import { flushPromises } from '@vue/test-utils';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import type { AudioModelDetection, inspectStoredAudioModel } from '@/features/audio-generation/model-detection';
import { useAudioModels } from './useAudioModels';
const scopes: EffectScope[] = [];

afterEach(() => {
  for (const scope of scopes.splice(0)) {
    scope.stop();
  }
});

const detected: AudioModelDetection = { status: 'detected', pipeline: 'qwen3-tts', reference: 'optional' };
const unverified: AudioModelDetection = { status: 'unverified', reason: 'metadata' };

function entry({ modelId, size }: { modelId: string, size: number }): LocalModel {
  return { modelId, size, importedAt: 1 };
}

function setup() {
  const inspect = vi.fn<typeof inspectStoredAudioModel>().mockResolvedValue(detected);
  const scope = effectScope();
  scopes.push(scope);
  const models = scope.run(() => useAudioModels({ inspect }))!;
  return { inspect, effect: scope, ...models };
}

describe('audio candidate selection lifecycle', () => {
  it('filters normal choices and selects one detected model without a native runtime', async () => {
    const state = setup();
    state.inspect.mockImplementation(async ({ modelId }) => modelId === 'chat' ? unverified : detected);
    state.updateModels({ entries: [entry({ modelId: 'chat', size: 1 }), entry({ modelId: 'large', size: 200 }), entry({ modelId: 'small', size: 100 })] });
    expect(state.scanState.value).toBe('scanning');
    expect(state.modelId.value).toBe('');
    await flushPromises();
    expect(state.modelId.value).toBe('small');
    expect(state.visibleModels.value.map(m => m.modelId)).toEqual(['large', 'small']);
    expect(state.detectedCount.value).toBe(2);
    expect(state.scanState.value).toBe('idle');
  });

  it('allows every stored model after detection errors without automatically picking a chat model', async () => {
    const state = setup();
    state.inspect.mockRejectedValue(new Error('no metadata'));
    state.updateModels({ entries: [entry({ modelId: 'chat', size: 100 }), entry({ modelId: 'future-audio', size: 100 })] });
    await flushPromises();
    expect(state.visibleModels.value).toEqual([]);
    expect(state.modelId.value).toBe('');
    state.showAllModels();
    expect(state.visibleModels.value).toHaveLength(2);
    state.modelId.value = 'future-audio';
    state.selectionChanged();
    expect(state.modelId.value).toBe('future-audio');
    expect(state.scope.value).toBe('all');
  });

  it('never replaces a manual selection with a late successful metadata scan', async () => {
    const state = setup();
    const pending = Promise.withResolvers<AudioModelDetection>();
    state.inspect.mockImplementation(({ modelId }) => modelId === 'chat' ? pending.promise : Promise.resolve(detected));
    state.updateModels({ entries: [entry({ modelId: 'chat', size: 100 }), entry({ modelId: 'voice', size: 100 })] });
    state.showAllModels();
    state.modelId.value = 'chat';
    state.selectionChanged();
    pending.resolve(unverified);
    await flushPromises();
    expect(state.modelId.value).toBe('chat');
    expect(state.scope.value).toBe('all');
  });

  it('preserves an existing default when another smaller candidate appears', async () => {
    const state = setup();
    state.updateModels({ entries: [entry({ modelId: 'original', size: 100 })] });
    await flushPromises();
    state.updateModels({ entries: [entry({ modelId: 'original', size: 100 }), entry({ modelId: 'new', size: 1 })] });
    await flushPromises();
    expect(state.modelId.value).toBe('original');
    state.modelId.value = 'new';
    state.selectionChanged();
    state.updateModels({ entries: [entry({ modelId: 'original', size: 100 }), entry({ modelId: 'new', size: 1 })] });
    await flushPromises();
    expect(state.modelId.value).toBe('new');
  });

  it('picks another candidate if the previous model was deleted', async () => {
    const state = setup();
    state.updateModels({ entries: [entry({ modelId: 'old', size: 100 })] });
    await flushPromises();
    state.selectionChanged();
    state.updateModels({ entries: [entry({ modelId: 'new', size: 100 })] });
    await flushPromises();
    expect(state.modelId.value).toBe('new');
    state.updateModels({ entries: [] });
    await flushPromises();
    expect(state.modelId.value).toBe('');
    expect(state.detectedCount.value).toBe(0);
  });

  it('ignores superseded scans even if the inspector ignores cancellation', async () => {
    const state = setup();
    const pending = Promise.withResolvers<AudioModelDetection>();
    state.inspect.mockReturnValueOnce(pending.promise);
    state.updateModels({ entries: [entry({ modelId: 'old', size: 100 }), entry({ modelId: 'never-read', size: 100 })] });
    const signal = state.inspect.mock.calls[0]![0].signal!;
    state.updateModels({ entries: [entry({ modelId: 'new', size: 100 })] });
    await flushPromises();
    expect(signal.aborted).toBe(true);
    expect(state.modelId.value).toBe('new');
    pending.resolve(detected);
    await flushPromises();
    expect(state.modelId.value).toBe('new');
    expect([...state.detections.value.keys()]).toEqual(['new']);
    expect(state.inspect).toHaveBeenCalledTimes(2);
  });

  it('aborts scanning on scope disposal without publishing a late candidate', async () => {
    const state = setup();
    const pending = Promise.withResolvers<AudioModelDetection>();
    state.inspect.mockReturnValueOnce(pending.promise);
    state.updateModels({ entries: [entry({ modelId: 'old', size: 100 })] });
    state.effect.stop();
    expect(state.inspect.mock.calls[0]![0].signal!.aborted).toBe(true);
    pending.resolve(detected);
    await flushPromises();
    expect(state.modelId.value).toBe('');
  });

  it('explicitly returning to detected-only mode does not leave an unverified model selected', async () => {
    const state = setup();
    state.inspect.mockImplementation(async ({ modelId }) => modelId === 'unknown' ? unverified : detected);
    state.updateModels({ entries: [entry({ modelId: 'unknown', size: 100 }), entry({ modelId: 'voice', size: 100 })] });
    await flushPromises();
    state.selectModel({ modelId: 'unknown' });
    expect(state.modelId.value).toBe('unknown');
    expect(state.scope.value).toBe('all');
    state.scope.value = 'detected';
    state.scopeChanged();
    expect(state.modelId.value).toBe('voice');
    expect(state.visibleModels.value).toHaveLength(1);
  });

  it('ignores an ambiguous duplicate modelId emitted by the shared manager', async () => {
    const state = setup();
    state.updateModels({ entries: [entry({ modelId: 'user/same', size: 100 }), entry({ modelId: 'user/same', size: 100 })] });
    state.selectModel({ modelId: 'user/same' });
    expect(state.modelId.value).toBe('');
    await flushPromises();
    expect(state.modelId.value).toBe('user/same');
  });
});
