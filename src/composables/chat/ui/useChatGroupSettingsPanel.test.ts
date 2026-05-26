import { computed } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCurrentChatGroup,
  mockFetchingModels,
  mockUpdateChatGroupMetadata,
  mockFetchAvailableModels,
  mockAddMountToChatGroup,
  mockRemoveMountFromChatGroup,
  mockUpdateChatGroupMount,
} = vi.hoisted(() => ({
  mockCurrentChatGroup: {
    value: {
      id: 'group-1',
      name: 'Group 1',
    },
  },
  mockFetchingModels: { value: false },
  mockUpdateChatGroupMetadata: vi.fn(),
  mockFetchAvailableModels: vi.fn(),
  mockAddMountToChatGroup: vi.fn(),
  mockRemoveMountFromChatGroup: vi.fn(),
  mockUpdateChatGroupMount: vi.fn(),
}));

vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  fetchingModels: mockFetchingModels,
}));

vi.mock('./useChatUiServices', () => ({
  useChatUiServices: () => ({
    hierarchyService: {
      updateChatGroupMetadata: mockUpdateChatGroupMetadata,
    },
    modelService: {
      fetchAvailableModels: mockFetchAvailableModels,
    },
    mountService: {
      addMountToChatGroup: mockAddMountToChatGroup,
      removeMountFromChatGroup: mockRemoveMountFromChatGroup,
      updateChatGroupMount: mockUpdateChatGroupMount,
    },
  }),
}));

vi.mock('./useCurrentChatState', () => ({
  useCurrentChatState: () => ({
    currentChatGroup: computed(() => mockCurrentChatGroup.value),
    TEST_ONLY: {},
  }),
}));

import { useChatGroupSettingsPanel } from './useChatGroupSettingsPanel';

describe('useChatGroupSettingsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchingModels.value = false;
    mockFetchAvailableModels.mockResolvedValue(['model-a']);
  });

  it('exposes current group state and shared fetching state', () => {
    const chatGroupSettingsPanel = useChatGroupSettingsPanel();

    expect(chatGroupSettingsPanel.currentChatGroup.value?.id).toBe('group-1');
    expect(chatGroupSettingsPanel.fetchingModels.value).toBe(false);
  });

  it('binds metadata and mount actions to the underlying chat store', async () => {
    const chatGroupSettingsPanel = useChatGroupSettingsPanel();

    await chatGroupSettingsPanel.updateMetadata({
      groupId: 'group-1',
      updates: { name: 'Renamed' },
    });

    await chatGroupSettingsPanel.addMount({
      groupId: 'group-1',
      mount: {
        type: 'volume',
        volumeId: 'volume-1',
        mountPath: '/mnt/volume-1',
        readOnly: true,
      },
    });

    await chatGroupSettingsPanel.removeMount({
      groupId: 'group-1',
      volumeId: 'volume-1',
    });

    await chatGroupSettingsPanel.updateMount({
      groupId: 'group-1',
      volumeId: 'volume-1',
      mountPath: '/mnt/volume-1',
      readOnly: false,
    });

    expect(mockUpdateChatGroupMetadata).toHaveBeenCalledWith({
      id: 'group-1',
      updates: { name: 'Renamed' },
    });
    expect(mockAddMountToChatGroup).toHaveBeenCalledWith({
      groupId: 'group-1',
      mount: {
        type: 'volume',
        volumeId: 'volume-1',
        mountPath: '/mnt/volume-1',
        readOnly: true,
      },
    });
    expect(mockRemoveMountFromChatGroup).toHaveBeenCalledWith({
      groupId: 'group-1',
      volumeId: 'volume-1',
    });
    expect(mockUpdateChatGroupMount).toHaveBeenCalledWith({
      groupId: 'group-1',
      volumeId: 'volume-1',
      mountPath: '/mnt/volume-1',
      readOnly: false,
    });
  });

  it('fetches models through the custom endpoint path', async () => {
    const chatGroupSettingsPanel = useChatGroupSettingsPanel();

    await expect(chatGroupSettingsPanel.fetchModels({
      endpointType: 'openai',
      endpointUrl: 'http://localhost:1234',
      endpointHttpHeaders: [['Authorization', 'Bearer secret']],
    })).resolves.toEqual(['model-a']);

    expect(mockFetchAvailableModels).toHaveBeenCalledWith({
      chatId: undefined,
      customEndpoint: {
        type: 'openai',
        url: 'http://localhost:1234',
        headers: [['Authorization', 'Bearer secret']],
      },
    });
  });
});
