import { flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import type { HttpEndpoint } from '@/01-models/types';
import type { LmProvider } from '@/01-models/lm';
import { useModelConnectionSelection } from './useModelConnectionSelection';

const loadLmProvider = vi.hoisted(() => vi.fn());
vi.mock('@/features/lm/providerFactory', () => ({ loadLmProvider }));

function createHarness() {
  const active = ref(true);
  const type = ref<HttpEndpoint['type'] | 'browser_provided_lm'>('openai');
  const url = ref('');
  const headers = ref<[string, string][]>([]);
  const scope = effectScope();
  const selection = scope.run(() => useModelConnectionSelection({ active, type, url, headers, getFakeLmDebugModeStatus: () => 'disabled' }));
  if (selection === undefined) {
    throw new Error('Missing selection scope');
  }
  return { active, type, url, headers, selection, [Symbol.dispose]: () => scope.stop() };
}

beforeEach(() => {
  loadLmProvider.mockReset();
  loadLmProvider.mockResolvedValue({ listModels: vi.fn().mockResolvedValue(['model-10', 'model-2']) });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('uncommitted connection model discovery', () => {
  it('keeps remote URLs local until an explicit refresh', async () => {
    vi.useFakeTimers();
    using owner = createHarness();
    owner.url.value = 'https://example.invalid/v1';
    owner.headers.value = [['Authorization', 'Bearer secret']];
    await vi.advanceTimersByTimeAsync(500);
    expect(loadLmProvider).not.toHaveBeenCalled();
    await owner.selection.refresh();
    expect(loadLmProvider).toHaveBeenCalledExactlyOnceWith({ endpoint: { type: 'openai', url: 'https://example.invalid/v1', httpHeaders: [['Authorization', 'Bearer secret']] }, fakeLmDebugModeStatus: 'disabled' });
    expect(owner.selection.models.value).toEqual(['model-2', 'model-10']);
    expect(owner.selection.modelId.value).toBe('model-2');
    expect(owner.selection.state.value).toEqual({ status: 'ready' });
  });

  it.each(['localhost:11434', 'http://127.0.0.1:1234/v1', 'http://[::1]:8080/v1'])('debounces automatic discovery for %s', async url => {
    vi.useFakeTimers();
    using owner = createHarness();
    owner.url.value = url;
    await vi.advanceTimersByTimeAsync(249);
    expect(loadLmProvider).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(loadLmProvider).toHaveBeenCalledOnce();
    expect(owner.selection.models.value).toEqual(['model-2', 'model-10']);
  });

  it.each(['http://localhost.example.invalid', 'https://example.invalid/?localhost', 'http://localhost@example.invalid'])('does not discover lookalike loopback URLs automatically: %s', async url => {
    vi.useFakeTimers();
    using owner = createHarness();
    owner.url.value = url;
    await vi.advanceTimersByTimeAsync(500);
    expect(loadLmProvider).not.toHaveBeenCalled();
  });

  it('invalidates an old response when URL, headers, or connection type changes', async () => {
    using owner = createHarness();
    const first = Promise.withResolvers<string[]>();
    const firstList = vi.fn().mockReturnValue(first.promise);
    loadLmProvider.mockResolvedValueOnce({ listModels: firstList });
    owner.url.value = 'https://first.invalid/v1';
    const pending = owner.selection.refresh();
    await flushPromises();
    const oldSignal: AbortSignal = firstList.mock.calls[0]?.[0].signal;
    owner.headers.value = [['X-Key', 'new']];
    expect(oldSignal.aborted).toBe(true);
    owner.type.value = 'ollama';
    owner.url.value = 'https://second.invalid';
    await owner.selection.refresh();
    first.resolve(['old']);
    await pending;
    expect(owner.selection.models.value).toEqual(['model-2', 'model-10']);
    expect(loadLmProvider.mock.calls[1]?.[0].endpoint).toEqual({ type: 'ollama', url: 'https://second.invalid', httpHeaders: [['X-Key', 'new']] });
  });

  it('does not start a request after an obsolete provider import resolves', async () => {
    using owner = createHarness();
    const provider = Promise.withResolvers<LmProvider>();
    loadLmProvider.mockReturnValueOnce(provider.promise);
    owner.url.value = 'https://first.invalid';
    const pending = owner.selection.refresh();
    await flushPromises();
    owner.url.value = 'https://second.invalid';
    const listModels = vi.fn();
    provider.resolve({ listModels, chat: async function* () { } });
    await pending;
    expect(listModels).not.toHaveBeenCalled();
  });

  it('aborts pending work when the presentation closes, and ignores its late response', async () => {
    using owner = createHarness();
    const result = Promise.withResolvers<string[]>();
    const listModels = vi.fn().mockReturnValue(result.promise);
    loadLmProvider.mockResolvedValue({ listModels });
    owner.url.value = 'https://example.invalid';
    const pending = owner.selection.refresh();
    await flushPromises();
    owner.active.value = false;
    expect(listModels.mock.calls[0]?.[0].signal.aborted).toBe(true);
    result.resolve(['late']);
    await pending;
    expect(owner.selection.models.value).toEqual([]);
    expect(owner.selection.state.value).toEqual({ status: 'idle' });
  });

  it('retains selection across a refresh and permits retry without exposing provider details', async () => {
    using owner = createHarness();
    owner.url.value = 'https://example.invalid';
    await owner.selection.refresh();
    owner.selection.modelId.value = 'model-10';
    loadLmProvider.mockResolvedValueOnce({ listModels: vi.fn().mockRejectedValue(new Error('Authorization: secret')) });
    await owner.selection.refresh();
    expect(owner.selection.state.value).toEqual({ status: 'failed', reason: 'request' });
    expect(owner.selection.modelId.value).toBe('model-10');
    expect(JSON.stringify(owner.selection.state.value)).not.toContain('secret');
    await owner.selection.refresh();
    expect(owner.selection.modelId.value).toBe('model-10');
    expect(owner.selection.state.value).toEqual({ status: 'ready' });
  });

  it('keeps missing or empty model lists unselected and never fetches the browser endpoint', async () => {
    using owner = createHarness();
    await owner.selection.refresh();
    expect(owner.selection.state.value).toEqual({ status: 'failed', reason: 'invalid-url' });
    expect(loadLmProvider).not.toHaveBeenCalled();
    owner.url.value = 'https://example.invalid';
    loadLmProvider.mockResolvedValue({ listModels: vi.fn().mockResolvedValue([]) });
    await owner.selection.refresh();
    expect(owner.selection.modelId.value).toBeUndefined();
    owner.type.value = 'browser_provided_lm';
    await owner.selection.refresh();
    expect(loadLmProvider).toHaveBeenCalledOnce();
  });
});
