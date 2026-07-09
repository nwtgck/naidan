import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat, Endpoint, Settings } from '@/01-models/types';
import { toChatId } from '@/01-models/ids';

const mocks = vi.hoisted(() => ({
  availableModels: { value: [] as string[] },
  currentChatRef: { value: null as Chat | null },
  endpoint: { value: { type: 'openai', url: 'http://old.example/v1' } as Endpoint },
  settings: {
    value: {
      endpoint: { type: 'openai', url: 'http://global.example/v1' } as Endpoint,
      titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: { temperature: undefined, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } } },
      storageType: 'memory',
      providerProfiles: [],
      mounts: [],
    } as Settings,
  },
  listModels: vi.fn(),
  triggerCurrentChat: vi.fn(),
}));

vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  availableModels: mocks.availableModels,
  chatRuntimeStore: {
    startTask: vi.fn(),
    finishTask: vi.fn(),
  },
  currentChatRef: mocks.currentChatRef,
  getLiveChatById: () => mocks.currentChatRef.value,
  rootItems: { value: [] },
  triggerCurrentChat: mocks.triggerCurrentChat,
}));

vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    settings: mocks.settings,
  }),
}));

vi.mock('@/composables/chat/chat-model-helpers', () => ({
  resolveChatEndpointForChat: () => mocks.endpoint.value,
  resolveGlobalEndpoint: ({ settings }: { settings: Settings }) => settings.endpoint,
}));

vi.mock('@/features/lm/providerFactory', () => ({
  loadLmProvider: async () => ({
    listModels: mocks.listModels,
  }),
}));

vi.mock('@/composables/useGlobalEvents', () => ({
  useGlobalEvents: () => ({ addErrorEvent: vi.fn() }),
}));

import { fetchModelsForChat, fetchModelsForGlobalEndpoint } from './chat-model-fetch';

describe('chat model fetch endpoint races', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.availableModels.value = [];
    mocks.endpoint.value = { type: 'openai', url: 'http://old.example/v1' };
    mocks.settings.value.endpoint = { type: 'openai', url: 'http://global.example/v1' };
    mocks.currentChatRef.value = {
      id: toChatId({ raw: 'chat-1' }),
      title: '',
      modelId: 'old-model',
      root: { items: [] },
      updatedAt: 0,
      createdAt: 0,
      debugEnabled: false,
    };
  });

  it('does not publish a global model list fetched for an endpoint that is no longer active', async () => {
    let resolveModels: ((models: string[]) => void) | undefined;
    mocks.listModels.mockReturnValue(new Promise<string[]>((resolve) => {
      resolveModels = resolve;
    }));

    const fetchPromise = fetchModelsForGlobalEndpoint({
      errorSource: 'test',
    });

    mocks.settings.value.endpoint = { type: 'browser_provided_lm' };
    resolveModels?.(['old-global-model']);
    await fetchPromise;

    expect(mocks.availableModels.value).toEqual([]);
  });

  it('does not apply a model list fetched for an endpoint that is no longer active', async () => {
    let resolveModels: ((models: string[]) => void) | undefined;
    mocks.listModels.mockReturnValue(new Promise<string[]>((resolve) => {
      resolveModels = resolve;
    }));

    const fetchPromise = fetchModelsForChat({
      chatId: toChatId({ raw: 'chat-1' }),
      errorSource: 'test',
    });

    mocks.endpoint.value = { type: 'browser_provided_lm' };
    if (mocks.currentChatRef.value) {
      mocks.currentChatRef.value.modelId = 'browser-provided-language-model';
    }
    resolveModels?.(['old-model']);
    await fetchPromise;

    expect(mocks.currentChatRef.value?.modelId).toBe('browser-provided-language-model');
    expect(mocks.availableModels.value).toEqual([]);
    expect(mocks.triggerCurrentChat).not.toHaveBeenCalled();
  });
});
