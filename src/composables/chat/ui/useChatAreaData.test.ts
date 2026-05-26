import { computed } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatFlowItem } from '@/composables/useChatDisplayFlow';

const {
  mockState,
  mockGetSortedImageModels,
  mockFetchAvailableModels,
  mockIsThinkingActive,
  mockIsWaitingResponse,
  mockUpdateChatSettings,
  mockUpdateChatGroupMetadata,
} = vi.hoisted(() => ({
  mockState: {
    availableModels: ['model-a', 'model-b'] as string[],
    fetchingModels: false,
    chatFlow: [] as ChatFlowItem[],
    chatGroups: [{ id: 'group-1', name: 'Group 1' }],
  },
  mockGetSortedImageModels: vi.fn(({ availableModels }) => availableModels),
  mockFetchAvailableModels: vi.fn().mockResolvedValue(['model-a']),
  mockIsThinkingActive: vi.fn(() => false),
  mockIsWaitingResponse: vi.fn(() => false),
  mockUpdateChatSettings: vi.fn().mockResolvedValue(undefined),
  mockUpdateChatGroupMetadata: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  fetchingModels: computed(() => mockState.fetchingModels),
  isProcessing: vi.fn(() => false),
}));

vi.mock('@/composables/useImageGeneration', () => ({
  useImageGeneration: () => ({
    getSortedImageModels: mockGetSortedImageModels,
  }),
}));

vi.mock('@/composables/useChatDisplayFlow', () => ({
  useChatDisplayFlow: () => ({
    chatFlow: computed(() => mockState.chatFlow),
    isThinkingActive: mockIsThinkingActive,
    isWaitingResponse: mockIsWaitingResponse,
  }),
}));

vi.mock('./useCurrentChatState', () => ({
  useCurrentChatState: () => ({
    currentChat: computed(() => null),
    TEST_ONLY: {},
  }),
}));

vi.mock('./useChatUiServices', () => ({
  useChatUiServices: () => ({
    availableModels: computed(() => mockState.availableModels),
    derivedState: {
      chatGroups: computed(() => mockState.chatGroups),
    },
    metadataService: {
      updateChatSettings: mockUpdateChatSettings,
    },
    hierarchyService: {
      updateChatGroupMetadata: mockUpdateChatGroupMetadata,
    },
    modelService: {
      fetchAvailableModels: mockFetchAvailableModels,
    },
  }),
}));

import { useChatAreaData } from './useChatAreaData';

describe('useChatAreaData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.availableModels = ['model-a', 'model-b'];
    mockState.fetchingModels = false;
    mockState.chatFlow = [];
    mockState.chatGroups = [{ id: 'group-1', name: 'Group 1' }];
    mockFetchAvailableModels.mockResolvedValue(['model-a']);
  });

  it('exposes chat area state from the compat store', () => {
    const chatAreaData = useChatAreaData();

    expect(chatAreaData.availableModels.value).toEqual(['model-a', 'model-b']);
    expect(chatAreaData.fetchingModels.value).toBe(false);
    expect(chatAreaData.chatFlow.value).toEqual([]);
    expect(chatAreaData.availableChatGroups.value).toEqual([{ id: 'group-1', name: 'Group 1' }]);
  });

  it('delegates actions to the compat store', async () => {
    const chatAreaData = useChatAreaData();

    await expect(chatAreaData.fetchAvailableModels({
      chatId: 'chat-1',
      customEndpoint: undefined,
    })).resolves.toEqual(['model-a']);

    await chatAreaData.updateChatSettings({
      id: 'chat-1',
      updates: { titleModelId: 'model-a' },
    });

    await chatAreaData.updateChatGroupMetadata({
      id: 'group-1',
      updates: { titleModelId: 'model-b' },
    });

    expect(mockFetchAvailableModels).toHaveBeenCalledWith({
      chatId: 'chat-1',
      customEndpoint: undefined,
    });
    expect(mockUpdateChatSettings).toHaveBeenCalledWith({
      id: 'chat-1',
      updates: { titleModelId: 'model-a' },
    });
    expect(mockUpdateChatGroupMetadata).toHaveBeenCalledWith({
      id: 'group-1',
      updates: { titleModelId: 'model-b' },
    });
  });

  it('delegates image model sorting and flow predicates', () => {
    const chatAreaData = useChatAreaData();
    const flowItem = {
      type: 'message',
      node: { id: 'message-1', role: 'assistant', content: 'Hello', timestamp: 0, replies: { items: [] } },
      mode: 'content',
      flow: { position: 'standalone', nesting: 'none' },
      isFirstInNode: true,
      isLastInNode: true,
      isFirstInTurn: true,
    } as ChatFlowItem;

    chatAreaData.getSortedImageModels({
      availableModels: ['model-b', 'model-a'],
    });
    chatAreaData.isThinkingActive({
      item: flowItem,
    });
    chatAreaData.isWaitingResponse({
      item: flowItem,
    });

    expect(mockGetSortedImageModels).toHaveBeenCalledWith({
      availableModels: ['model-b', 'model-a'],
    });
    expect(mockIsThinkingActive).toHaveBeenCalledWith({
      item: flowItem,
    });
    expect(mockIsWaitingResponse).toHaveBeenCalledWith({
      item: flowItem,
    });
  });
});
