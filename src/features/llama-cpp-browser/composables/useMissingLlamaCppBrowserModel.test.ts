import { computed, effectScope, ref, shallowRef } from 'vue';
import { flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat, Endpoint, Settings } from '@/01-models/types';
import { DEFAULT_SETTINGS } from '@/01-models/types';
import { toChatId } from '@/01-models/ids';
import { LlamaCppBrowserError, type EngineState } from '@/features/llama-cpp-browser/types';
import { createDownloadQueue } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import { localModelAvailability } from '@/features/llama-cpp-browser/model-recovery/availability';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { useMissingLlamaCppBrowserModel } from './useMissingLlamaCppBrowserModel';

const calls = vi.hoisted(() => ({ read: vi.fn(), resolve: vi.fn(), inspect: vi.fn(), download: vi.fn() }));
const settings = ref<Settings>({ ...DEFAULT_SETTINGS, endpoint: { type: 'llama_cpp_browser' }, storageType: 'opfs' });
const current = shallowRef<Chat | null>(null);
const resolved = ref<{ endpoint: Endpoint, modelId: string | undefined }>({ endpoint: { type: 'llama_cpp_browser' }, modelId: undefined });
const enabled = ref(true);
let storageVersion = 0;
let queue: ReturnType<typeof createDownloadQueue>;
const tasks: { cancelled: boolean, task: () => Promise<void> }[] = [];
const modelListeners = new Set<() => void>();
const stateListeners = new Set<({ state }: { state: EngineState }) => void>();
vi.mock('@/utils/idle-task', () => ({
  scheduleIdleTask: ({ task }: { task: () => Promise<void> }) => {
    const entry = { cancelled: false, task };
    tasks.push(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
      },
    };
  },
}));
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings }) }));
vi.mock('@/00-storage/service', () => ({
  storageService: {
    captureModelLaunchStorage: () => {
      const version = storageVersion;
      return () => version === storageVersion;
    },
  },
}));
vi.mock('../runtime/model-resolution', () => ({
  resolveModel: (args: unknown) => {
    calls.resolve(args);
    return calls.read(args);
  },
}));
vi.mock('../hugging-face/metadata-session', () => ({ getMetadataSession: () => ({ inspect: calls.inspect }) }));
vi.mock('../hugging-face/download-queue', async importOriginal => ({ ...await importOriginal<typeof import('@/features/llama-cpp-browser/hugging-face/download-queue')>(), getDownloadQueue: () => queue }));
vi.mock('@/features/llama-cpp-browser', () => ({
  llamaCppBrowserService: {
    subscribeModelList: ({ listener }: { listener: () => void }) => {
      modelListeners.add(listener);
      return () => modelListeners.delete(listener);
    },
    subscribe: ({ listener }: { listener: ({ state }: { state: EngineState }) => void }) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
  },
}));
const modelId = 'hf.co/owner/Model:Q4_K_M';
const scopes: ReturnType<typeof effectScope>[] = [];

function start() {
  const scope = effectScope();
  scopes.push(scope);
  const state = scope.run(() => useMissingLlamaCppBrowserModel({ chat: computed(() => current.value), resolved: computed(() => resolved.value), enabled: computed(() => enabled.value) }));
  if (state === undefined) {
    throw new Error('Missing hook');
  }
  return { state, scope };
}

async function checkNow(): Promise<void> {
  await flushPromises();
  for (let round = 0; tasks.length > 0 && round < 5; round++) {
    const batch = tasks.splice(0);
    await Promise.all(batch.filter(entry => !entry.cancelled).map(entry => entry.task()));
    await flushPromises();
  }
}

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  vi.resetAllMocks();
  tasks.length = 0;
  storageVersion = 0;
  enabled.value = true;
  localModelAvailability.invalidate();
  settings.value = { ...DEFAULT_SETTINGS, endpoint: { type: 'llama_cpp_browser' }, storageType: 'opfs' };
  current.value = { id: toChatId({ raw: 'ordinary-chat' }), title: null, root: { items: [] }, createdAt: 1, updatedAt: 1, debugEnabled: false };
  resolved.value = { endpoint: { type: 'llama_cpp_browser' }, modelId };
  calls.read.mockRejectedValue(new LlamaCppBrowserError({ code: 'missing-model' }));
  calls.download.mockResolvedValue(undefined);
  queue = createDownloadQueue({ download: calls.download });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop());
  tasks.length = 0;
  expect(modelListeners.size).toBe(0);
  expect(stateListeners.size).toBe(0);
});

describe('ordinary Chat model recovery', () => {
  it('renders the Chat first, inspects locally later, and never inspects remote metadata on mount', async () => {
    const before = structuredClone(current.value);
    const { state } = start();
    expect(calls.resolve).not.toHaveBeenCalled();
    expect(calls.read).not.toHaveBeenCalled();
    expect(state.visible.value).toBe(false);
    await checkNow();
    expect(calls.resolve).toHaveBeenCalledExactlyOnceWith({ modelId, signal: undefined });
    expect(state.availability.value).toBe('missing');
    expect(state.visible.value).toBe(true);
    expect(state.maySend.value).toBe(false);
    expect(calls.inspect).not.toHaveBeenCalled();
    expect(calls.download).not.toHaveBeenCalled();
    expect(current.value).toEqual(before);
    expect(state).not.toHaveProperty('composerVisibility');
  });

  it('does not interfere with another endpoint or the dedicated model-link screen', async () => {
    enabled.value = false;
    const { state } = start();
    await checkNow();
    expect(calls.read).not.toHaveBeenCalled();
    expect(state.maySend.value).toBe(true);
    enabled.value = true;
    resolved.value.endpoint = { type: 'openai', url: 'https://example.invalid' };
    await checkNow();
    expect(calls.read).not.toHaveBeenCalled();
    expect(state.visible.value).toBe(false);
  });

  it('uses the effective model even if the Chat has no local model override', async () => {
    const { state } = start();
    await checkNow();
    expect(calls.read).toHaveBeenCalledWith({ modelId, signal: undefined });
    resolved.value.modelId = 'user/changed';
    await checkNow();
    expect(state.modelId.value).toBe('user/changed');
    expect(calls.read).toHaveBeenLastCalledWith({ modelId: 'user/changed', signal: undefined });
  });

  it('shares the observation across rapid Chat changes instead of scanning on each open', async () => {
    calls.read.mockResolvedValue({});
    const { state } = start();
    await checkNow();
    current.value = { ...current.value!, id: toChatId({ raw: 'second-chat' }) };
    await checkNow();
    expect(calls.read).toHaveBeenCalledOnce();
    expect(state.maySend.value).toBe(true);
    const second = start();
    await checkNow();
    expect(calls.read).toHaveBeenCalledOnce();
    expect(second.state.maySend.value).toBe(true);
  });

  it('does not show a download on a permission error and can recheck after it is resolved', async () => {
    calls.read.mockRejectedValue(new DOMException('private path', 'NotAllowedError'));
    const { state } = start();
    await checkNow();
    expect(state.availability.value).toBe('unreadable');
    expect(calls.inspect).not.toHaveBeenCalled();
    calls.read.mockResolvedValue({});
    state.retry();
    await checkNow();
    expect(state.visible.value).toBe(false);
    expect(state.maySend.value).toBe(true);
  });

  it('ignores a delayed result after changing models', async () => {
    const gate = Promise.withResolvers<unknown>();
    calls.read.mockReturnValueOnce(gate.promise);
    const { state } = start();
    const pending = tasks.shift()!.task();
    await flushPromises();
    resolved.value.modelId = 'user/new';
    calls.read.mockResolvedValue({});
    await checkNow();
    gate.reject(new LlamaCppBrowserError({ code: 'missing-model' }));
    await pending;
    expect(state.availability.value).toBe('available');
    expect(state.modelId.value).toBe('user/new');
  });

  it('does not retain ready state from a replaced storage provider', async () => {
    const gate = Promise.withResolvers<unknown>();
    calls.read.mockReturnValueOnce(gate.promise);
    const { state } = start();
    const pending = tasks.shift()!.task();
    await flushPromises();
    storageVersion++;
    gate.resolve({});
    await pending;
    expect(state.availability.value).toBe('unreadable');
    expect(state.maySend.value).toBe(false);
  });

  it('rechecks on file changes, focus and runtime missing-model, but not byte progress', async () => {
    calls.read.mockResolvedValue({});
    const { state } = start();
    await checkNow();
    calls.read.mockClear();
    for (const listener of stateListeners) {
      listener({ state: { status: 'working', progress: { phase: 'loading', completed: 1, total: 100 } } });
    }
    await checkNow();
    expect(calls.read).not.toHaveBeenCalled();
    calls.read.mockRejectedValue(new LlamaCppBrowserError({ code: 'missing-model' }));
    for (const listener of modelListeners) {
      listener();
    }
    await checkNow();
    expect(state.availability.value).toBe('missing');
    calls.read.mockResolvedValue({});
    window.dispatchEvent(new Event('focus'));
    await checkNow();
    expect(state.availability.value).toBe('available');
    calls.read.mockRejectedValue(new LlamaCppBrowserError({ code: 'missing-model' }));
    for (const listener of stateListeners) {
      listener({ state: { status: 'error', code: 'missing-model' } });
    }
    await checkNow();
    expect(state.availability.value).toBe('missing');
  });
});
