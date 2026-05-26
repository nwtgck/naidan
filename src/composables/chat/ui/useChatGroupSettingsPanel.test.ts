import { computed } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCurrentChatGroup,
  mockFetchingModels,
  mockUpdateChatGroupMetadata,
  mockFetchAvailableModelsForEndpoint,
  mockAddMount,
  mockRemoveMount,
  mockUpdateMount,
  mockLoadData,
  mockUpdateChatGroup,
} = vi.hoisted(() => ({
  mockCurrentChatGroup: {
    value: {
      id: 'group-1',
      name: 'Group 1',
    },
  },
  mockFetchingModels: { value: false },
  mockUpdateChatGroupMetadata: vi.fn(),
  mockFetchAvailableModelsForEndpoint: vi.fn(),
  mockAddMount: vi.fn(),
  mockRemoveMount: vi.fn(),
  mockUpdateMount: vi.fn(),
  mockLoadData: vi.fn(),
  mockUpdateChatGroup: vi.fn(),
}));

vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  fetchingModels: mockFetchingModels,
  loadData: mockLoadData,
}));

vi.mock('@/services/storage', () => ({
  storageService: {
    updateChatGroup: mockUpdateChatGroup,
  },
}));

vi.mock('@/composables/chat/chat-scoped/chat-model-helpers', () => ({
  fetchAvailableModelsForEndpoint: mockFetchAvailableModelsForEndpoint,
}));

vi.mock('@/composables/chat/chat-scoped/useChatGroupMounts', () => ({
  useChatGroupMounts: () => ({
    addMount: mockAddMount,
    removeMount: mockRemoveMount,
    updateMount: mockUpdateMount,
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
    mockFetchAvailableModelsForEndpoint.mockResolvedValue(['model-a']);
    mockUpdateChatGroup.mockImplementation(async (_groupId: string, updater: (current: { id: string; name: string } | null) => { id: string; name: string }) => {
      mockUpdateChatGroupMetadata(updater({ id: 'group-1', name: 'Group 1' }));
    });
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

    expect(mockUpdateChatGroup).toHaveBeenCalled();
    expect(mockUpdateChatGroupMetadata).toHaveBeenCalledWith({
      id: 'group-1',
      name: 'Renamed',
      updatedAt: expect.any(Number),
    });
    expect(mockLoadData).toHaveBeenCalledWith({});
    expect(mockAddMount).toHaveBeenCalledWith({
      mount: {
        type: 'volume',
        volumeId: 'volume-1',
        mountPath: '/mnt/volume-1',
        readOnly: true,
      },
    });
    expect(mockRemoveMount).toHaveBeenCalledWith({
      volumeId: 'volume-1',
    });
    expect(mockUpdateMount).toHaveBeenCalledWith({
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

    expect(mockFetchAvailableModelsForEndpoint).toHaveBeenCalledWith({
      endpointType: 'openai',
      endpointUrl: 'http://localhost:1234',
      endpointHttpHeaders: [['Authorization', 'Bearer secret']],
      errorSource: 'useChatGroupSettingsPanel:fetchModels',
    });
  });
});
