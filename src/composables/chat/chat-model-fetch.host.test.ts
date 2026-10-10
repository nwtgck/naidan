import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat, Endpoint, Settings } from '@/01-models/types';
import { toChatId } from '@/01-models/ids';

const mocks = vi.hoisted(() => ({
  availableModels: { value: [] as string[] },
  currentChatRef: { value: undefined as Chat | undefined },
  endpoint: { value: { type: 'llama_cpp_browser' } as Endpoint },
  settings: {
    value: {
      endpoint: { type: 'llama_cpp_browser' },
      titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: { temperature: undefined, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } } },
      storageType: 'memory',
      providerProfiles: [],
      mounts: [],
    } as Settings,
  },
  listModels: vi.fn<() => Promise<string[]>>(),
  triggerCurrentChat: vi.fn(),
}));

vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  availableModels: mocks.availableModels,
  chatRuntimeStore: { startTask: vi.fn(), finishTask: vi.fn() },
  currentChatRef: mocks.currentChatRef,
  getLiveChatById: () => mocks.currentChatRef.value,
  rootItems: { value: [] },
  triggerCurrentChat: mocks.triggerCurrentChat,
}));
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings: mocks.settings }) }));
vi.mock('@/composables/chat/chat-model-helpers', () => ({
  resolveChatEndpointForChat: () => mocks.endpoint.value,
  resolveGlobalEndpoint: ({ settings }: { settings: Settings }) => settings.endpoint,
}));
vi.mock('@/features/lm/providerFactory', () => ({ loadLmProvider: async () => ({ listModels: mocks.listModels }) }));
vi.mock('@/composables/useGlobalEvents', () => ({ useGlobalEvents: () => ({ addErrorEvent: vi.fn() }) }));

import { fetchModelsForChat } from './chat-model-fetch';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.availableModels.value = [];
  mocks.endpoint.value = { type: 'llama_cpp_browser' };
  mocks.currentChatRef.value = {
    id: toChatId({ raw: 'host-chat' }),
    title: '',
    modelId: undefined,
    root: { items: [] },
    updatedAt: 123,
    createdAt: 0,
    debugEnabled: false,
  };
});

describe('linked host model selection survives temporary unavailability', () => {
  it.each([
    { selected: 'host/root-a/owner/repo:model.gguf', listed: [] },
    { selected: 'host/root-a/owner/repo:nested%2Fmodel.gguf', listed: ['hf.co/owner/repo:nested%2Fmodel.gguf'] },
    { selected: 'host/root-a/owner/repo:model.gguf', listed: ['host/root-b/owner/repo:model.gguf'] },
    { selected: 'host/root%3Aone/owner/repo:weights%3Aoriginal%2Fmodel.gguf', listed: [] },
  ])('preserves exact identity $selected without substituting another source', async ({ selected, listed }) => {
    const chat = mocks.currentChatRef.value;
    if (!chat) throw new Error('Expected chat fixture');
    chat.modelId = selected;
    mocks.listModels.mockResolvedValue(listed);

    expect(await fetchModelsForChat({ chatId: chat.id, errorSource: 'test' })).toEqual(listed);

    expect(chat.modelId).toBe(selected);
    expect(chat.updatedAt).toBe(123);
    expect(mocks.availableModels.value).toEqual(listed);
    expect(mocks.triggerCurrentChat).not.toHaveBeenCalled();
  });

  it('preserves a saved RPC Host file selection after the catalog adopts variant names', async () => {
    const chat = mocks.currentChatRef.value;
    if (!chat) throw new Error('Expected chat fixture');
    const selected = 'host/Models/owner/repo:repo-Q4_K_M.gguf';
    chat.modelId = selected;
    mocks.endpoint.value = { type: 'naidan_rpc', registrationId: undefined };
    mocks.listModels.mockResolvedValue(['host/Models/owner/repo:Q4_K_M']);
    await fetchModelsForChat({ chatId: chat.id, errorSource: 'test' });
    expect(chat.modelId).toBe(selected); expect(chat.updatedAt).toBe(123);
    expect(mocks.triggerCurrentChat).not.toHaveBeenCalled();
  });

  it('still clears unavailable names on other model providers', async () => {
    const chat = mocks.currentChatRef.value;
    if (!chat) throw new Error('Expected chat fixture');
    chat.modelId = 'host/root-a/owner/repo:model.gguf';
    mocks.endpoint.value = { type: 'openai', url: 'https://example.invalid/v1' };
    mocks.listModels.mockResolvedValue([]);

    await fetchModelsForChat({ chatId: chat.id, errorSource: 'test' });

    expect(chat.modelId).toBe('');
    expect(mocks.triggerCurrentChat).toHaveBeenCalledExactlyOnceWith({ chatId: chat.id });
  });
});
