import type { ChatGroupId, ChatId, MessageId } from '@/models/ids';
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, type Mock } from 'vitest';
import { mount, flushPromises, VueWrapper } from '@vue/test-utils';
import ChatPane from './ChatPane.vue';
import ChatInput from './ChatInput.vue';
import { nextTick, ref, reactive, computed } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import { useChatDraft } from '@/composables/useChatDraft';
import { setupScrollToMock } from '@/utils/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import type { WeshMount } from '@/services/wesh/types';
import { idToRaw, toChatGroupId, toChatId, toMessageId, toVolumeId } from '@/models/ids';

// Mock router
const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/', component: {} }],
});

import type { MessageNode, Chat } from '@/models/types';
import { EMPTY_LM_PARAMETERS } from '@/models/types';
import type { ChatFlowItem } from '@/composables/useChatDisplayFlow';
import type { ScopedSettingChange } from '@/models/scoped-setting-change';
import { applyScopedSettingChangesToChat } from '@/utils/scoped-setting-changes';

const {
  mockEnsureChatTmpDirectory,
  mockOpenFileExplorer,
  mockGetVolumeDirectoryHandle,
  mockGetNaidanSysfsAccessScope,
} = vi.hoisted(() => ({
  mockEnsureChatTmpDirectory: vi.fn(),
  mockOpenFileExplorer: vi.fn(),
  mockGetVolumeDirectoryHandle: vi.fn(),
  mockGetNaidanSysfsAccessScope: vi.fn(),
}));

// Mock dependencies
const mockSendMessage = vi.fn().mockResolvedValue(true);
const mockAbortChat = vi.fn();
const mockStreaming = ref(false);
const mockAvailableModels = ref<string[]>([]);
const mockFetchingModels = ref(false);
const mockGeneratingTitle = ref(false);
const mockFetchAvailableModels = vi.fn();
const mockGenerateChatTitle = vi.fn();
const mockAbortTitleGeneration = vi.fn();
const mockCompactCurrentBranch = vi.fn().mockResolvedValue(true);
const mockAbortContextCompact = vi.fn();
const mockRegenerateMessage = vi.fn();
const mockEditMessage = vi.fn();
const mockSwitchVersion = vi.fn();
const mockForkChat = vi.fn().mockResolvedValue('new-id');
const mockToggleChatDebug = vi.fn();
const mockContextCompactProgress = ref<any>({ phase: 'idle' });
const mockRenameChat = vi.fn().mockImplementation(({ newTitle }) => {
  if (mockCurrentChat.value) {
    mockCurrentChat.value.title = newTitle;
  }
});
const mockSaveSettings = vi.fn().mockResolvedValue(undefined);
const mockActiveGenerations = reactive(new Map());
const mockCurrentChat = ref<Chat | null>({
  id: toChatId({ raw: '1' }),
  title: 'Test Chat',
  root: { items: [] } as { items: MessageNode[] },
  currentLeafId: undefined,
  debugEnabled: false,
  originChatId: undefined,
  modelId: undefined as string | undefined,
  lmParameters: EMPTY_LM_PARAMETERS,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});
const mockActiveMessages = ref<MessageNode[]>([]);
const mockChatFlowOverride = ref<ChatFlowItem[] | null>(null);

const mockGetLiveChat = vi.fn().mockImplementation((chat) => {
  if (mockCurrentChat.value && idToRaw({ id: mockCurrentChat.value.id }) === (chat.id || chat)) {
    return mockCurrentChat.value;
  }
  return chat;
});

const mockUpdateChatSettings = vi.fn().mockImplementation(({ id, updates }) => {
  if (mockCurrentChat.value && idToRaw({ id: mockCurrentChat.value.id }) === id) {
    Object.assign(mockCurrentChat.value, updates);
  }
});
const mockUpdateChatGroupMetadata = vi.fn().mockImplementation(({ id, updates }) => {
  if (mockCurrentChatGroup.value && mockCurrentChatGroup.value.id === id) {
    Object.assign(mockCurrentChatGroup.value, updates);
  }
});
const mockUpdateChatGroupScopedSettings = vi.fn();
const mockUpdateChatScopedSettings = vi.fn().mockImplementation(async ({
  chatId,
  changes,
}: {
  chatId: ChatId,
  changes: readonly ScopedSettingChange[],
}) => {
  if (mockCurrentChat.value && mockCurrentChat.value.id === chatId) {
    mockCurrentChat.value = applyScopedSettingChangesToChat({
      current: mockCurrentChat.value,
      changes,
      updatedAt: mockCurrentChat.value.updatedAt + 1,
    });
  }
});

const mockOpenChatGroup = vi.fn();
const mockMoveChatToGroup = vi.fn();
const mockUpdateChatModel = vi.fn().mockImplementation(({ id, modelId }) => {
  if (mockCurrentChat.value && mockCurrentChat.value.id === id) {
    mockCurrentChat.value = {
      ...mockCurrentChat.value,
      modelId,
    };
  }
  if (mockResolvedSettings.value) {
    mockResolvedSettings.value = {
      ...mockResolvedSettings.value,
      modelId,
      sources: {
        ...mockResolvedSettings.value.sources,
        modelId: 'chat',
      },
    };
  }
});
const mockSaveChat = vi.fn();
const mockCurrentChatGroup = ref<any>(null);
const mockChatGroups = ref<any[]>([]);
const mockResolvedSettings = ref<any>(null);
const mockInheritedSettings = ref<any>(null);
const mockSettings = ref<any>({
  endpoint: { type: 'openai', url: 'http://localhost' },
  defaultModelId: 'global-default-model',
  storageType: 'opfs',
  mounts: [],
});
const mockTmpHandle = { kind: 'directory', name: 'tmp' } as FileSystemDirectoryHandle;


vi.mock('@/composables/useAppPresentation', () => ({
  isAppInteractionEnabled: ({ interaction }: { interaction: string }) => interaction === 'enabled',
  useAppPresentation: () => ({
    appInteraction: {
      __v_isRef: true,
      value: 'enabled',
    },
  }),
}));

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: mockCurrentChat,
    currentChatGroup: mockCurrentChatGroup,
    chatGroups: mockChatGroups,
    resolvedSettings: mockResolvedSettings.value || ref({
      endpoint: { type: 'openai', url: 'http://localhost' },
      lmParameters: { reasoning: { effort: undefined } },
    }),
    inheritedSettings: mockInheritedSettings,
    sendMessage: mockSendMessage,
    renameChat: mockRenameChat,
    updateChatModel: mockUpdateChatModel,
    saveChat: mockSaveChat,
    streaming: mockStreaming,
    activeGenerations: mockActiveGenerations,
    toggleDebug: vi.fn(() => {
      if (mockCurrentChat.value) {
        mockCurrentChat.value.debugEnabled = !mockCurrentChat.value.debugEnabled;
      }
    }),
    activeMessages: mockActiveMessages,
    getSiblings: vi.fn().mockReturnValue([]),
    editMessage: vi.fn(),
    switchVersion: vi.fn(),
    abortChat: mockAbortChat,
    availableModels: mockAvailableModels,
    fetchingModels: mockFetchingModels,
    generatingTitle: mockGeneratingTitle,
    fetchAvailableModels: mockFetchAvailableModels,
    generateChatTitle: mockGenerateChatTitle,
    abortTitleGeneration: mockAbortTitleGeneration,
    isGeneratingTitle: vi.fn(({ chatId: _chatId }) => mockGeneratingTitle.value),
    forkChat: vi.fn().mockResolvedValue('new-id'),
    openChatGroup: mockOpenChatGroup,
    moveChatToGroup: mockMoveChatToGroup,
    getLiveChat: mockGetLiveChat,
    updateChatSettings: mockUpdateChatSettings,
    updateChatGroupMetadata: mockUpdateChatGroupMetadata,
    ensureChatTmpDirectory: mockEnsureChatTmpDirectory,
    isTaskRunning: vi.fn((id: string) => mockStreaming.value || mockActiveGenerations.has(id)),
    isProcessing: vi.fn((id: string) => mockStreaming.value || mockActiveGenerations.has(id)),
    isImageMode: vi.fn(() => false),
    toggleImageMode: vi.fn(),
    getResolution: vi.fn(() => ({ width: 512, height: 512 })),
    updateResolution: vi.fn(),
    getCount: vi.fn(() => 1),
    updateCount: vi.fn(),
    getSteps: vi.fn(() => undefined),
    updateSteps: vi.fn(),
    getSeed: vi.fn(() => 'browser_random'),
    updateSeed: vi.fn(),
    getPersistAs: vi.fn(() => 'original'),
    updatePersistAs: vi.fn(),
    setImageModel: vi.fn(),
    getSelectedImageModel: vi.fn(),
    getSortedImageModels: vi.fn(() => []),
    imageModeMap: ref({}),
    imageResolutionMap: ref({}),
    imageCountMap: ref({}),
    imagePersistAsMap: ref({}),
    imageModelOverrideMap: ref({}),
    getReasoningEffort: vi.fn(({ chatId }) => {
      if (mockCurrentChat.value && idToRaw({ id: mockCurrentChat.value.id }) === chatId) {
        return mockCurrentChat.value.lmParameters?.reasoning?.effort;
      }
      return undefined;
    }),
    updateReasoningEffort: vi.fn(({ chatId, effort }) => {
      if (mockCurrentChat.value && idToRaw({ id: mockCurrentChat.value.id }) === chatId) {
        const lmParameters = { ...(mockCurrentChat.value.lmParameters || EMPTY_LM_PARAMETERS), reasoning: { effort } };
        mockCurrentChat.value.lmParameters = lmParameters;
      }
    }),
    chatFlow: computed(() => mockChatFlowOverride.value ?? mockActiveMessages.value.map(m => ({
      type: 'message',
      node: m,
      mode: 'content',
      flow: { position: 'standalone', nesting: 'none' },
      isFirstInNode: true,
      isLastInNode: true,
      isFirstInTurn: true,
    }))),
    isThinkingActive: vi.fn(() => false),
    isWaitingResponse: vi.fn(() => false),
  }),
}));

vi.mock('../composables/chat/chat-scoped/useChatCompact', () => ({
  useChatCompact: () => ({
    progress: mockContextCompactProgress,
    run: mockCompactCurrentBranch,
    abort: mockAbortContextCompact,
  }),
}));

vi.mock('../composables/chat/ui/useCurrentChatState', () => ({
  useCurrentChatState: () => ({
    currentChat: computed(() => mockCurrentChat.value),
    currentChatGroup: computed(() => mockCurrentChatGroup.value),
    currentChatId: computed(() => mockCurrentChat.value?.id),
    activeMessages: computed(() => mockActiveMessages.value),
    allMessages: computed(() => mockActiveMessages.value),
    resolvedSettings: computed(() => mockResolvedSettings.value),
    inheritedSettings: computed(() => mockInheritedSettings.value),
    chatGroups: computed(() => mockChatGroups.value),
  }),
}));

vi.mock('../composables/chat/ui/useChatPaneState', () => ({
  useChatPaneState: () => ({
    chat: computed(() => mockCurrentChat.value),
    chatGroup: computed(() => mockCurrentChatGroup.value),
    activeMessages: computed(() => mockActiveMessages.value),
    allMessages: computed(() => mockActiveMessages.value),
    resolvedSettings: computed(() => mockResolvedSettings.value),
    inheritedSettings: computed(() => mockInheritedSettings.value),
    chatGroups: computed(() => mockChatGroups.value),
  }),
}));

vi.mock('../composables/chat/chat-activity-queries', () => ({
  isChatProcessing: ({ chatId }: { chatId: string }) =>
    !!mockCurrentChat.value && idToRaw({ id: mockCurrentChat.value.id }) === chatId && (mockStreaming.value || mockActiveGenerations.has(chatId)),
  getChatContextCompactProgress: ({ chatId }: { chatId: string }) =>
    mockCurrentChat.value?.id !== undefined && idToRaw({ id: mockCurrentChat.value.id }) === chatId ? mockContextCompactProgress.value : { phase: 'idle' },
  isChatGeneratingTitle: ({ chatId }: { chatId: string }) =>
    mockCurrentChat.value?.id !== undefined && idToRaw({ id: mockCurrentChat.value.id }) === chatId ? mockGeneratingTitle.value : false,
}));

function mountChatPane({
  props,
  attachTo,
  global,
}: {
  props?: {
    chatId?: ChatId,
    autoSendPrompt?: string,
    targetMessageId?: MessageId,
  },
  attachTo?: Element | string,
  global?: Record<string, unknown>,
} = {}) {
  return mount(ChatPane, {
    props: {
      chatId: props?.chatId ?? mockCurrentChat.value?.id ?? toChatId({ raw: '1' }),
      autoSendPrompt: props?.autoSendPrompt,
      targetMessageId: props?.targetMessageId,
    },
    attachTo,
    global,
  });
}

vi.mock('../composables/useChatDisplayFlow', () => ({
  useChatDisplayFlow: () => ({
    chatFlow: computed(() => mockChatFlowOverride.value ?? mockActiveMessages.value.map(m => ({
      type: 'message',
      node: m,
      mode: 'content',
      flow: { position: 'standalone', nesting: 'none' },
      isFirstInNode: true,
      isLastInNode: true,
      isFirstInTurn: true,
    }))),
    isThinkingActive: vi.fn(() => false),
    isWaitingResponse: vi.fn(() => false),
  }),
}));

vi.mock('../composables/chat/useChatConversation', () => ({
  useChatConversation: () => ({
    sendMessage: ({ chatId, content, parentId, attachments, lmParameters }: {
      chatId: string,
      content: string,
      parentId: string | null | undefined,
      attachments: unknown[] | undefined,
      lmParameters: unknown,
    }) => mockSendMessage({
      chatId,
      content,
      parentId,
      attachments,
      lmParameters,
    }),
    regenerateMessage: ({ chatId, failedMessageId }: { chatId: string, failedMessageId: string }) =>
      mockRegenerateMessage({
        chatId,
        failedMessageId,
      }),
    abort: ({ chatId }: { chatId: string }) => mockAbortChat({ chatId }),
  }),
}));

vi.mock('../composables/chat/useChatBranches', () => ({
  useChatBranches: () => ({
    editMessage: ({ chatId, messageId, newContent, lmParameters }: {
      chatId: string,
      messageId: string,
      newContent: string,
      lmParameters: unknown,
    }) => mockEditMessage({
      chatId,
      messageId,
      newContent,
      lmParameters,
    }),
    switchVersion: ({ chatId, messageId }: { chatId: string, messageId: string }) =>
      mockSwitchVersion({
        chatId,
        messageId,
      }),
    forkChat: ({ chatId, messageId }: { chatId: string, messageId: string }) =>
      mockForkChat({
        chatId,
        messageId,
      }),
  }),
}));

vi.mock('../composables/chat/useChatCompaction', () => ({
  useChatCompaction: () => ({
    compactCurrentBranch: ({ chatId, keepRecentMessages, instructionOverride }: {
      chatId: string,
      keepRecentMessages: number,
      instructionOverride: string | undefined,
    }) => mockCompactCurrentBranch({
      chatId,
      keepRecentMessages,
      instructionOverride,
    }),
    abort: ({ chatId }: { chatId: string }) =>
      mockAbortContextCompact({ chatId }),
  }),
}));

vi.mock('../composables/chat/useChatGroups', () => ({
  useChatGroups: () => ({
    moveChatToGroup: ({ chatId, chatGroupId }: { chatId: string, chatGroupId: string | null }) =>
      mockMoveChatToGroup({
        chatId,
        targetGroupId: chatGroupId,
      }),
    updateChatGroupMetadata: ({ chatGroupId, updates }: {
      chatGroupId: string,
      updates: Record<string, unknown>,
    }) =>
      mockUpdateChatGroupMetadata({
        id: chatGroupId,
        updates,
      }),
    updateScopedSettings: ({ chatGroupId, changes }: {
      chatGroupId: string,
      changes: readonly unknown[],
    }) => mockUpdateChatGroupScopedSettings({ chatGroupId, changes }),
  }),
}));

vi.mock('../composables/chat/useChatTitle', () => ({
  useChatTitle: () => ({
    generateTitle: ({ chatId, signal, titleModelIdOverride }: {
      chatId: string,
      signal: AbortSignal | undefined,
      titleModelIdOverride: string | undefined,
    }) =>
      mockGenerateChatTitle({
        chatId,
        signal,
        titleModelIdOverride,
      }),
    abortTitleGeneration: ({ chatId }: { chatId: string }) =>
      mockAbortTitleGeneration({
        chatId,
      }),
  }),
}));

vi.mock('../composables/chat/useChatMetadata', () => ({
  useChatMetadata: () => ({
    rename: ({ chatId, title }: { chatId: string, title: string }) =>
      mockRenameChat({
        id: chatId,
        newTitle: title,
      }),
    toggleDebug: ({ chatId }: { chatId: string }) => {
      mockToggleChatDebug();
      if (mockCurrentChat.value?.id !== undefined && idToRaw({ id: mockCurrentChat.value.id }) === chatId) {
        mockCurrentChat.value = {
          ...mockCurrentChat.value,
          debugEnabled: !mockCurrentChat.value.debugEnabled,
        };
      }
    },
    updateModel: ({ chatId, modelId }: { chatId: string, modelId: string | undefined }) => {
      if (mockCurrentChat.value?.id !== undefined && idToRaw({ id: mockCurrentChat.value.id }) === chatId) {
        mockCurrentChat.value = {
          ...mockCurrentChat.value,
          modelId,
        };
        queueMicrotask(() => {
          if (mockCurrentChat.value?.id !== undefined && idToRaw({ id: mockCurrentChat.value.id }) === chatId) {
            mockCurrentChat.value = {
              ...mockCurrentChat.value,
              modelId,
            };
          }
        });
        setTimeout(() => {
          if (mockCurrentChat.value?.id !== undefined && idToRaw({ id: mockCurrentChat.value.id }) === chatId) {
            mockCurrentChat.value = {
              ...mockCurrentChat.value,
              modelId,
            };
          }
        }, 0);
      }

      return mockUpdateChatModel({
        id: chatId,
        modelId,
      });
    },
    updateSettings: ({ chatId, updates }: { chatId: string, updates: Record<string, unknown> }) =>
      mockUpdateChatSettings({
        id: chatId,
        updates,
      }),
    updateScopedSettings: ({ chatId, changes }: {
      chatId: ChatId,
      changes: readonly ScopedSettingChange[],
    }) => mockUpdateChatScopedSettings({ chatId, changes }),
    reasoningEffort: ({ chatId }: { chatId: { value: string } }) =>
      computed(() => mockCurrentChat.value?.id !== undefined && idToRaw({ id: mockCurrentChat.value.id }) === chatId.value ? mockCurrentChat.value?.lmParameters?.reasoning?.effort : undefined),
    updateReasoningEffort: ({ chatId, effort }: { chatId: string, effort: 'none' | 'low' | 'medium' | 'high' | undefined }) => {
      if (mockCurrentChat.value?.id !== undefined && idToRaw({ id: mockCurrentChat.value.id }) === chatId) {
        mockCurrentChat.value = {
          ...mockCurrentChat.value,
          lmParameters: {
            ...(mockCurrentChat.value.lmParameters || EMPTY_LM_PARAMETERS),
            reasoning: { effort },
          },
        };
      }
    },
  }),
}));

vi.mock('../composables/chat/useChatModels', () => ({
  useChatModels: () => ({
    availableModels: mockAvailableModels,
    fetchingModels: computed(() => mockFetchingModels.value),
    fetchForChat: ({ chatId }: { chatId: string }) =>
      mockFetchAvailableModels({
        chatId,
        customEndpoint: undefined,
      }),
    fetchForGlobalEndpoint: vi.fn(),
    fetchForEndpoint: vi.fn(),
  }),
}));

vi.mock('../composables/chat/useChatMounts', () => ({
  useChatMounts: () => ({
    getMounts: ({ chatId }: { chatId: { value: string } }) => computed(() => {
      if (mockCurrentChat.value?.id === undefined || idToRaw({ id: mockCurrentChat.value.id }) !== chatId.value) {
        return [];
      }

      return mockCurrentChat.value?.mounts ?? [];
    }),
    addMount: vi.fn(),
    removeMount: vi.fn(),
    updateMount: vi.fn(),
  }),
}));

vi.mock('../composables/chat/useChatImageGeneration', () => ({
  useChatImageGeneration: () => ({
    availableModels: mockAvailableModels,
    isImageMode: computed(() => false),
    resolution: computed(() => ({ width: 512, height: 512 })),
    count: computed(() => 1),
    persistAs: computed(() => 'original'),
    steps: computed(() => undefined),
    seed: computed(() => 'browser_random'),
    selectedImageModel: computed(() => undefined),
    toggleImageMode: vi.fn(),
    updateResolution: vi.fn(),
    updateCount: vi.fn(),
    updatePersistAs: vi.fn(),
    updateSteps: vi.fn(),
    updateSeed: vi.fn(),
    setImageModel: vi.fn(),
    sendImageRequest: vi.fn().mockResolvedValue(true),
  }),
}));

vi.mock('../composables/useChatWeshTerminalSessions', () => ({
  buildWorkerMountsForChat: vi.fn(async ({
    chatMounts,
    chatGroupMounts,
    chatId,
    chatGroupId,
    naidanSysfsAccessScope,
  }: {
    chatMounts: Array<{ type: string, volumeId?: string, mountPath: string, readOnly: boolean }>,
    chatGroupMounts: Array<{ type: string, volumeId?: string, mountPath: string, readOnly: boolean }> | undefined,
    chatId: ChatId | undefined,
    chatGroupId: ChatGroupId | undefined,
    naidanSysfsAccessScope: string,
  }) => {
    const mounts: WeshMount[] = [];

    if (chatId !== undefined && mockSettings.value.storageType === 'opfs') {
      mounts.push({ type: 'directory', path: '/tmp', handle: mockTmpHandle, readOnly: false });
    }

    if (naidanSysfsAccessScope !== 'none' && chatId !== undefined) {
      mounts.push({
        type: 'naidan_sysfs',
        path: '/sys/fs/naidan',
        readOnly: true,
        storageType: mockSettings.value.storageType,
        visibility: naidanSysfsAccessScope as 'current_chat_only' | 'current_chat_with_chat_group' | 'main_chats',
        binaryObjectAccess: 'data',
        currentChatId: chatId,
        currentChatGroupId: chatGroupId,
      });
    }

    for (const mount of mockSettings.value.mounts ?? []) {
      if (mount.type !== 'volume') continue;
      const handle = await mockGetVolumeDirectoryHandle({ volumeId: mount.volumeId });
      if (handle !== undefined) {
        mounts.push({ type: 'directory', path: mount.mountPath, handle, readOnly: mount.readOnly });
      }
    }

    for (const mount of chatGroupMounts ?? []) {
      if (mount.type !== 'volume') continue;
      const handle = await mockGetVolumeDirectoryHandle({ volumeId: mount.volumeId! });
      if (handle !== undefined) {
        mounts.push({ type: 'directory', path: mount.mountPath, handle, readOnly: mount.readOnly });
      }
    }

    for (const mount of chatMounts ?? []) {
      if (mount.type !== 'volume') continue;
      const handle = await mockGetVolumeDirectoryHandle({ volumeId: mount.volumeId! });
      if (handle !== undefined) {
        mounts.push({ type: 'directory', path: mount.mountPath, handle, readOnly: mount.readOnly });
      }
    }

    return mounts;
  }),
  useChatWeshTerminalSessions: vi.fn(() => ({
    createChatWorkerSession: vi.fn(),
    ensureActiveSession: vi.fn(),
    reopenSessionIfNeeded: vi.fn(),
    closeSession: vi.fn(),
    closeAllSessions: vi.fn(),
    sessions: ref([]),
    activeSessionId: ref(undefined),
  })),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: mockSettings,
    availableModels: mockAvailableModels,
    isFetchingModels: mockFetchingModels,
    fetchModels: mockFetchAvailableModels,
    save: mockSaveSettings,
    setFakeLmDebugModeStatus: mockSetFakeLmDebugModeStatus,
  }),
}));

// Mock Mermaid to avoid "document is not defined" errors during tests
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg></svg>' }),
  },
}));




const { mockAddToast, mockFakeLmDebugModeAvailability, mockGenerateChatShareURL, mockSetFakeLmDebugModeStatus } = vi.hoisted(() => ({
  mockAddToast: vi.fn(),
  mockFakeLmDebugModeAvailability: { value: 'available' },
  mockGenerateChatShareURL: vi.fn(),
  mockSetFakeLmDebugModeStatus: vi.fn(),
}));

vi.mock('../composables/useToast', () => ({
  useToast: () => ({
    addToast: mockAddToast,
  }),
}));

vi.mock('../services/import-export/chat-url-share', () => ({
  generateChatShareURL: mockGenerateChatShareURL,
}));


vi.mock('@/services/fake-lm', () => ({
  FAKE_LM_ENDPOINT_URL: 'https://fake-lm.invalid',
  useFakeLmDebugMode: () => ({
    fakeLmDebugModeAvailability: mockFakeLmDebugModeAvailability,
  }),
}));

vi.mock('../composables/useFileExplorerModal', () => ({
  useFileExplorerModal: () => ({
    openFileExplorer: mockOpenFileExplorer,
  }),
}));

vi.mock('../services/storage', () => ({
  storageService: {
    getVolumeDirectoryHandle: mockGetVolumeDirectoryHandle,
    getFile: vi.fn().mockResolvedValue(new Blob([])),
    subscribeToChanges: vi.fn(),
  },
}));

vi.mock('../composables/useChatWeshPreferences', () => ({
  useChatWeshPreferences: () => ({
    getNaidanSysfsAccessScope: mockGetNaidanSysfsAccessScope,
  }),
}));

// Mock navigator.clipboard
Object.defineProperty(navigator, 'clipboard', {
  value: {
    writeText: vi.fn().mockResolvedValue(undefined),
  },
  configurable: true,
});

let wrapper: VueWrapper<any> | null = null;

function resetMocks() {
  const { clearAllDrafts } = useChatDraft();
  clearAllDrafts();
  vi.useRealTimers();
  vi.clearAllMocks();
  mockRenameChat.mockImplementation(({ newTitle }) => {
    if (mockCurrentChat.value) {
      mockCurrentChat.value.title = newTitle;
    }
  });
  mockUpdateChatSettings.mockImplementation(({ id, updates }) => {
    if (mockCurrentChat.value && mockCurrentChat.value.id === id) {
      Object.assign(mockCurrentChat.value, updates);
    }
  });
  mockUpdateChatGroupMetadata.mockImplementation(({ id, updates }) => {
    if (mockCurrentChatGroup.value && mockCurrentChatGroup.value.id === id) {
      Object.assign(mockCurrentChatGroup.value, updates);
    }
  });
  mockUpdateChatModel.mockImplementation(({ id, modelId }) => {
    if (mockCurrentChat.value && mockCurrentChat.value.id === id) {
      mockCurrentChat.value = {
        ...mockCurrentChat.value,
        modelId,
      };
    }
    if (mockResolvedSettings.value) {
      mockResolvedSettings.value = {
        ...mockResolvedSettings.value,
        modelId,
        sources: {
          ...mockResolvedSettings.value.sources,
          modelId: 'chat',
        },
      };
    }
  });
  mockFakeLmDebugModeAvailability.value = 'available';
  mockStreaming.value = false;
  mockGeneratingTitle.value = false;
  mockActiveGenerations.clear();
  mockActiveMessages.value = [];
  mockChatFlowOverride.value = null;
  mockChatGroups.value = [];
  mockCurrentChatGroup.value = null;
  mockAvailableModels.value = ['model-1', 'model-2'];
  mockFetchingModels.value = false;
  mockContextCompactProgress.value = { phase: 'idle' };
  mockResolvedSettings.value = {
    endpoint: { type: 'openai', url: 'http://localhost' },
    modelId: 'global-default-model',
    titleModelId: undefined,
    sources: { modelId: 'global', titleModelId: 'global' },
  };
  mockInheritedSettings.value = {
    endpoint: { type: 'openai', url: 'http://localhost' },
    modelId: 'global-default-model',
    sources: { modelId: 'global' },
  };
  mockCurrentChat.value = {
    id: toChatId({ raw: '1' }),
    title: 'Test Chat',
    root: { items: [] },
    currentLeafId: undefined,
    debugEnabled: false,
    originChatId: undefined,
    modelId: undefined,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  mockSettings.value = {
    endpoint: { type: 'openai', url: 'http://localhost' },
    defaultModelId: 'global-default-model',
    storageType: 'opfs',
    mounts: [],
  };
  mockEnsureChatTmpDirectory.mockResolvedValue({
    mountPath: '/tmp',
    handle: mockTmpHandle,
  });
  mockCompactCurrentBranch.mockResolvedValue(true);
  mockGetNaidanSysfsAccessScope.mockReturnValue('current_chat_with_chat_group');
  mockOpenFileExplorer.mockReset();
  mockGetVolumeDirectoryHandle.mockImplementation(({ volumeId }: { volumeId: string }) => {
    return Promise.resolve({ kind: 'directory', name: volumeId } as FileSystemDirectoryHandle);
  });
}

describe('ChatPane UI States', () => {
  beforeEach(() => {
    resetMocks();
    document.body.innerHTML = '<div id="app"></div>';
    setupScrollToMock();
  });

  afterEach(() => {
    if (wrapper) {
      wrapper.unmount();
      wrapper = null;
    }
    document.body.innerHTML = '';
  });

  it('should keep the input textarea enabled during streaming', async () => {
    mockStreaming.value = true;
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    const textarea = wrapper.find('[data-testid="chat-input"]');
    expect((textarea.element as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('shows the current chat group beside the model badge when the chat belongs to a group', () => {
    mockChatGroups.value = [
      {
        id: 'group-1',
        name: 'Research Notes',
        items: [],
        isCollapsed: false,
        updatedAt: Date.now(),
      },
    ];
    mockCurrentChat.value = {
      ...mockCurrentChat.value!,
      groupId: toChatGroupId({ raw: 'group-1' }),
    };

    wrapper = mountChatPane( {
      attachTo: document.body,
      global: { plugins: [router] },
    });

    const badge = wrapper.find('[data-testid="chat-group-badge"]');
    expect(badge.exists()).toBe(true);
    expect(badge.text()).toContain('Research Notes');
    expect(badge.attributes('title')).toBe('Group: Research Notes');
  });

  it('hides the chat group badge when the chat is not in a group', () => {
    mockChatGroups.value = [
      {
        id: 'group-1',
        name: 'Research Notes',
        items: [],
        isCollapsed: false,
        updatedAt: Date.now(),
      },
    ];
    mockCurrentChat.value = {
      ...mockCurrentChat.value!,
      groupId: null,
    };

    wrapper = mountChatPane( {
      attachTo: document.body,
      global: { plugins: [router] },
    });

    expect(wrapper.find('[data-testid="chat-group-badge"]').exists()).toBe(false);
  });

  it('opens compact context settings from the header more actions menu', async () => {
    mockActiveMessages.value = Array.from({ length: 7 }, (_, index) => ({
      id: toMessageId({ raw: `message-${index + 1}` }),
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${index + 1}`,
      timestamp: index + 1,
      replies: { items: [] },
    })) as MessageNode[];

    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    await wrapper.find('[data-testid="more-actions-button"]').trigger('click');
    await wrapper.find('[data-testid="compact-context-button"]').trigger('click');

    expect(wrapper.findComponent({ name: 'ContextCompactSettingsDialog' }).exists()).toBe(true);
    expect(mockCompactCurrentBranch).not.toHaveBeenCalled();
  });

  it('runs compact context after confirming the settings dialog', async () => {
    mockActiveMessages.value = Array.from({ length: 9 }, (_, index) => ({
      id: toMessageId({ raw: `message-${index + 1}` }),
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${index + 1}`,
      timestamp: index + 1,
      replies: { items: [] },
    })) as MessageNode[];

    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    await wrapper.find('[data-testid="more-actions-button"]').trigger('click');
    await wrapper.find('[data-testid="compact-context-button"]').trigger('click');
    await wrapper.findComponent({ name: 'ContextCompactSettingsDialog' }).vm.$emit('confirm', {
      keepCount: 6,
      instruction: 'Edited compact prompt',
    });

    expect(mockCompactCurrentBranch).toHaveBeenCalledWith({
      chatId: toChatId({ raw: '1' }),
      keepRecentMessages: 6,
      instructionOverride: 'Edited compact prompt',
    });
  });

  it('renders the compact progress strip while compacting', () => {
    mockContextCompactProgress.value = {
      phase: 'requesting_model',
      compactedMessageCount: 4,
      suffixMessageCount: 6,
      requestPreview: `\
[user]
Question`,
    };

    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    expect(wrapper.find('[data-testid="context-compact-progress-strip"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="context-compact-progress-overlay"]').classes()).toContain('absolute');
  });

  it('shows the neural sync effect only after a successful compact action', async () => {
    vi.useFakeTimers();
    try {
      mockActiveMessages.value = Array.from({ length: 9 }, (_, index) => ({
        id: toMessageId({ raw: `message-${index + 1}` }),
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${index + 1}`,
        timestamp: index + 1,
        replies: { items: [] },
      })) as MessageNode[];
      wrapper = mountChatPane( {
        global: { plugins: [router] },
      });

      await wrapper.find('[data-testid="more-actions-button"]').trigger('click');
      await wrapper.find('[data-testid="compact-context-button"]').trigger('click');
      await wrapper.findComponent({ name: 'ContextCompactSettingsDialog' }).vm.$emit('confirm', {
        keepCount: 6,
        instruction: 'Edited compact prompt',
      });
      await flushPromises();

      expect(wrapper.find('[data-testid="context-compact-neural-sync-effect"]').exists()).toBe(true);

      await vi.advanceTimersByTimeAsync(1200);
      await nextTick();

      expect(wrapper.find('[data-testid="context-compact-neural-sync-effect"]').exists()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not show the neural sync effect when compact progress becomes complete without a local compact action', async () => {
    vi.useFakeTimers();
    try {
      wrapper = mountChatPane( {
        global: { plugins: [router] },
      });

      mockContextCompactProgress.value = {
        phase: 'complete',
        requestPreview: undefined,
        outputPreview: '# Compact Context',
      };
      await nextTick();

      expect(wrapper.find('[data-testid="context-compact-neural-sync-effect"]').exists()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the neural sync effect when chatId changes', async () => {
    vi.useFakeTimers();
    try {
      mockActiveMessages.value = Array.from({ length: 9 }, (_, index) => ({
        id: toMessageId({ raw: `message-${index + 1}` }),
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${index + 1}`,
        timestamp: index + 1,
        replies: { items: [] },
      })) as MessageNode[];

      wrapper = mountChatPane( {
        global: { plugins: [router] },
      });

      await wrapper.find('[data-testid="more-actions-button"]').trigger('click');
      await wrapper.find('[data-testid="compact-context-button"]').trigger('click');
      await wrapper.findComponent({ name: 'ContextCompactSettingsDialog' }).vm.$emit('confirm', {
        keepCount: 6,
        instruction: 'Edited compact prompt',
      });
      await flushPromises();

      expect(wrapper.find('[data-testid="context-compact-neural-sync-effect"]').exists()).toBe(true);

      mockCurrentChat.value = {
        ...(mockCurrentChat.value as Chat),
        id: toChatId({ raw: 'chat-2' }),
        title: 'Chat 2',
      };
      await wrapper.setProps({
        chatId: toChatId({ raw: 'chat-2' }),
      });

      expect(wrapper.find('[data-testid="context-compact-neural-sync-effect"]').exists()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should show the abort button and hide the send button during streaming', async () => {
    mockStreaming.value = true;
    if (mockCurrentChat.value) {
      mockActiveGenerations.set(mockCurrentChat.value.id, { controller: new AbortController(), chat: mockCurrentChat.value });
    }
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    const abortBtn = wrapper.find('[data-testid="abort-button"]');
    expect(abortBtn.exists()).toBe(true);
    expect(abortBtn.text()).toContain('Esc');
    expect(wrapper.find('[data-testid="send-button"]').exists()).toBe(false);
  });

  it('should display the shortcut text with correct casing (not all uppercase)', () => {
    wrapper = mountChatPane( {
      global: {
        plugins: [router],
        stubs: {
          'router-link': true,
          'Logo': true,
          'MessageItem': true,
          'WelcomeScreen': true,
          'ChatSettingsPanel': true,
        },
      },
    });
    const sendBtn = wrapper.find('[data-testid="send-button"]');
    const shortcutText = sendBtn.text();

    // Check for "Enter" with capital E and lowercase nter,
    // ensuring "uppercase" class isn't transforming it.
    expect(shortcutText).toContain('Enter');
    expect(shortcutText).not.toContain('ENTER');
  });

  it('should display the model name with correct casing (not forced to uppercase)', async () => {
    // Set a specifically lowercase model name in settings to test for uppercase transformation
    const testModelName = 'gemma3:1b-lowercase';
    if (mockCurrentChat.value) mockCurrentChat.value.modelId = testModelName;

    wrapper = mountChatPane( {
      global: {
        plugins: [router],
        stubs: {
          'router-link': true,
          'Logo': true,
          'MessageItem': true,
          'WelcomeScreen': true,
          'ChatSettingsPanel': true,
        },
      },
    });

    await nextTick();

    const headerText = wrapper.text();
    expect(headerText).toContain(testModelName);
    // Explicitly check that it's NOT transformed to uppercase
    expect(headerText).not.toContain(testModelName.toUpperCase());
  });

  it('should call abortChat when Esc is pressed during streaming', async () => {
    mockStreaming.value = true;
    if (mockCurrentChat.value) {
      mockActiveGenerations.set(mockCurrentChat.value.id, { controller: new AbortController(), chat: mockCurrentChat.value });
    }
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    const textarea = wrapper.find('[data-testid="chat-input"]');
    await textarea.trigger('keydown.esc');
    expect(mockAbortChat).toHaveBeenCalled();
  });

  it('should call abortChat when the abort button in MessageItem is clicked', async () => {
    mockStreaming.value = true;
    const assistantMsgId = 'msg-2';
    if (mockCurrentChat.value) {
      mockCurrentChat.value.currentLeafId = toMessageId({ raw: assistantMsgId });
      mockActiveGenerations.set(mockCurrentChat.value.id, { controller: new AbortController(), chat: mockCurrentChat.value });
    }
    mockActiveMessages.value = [
      { id: toMessageId({ raw: 'msg-1' }), role: 'user', content: 'hello', timestamp: 0, replies: { items: [] } },
      { id: toMessageId({ raw: assistantMsgId }), role: 'assistant', content: 'generating...', timestamp: 0, replies: { items: [] } },
    ];

    wrapper = mountChatPane( {
      global: {
        plugins: [router],
        stubs: {
          // We need MessageItem to NOT be stubbed or to emit the event if stubbed
          MessageItem: false,
        },
      },
    });

    await nextTick();

    const abortBtn = wrapper.find('[data-testid="message-abort-button"]');
    expect(abortBtn.exists()).toBe(true);

    await abortBtn.trigger('click');
    expect(mockAbortChat).toHaveBeenCalled();
  });

  it('should show the send button with shortcut text when not streaming', async () => {
    mockStreaming.value = false;
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    const sendBtn = wrapper.find('[data-testid="send-button"]');
    expect(sendBtn.exists()).toBe(true);
    // Shortcut text depends on OS, but should contain either 'Enter' or 'Cmd'/'Ctrl'
    expect(sendBtn.text()).toMatch(/(Enter|Cmd|Ctrl)/);
  });

  it('should show the chat inspector when debug mode is enabled', async () => {
    if (mockCurrentChat.value) mockCurrentChat.value.debugEnabled = true;
    wrapper = mountChatPane( {
      global: {
        plugins: [router],
        stubs: {
          ChatDebugInspector: {
            template: '<div data-testid="chat-inspector">Chat Inspector</div>',
          },
        },
      },
    });
    await flushPromises();

    const inspector = wrapper.find('[data-testid="chat-inspector"]');
    expect(inspector.exists()).toBe(true);
    expect(inspector.text()).toContain('Chat Inspector');
  });

  it('should configure the current chat for fake LM from the inspector shortcut', async () => {
    if (mockCurrentChat.value) {
      mockCurrentChat.value.debugEnabled = true;
      mockCurrentChat.value.endpoint = { type: 'openai', url: 'https://example.com' };
    }

    wrapper = mountChatPane({
      global: {
        plugins: [router],
      },
    });
    await flushPromises();

    await wrapper.find('[data-testid="chat-inspector-enable-fake-lm"]').trigger('click');
    await flushPromises();

    expect(mockSetFakeLmDebugModeStatus).toHaveBeenCalledWith({ status: 'enabled' });
    expect(mockUpdateChatScopedSettings).toHaveBeenCalledWith({
      chatId: toChatId({ raw: '1' }),
      changes: [{
        field: 'endpoint',
        behavior: 'override',
        value: {
          type: 'ollama',
          url: 'https://fake-lm.invalid',
        },
      }],
    });
    expect(mockCurrentChat.value?.endpoint).toEqual({
      type: 'ollama',
      url: 'https://fake-lm.invalid',
    });
    expect(mockAddToast).toHaveBeenCalledWith({
      message: 'Fake LM enabled for this chat via https://fake-lm.invalid',
      duration: 3000,
    });
  });

  it('should not configure fake LM from the inspector shortcut when the facade is unavailable', async () => {
    mockFakeLmDebugModeAvailability.value = 'unavailable_in_standalone';
    if (mockCurrentChat.value) {
      mockCurrentChat.value.debugEnabled = true;
      mockCurrentChat.value.endpoint = { type: 'openai', url: 'https://example.com' };
    }

    wrapper = mountChatPane({
      global: {
        plugins: [router],
      },
    });
    await flushPromises();

    await wrapper.find('[data-testid="chat-inspector-enable-fake-lm"]').trigger('click');
    await flushPromises();

    expect(mockSetFakeLmDebugModeStatus).not.toHaveBeenCalled();
    expect(mockUpdateChatScopedSettings).not.toHaveBeenCalled();
    expect(mockCurrentChat.value?.endpoint).toEqual({
      type: 'openai',
      url: 'https://example.com',
    });
  });

  it('should open the title dialog and save a manual title', async () => {
    vi.useFakeTimers();
    try {
      mockActiveMessages.value = [{ id: toMessageId({ raw: 'm1' }), role: 'user', content: 'test', timestamp: 0, replies: { items: [] } }];
      wrapper = mountChatPane( {
        global: { plugins: [router] },
      });

      expect(wrapper.find('[data-testid="regenerate-title-button"]').exists()).toBe(false);

      await wrapper.find('[data-testid="edit-title-button"]').trigger('click');
      await flushPromises();
      expect(wrapper.find('[data-testid="chat-title-dialog"]').exists()).toBe(true);

      await wrapper.find('[data-testid="chat-title-input"]').setValue('Manual Title');
      await vi.advanceTimersByTimeAsync(600);
      await flushPromises();

      expect(mockRenameChat).toHaveBeenCalledWith({ id: toChatId({ raw: '1' }), newTitle: 'Manual Title' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('should generate a title from the title dialog using the selected global title model', async () => {
    mockActiveMessages.value = [{ id: toMessageId({ raw: 'm1' }), role: 'user', content: 'test', timestamp: 0, replies: { items: [] } }];
    mockGenerateChatTitle.mockResolvedValue('Generated Title');
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    await wrapper.find('[data-testid="edit-title-button"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-testid="title-options-toggle"]').trigger('click');
    await flushPromises();
    await wrapper.findComponent({ name: 'ModelSelector' }).vm.$emit('update:modelValue', 'model-2');
    await wrapper.find('[data-testid="generate-chat-title-button"]').trigger('click');

    expect(mockSaveSettings).toHaveBeenCalledWith({
      patch: { titleModelId: 'model-2' },
      modelRefresh: 'await',
    });
    expect(mockGenerateChatTitle).toHaveBeenCalledWith({ chatId: toChatId({ raw: '1' }), signal: undefined, titleModelIdOverride: 'model-2' });
  });

  it('should keep title model and generated title history hidden until options are opened', async () => {
    mockActiveMessages.value = [{ id: toMessageId({ raw: 'm1' }), role: 'user', content: 'test', timestamp: 0, replies: { items: [] } }];
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    await wrapper.find('[data-testid="edit-title-button"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="chat-title-model-select"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Generated in this dialog');

    await wrapper.find('[data-testid="title-options-toggle"]').trigger('click');

    expect(wrapper.find('[data-testid="chat-title-model-select"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('Generated in this dialog');
  });

  it('should show Stop and the title scan animation while title generation is running', async () => {
    mockActiveMessages.value = [{ id: toMessageId({ raw: 'm1' }), role: 'user', content: 'test', timestamp: 0, replies: { items: [] } }];
    mockGeneratingTitle.value = true;
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    await wrapper.find('[data-testid="edit-title-button"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="generate-chat-title-button"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="abort-title-generation-button"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="title-magic-scan"]').exists()).toBe(true);
  });

  it('should preserve the previous title in dialog history when generation replaces it', async () => {
    mockActiveMessages.value = [{ id: toMessageId({ raw: 'm1' }), role: 'user', content: 'test', timestamp: 0, replies: { items: [] } }];
    mockGenerateChatTitle.mockImplementation(async () => {
      if (mockCurrentChat.value) mockCurrentChat.value.title = 'Generated Title';
      return 'Generated Title';
    });
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    await wrapper.find('[data-testid="edit-title-button"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-testid="generate-chat-title-button"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-testid="title-options-toggle"]').trigger('click');

    const historyOptions = wrapper.findAll('[data-testid="generated-title-option"]').map(option => option.text());
    expect(historyOptions).toContain('Generated Title');
    expect(historyOptions).toContain('Test Chat');
  });

  it('should keep generating the title in the background after the dialog is closed', async () => {
    mockActiveMessages.value = [{ id: toMessageId({ raw: 'm1' }), role: 'user', content: 'test', timestamp: 0, replies: { items: [] } }];
    let resolveTitleGeneration: ((title: string) => void) | undefined;
    mockGenerateChatTitle.mockImplementation(async () => new Promise<string>((resolve) => {
      resolveTitleGeneration = (title) => {
        if (mockCurrentChat.value) mockCurrentChat.value.title = title;
        resolve(title);
      };
    }));
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    await wrapper.find('[data-testid="edit-title-button"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-testid="generate-chat-title-button"]').trigger('click');
    await wrapper.find('[data-testid="chat-title-dialog-close"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="chat-title-dialog"]').exists()).toBe(false);
    expect(mockAbortTitleGeneration).not.toHaveBeenCalled();

    resolveTitleGeneration?.('Background Generated Title');
    await flushPromises();

    expect(wrapper.find('[data-testid="chat-header-title"]').text()).toContain('Background Generated Title');
  });

  it('should apply a generated history title to the input and save it when Use is clicked', async () => {
    mockActiveMessages.value = [{ id: toMessageId({ raw: 'm1' }), role: 'user', content: 'test', timestamp: 0, replies: { items: [] } }];
    mockGenerateChatTitle.mockResolvedValue('Generated Title');
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    await wrapper.find('[data-testid="edit-title-button"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-testid="generate-chat-title-button"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-testid="title-options-toggle"]').trigger('click');
    await wrapper.find('[data-testid="use-generated-title-button"]').trigger('click');

    expect((wrapper.find('[data-testid="chat-title-input"]').element as HTMLInputElement).value).toBe('Generated Title');
    expect(mockRenameChat).toHaveBeenCalledWith({ id: toChatId({ raw: '1' }), newTitle: 'Generated Title' });
  });

  it('should update the chat title model override when the active title model source is chat', async () => {
    mockActiveMessages.value = [{ id: toMessageId({ raw: 'm1' }), role: 'user', content: 'test', timestamp: 0, replies: { items: [] } }];
    mockResolvedSettings.value = {
      endpoint: { type: 'openai', url: 'http://localhost' },
      modelId: 'global-default-model',
      titleModelId: 'model-2',
      sources: { modelId: 'global', titleModelId: 'chat' },
    };
    mockCurrentChat.value = {
      ...mockCurrentChat.value!,
      titleModelId: 'model-2',
    };
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    await wrapper.find('[data-testid="edit-title-button"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-testid="generate-chat-title-button"]').trigger('click');

    expect(mockUpdateChatScopedSettings).toHaveBeenCalledWith({
      chatId: toChatId({ raw: '1' }),
      changes: [{
        field: 'title_model_id',
        behavior: 'override',
        value: 'model-2',
      }],
    });
    expect(mockSaveSettings).not.toHaveBeenCalled();
    expect(mockUpdateChatGroupMetadata).not.toHaveBeenCalled();
  });

  it('should update the group title model override when the active title model source is group', async () => {
    mockActiveMessages.value = [{ id: toMessageId({ raw: 'm1' }), role: 'user', content: 'test', timestamp: 0, replies: { items: [] } }];
    mockResolvedSettings.value = {
      endpoint: { type: 'openai', url: 'http://localhost' },
      modelId: 'global-default-model',
      titleModelId: 'model-2',
      sources: { modelId: 'global', titleModelId: 'chat_group' },
    };
    mockCurrentChat.value = {
      ...mockCurrentChat.value!,
      groupId: toChatGroupId({ raw: 'group-1' }),
    };
    mockCurrentChatGroup.value = {
      id: 'group-1',
      name: 'Group 1',
      titleModelId: 'model-2',
    };
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    await wrapper.find('[data-testid="edit-title-button"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-testid="generate-chat-title-button"]').trigger('click');

    expect(mockUpdateChatGroupScopedSettings).toHaveBeenCalledWith({
      chatGroupId: 'group-1',
      changes: [{
        field: 'title_model_id',
        behavior: 'override',
        value: 'model-2',
      }],
    });
    expect(mockSaveSettings).not.toHaveBeenCalled();
    expect(mockUpdateChatScopedSettings).not.toHaveBeenCalled();
  });

  it('should abort title generation from the title dialog', async () => {
    mockActiveMessages.value = [{ id: toMessageId({ raw: 'm1' }), role: 'user', content: 'test', timestamp: 0, replies: { items: [] } }];
    mockGeneratingTitle.value = true;
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    await wrapper.find('[data-testid="edit-title-button"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-testid="abort-title-generation-button"]').trigger('click');

    expect(mockAbortTitleGeneration).toHaveBeenCalledWith({ chatId: toChatId({ raw: '1' }) });
  });

  it('should open a conversation outline and jump to a selected message', async () => {
    mockActiveMessages.value = [
      { id: toMessageId({ raw: 'u1' }), role: 'user', content: 'First long user message to revisit later', timestamp: 0, replies: { items: [] } },
      { id: toMessageId({ raw: 'a1' }), role: 'assistant', content: 'Assistant response with useful details', timestamp: 0, replies: { items: [] } },
    ];
    wrapper = mountChatPane( {
      global: { plugins: [router] },
      attachTo: document.body,
    });
    await nextTick();

    const outlineButton = wrapper.find('[data-testid="conversation-outline-button"]');
    expect(outlineButton.exists()).toBe(true);
    await outlineButton.trigger('click');
    await flushPromises();

    const panel = wrapper.find('[data-testid="conversation-outline-panel"]');
    expect(panel.exists()).toBe(true);
    expect(panel.text()).toContain('First long user message');
    expect(panel.text()).toContain('Assistant response');

    const items = wrapper.findAll('[data-testid="conversation-outline-jump-button"]');
    expect(items).toHaveLength(2);
    await items[1]!.trigger('click');
    await nextTick();

    expect(wrapper.find('[data-testid="conversation-outline-panel"]').exists()).toBe(false);
  });

  it('should expose Super Edit from the more actions menu', async () => {
    mockActiveMessages.value = [{ id: toMessageId({ raw: 'm1' }), role: 'user', content: 'test', timestamp: 0, replies: { items: [] } }];
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    await wrapper.find('[data-testid="more-actions-button"]').trigger('click');
    const superEditButton = wrapper.find('[data-testid="super-edit-button"]');

    expect(superEditButton.exists()).toBe(true);
    expect(superEditButton.text()).toContain('Super Edit');
  });

  it('should open file explorer from the more actions menu with terminal-equivalent mounts', async () => {
    const globalHandle = { kind: 'directory', name: 'global-vol' } as FileSystemDirectoryHandle;
    const chatGroupHandle = { kind: 'directory', name: 'group-vol' } as FileSystemDirectoryHandle;
    const chatHandle = { kind: 'directory', name: 'chat-vol' } as FileSystemDirectoryHandle;

    mockSettings.value = {
      ...mockSettings.value,
      storageType: 'opfs',
      mounts: [
        { type: 'volume', volumeId: toVolumeId({ raw: 'global-vol' }), mountPath: '/home/user/global', readOnly: true },
      ],
    };
    mockCurrentChat.value = {
      ...(mockCurrentChat.value as Chat),
      id: toChatId({ raw: 'chat-1' }),
      groupId: toChatGroupId({ raw: 'group-1' }),
      mounts: [
        { type: 'volume', volumeId: toVolumeId({ raw: 'chat-vol' }), mountPath: '/home/user/chat', readOnly: false },
      ],
    } as Chat;
    mockCurrentChatGroup.value = {
      id: toChatGroupId({ raw: 'group-1' }),
      name: 'Research',
      mounts: [
        { type: 'volume', volumeId: toVolumeId({ raw: 'group-vol' }), mountPath: '/home/user/group', readOnly: true },
      ],
      items: [],
      isCollapsed: false,
      updatedAt: Date.now(),
    };
    mockGetVolumeDirectoryHandle.mockImplementation(({ volumeId }: { volumeId: string }) => {
      switch (volumeId) {
      case 'global-vol':
        return Promise.resolve(globalHandle);
      case 'group-vol':
        return Promise.resolve(chatGroupHandle);
      case 'chat-vol':
        return Promise.resolve(chatHandle);
      default:
        return Promise.resolve(undefined);
      }
    });

    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    await wrapper.find('[data-testid="more-actions-button"]').trigger('click');
    await wrapper.find('[data-testid="open-chat-file-explorer-button"]').trigger('click');
    await flushPromises();

    expect(mockOpenFileExplorer).toHaveBeenCalledTimes(1);
    const [{ options }] = mockOpenFileExplorer.mock.calls[0] as [{ options: {
      kind: string,
      title: string,
      rootName: string,
      mounts: WeshMount[],
      initialPath: string[] | undefined,
    }, }];
    expect(options.kind).toBe('wesh-mounts');
    expect(options.title).toBe('Files');
    expect(options.rootName).toBe('Files');
    expect(options.initialPath).toBe(undefined);
    expect(options.mounts).toEqual([
      { type: 'directory', path: '/tmp', handle: mockTmpHandle, readOnly: false },
      {
        type: 'naidan_sysfs',
        path: '/sys/fs/naidan',
        readOnly: true,
        storageType: 'opfs',
        visibility: 'current_chat_with_chat_group',
        binaryObjectAccess: 'data',
        currentChatId: 'chat-1',
        currentChatGroupId: 'group-1',
      },
      { type: 'directory', path: '/home/user/global', handle: globalHandle, readOnly: true },
      { type: 'directory', path: '/home/user/group', handle: chatGroupHandle, readOnly: true },
      { type: 'directory', path: '/home/user/chat', handle: chatHandle, readOnly: false },
    ]);
  });

  it('should omit naidan sysfs from header file explorer when the shared access scope is none', async () => {
    mockGetNaidanSysfsAccessScope.mockReturnValue('none');
    mockCurrentChat.value = {
      id: toChatId({ raw: 'chat-1' }),
      title: 'Test Chat',
      groupId: toChatGroupId({ raw: 'group-1' }),
      root: { items: [] },
      debugEnabled: false,
      lmParameters: EMPTY_LM_PARAMETERS,
      mounts: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    await wrapper.find('[data-testid="more-actions-button"]').trigger('click');
    await wrapper.find('[data-testid="open-chat-file-explorer-button"]').trigger('click');
    await flushPromises();

    const [{ options }] = mockOpenFileExplorer.mock.calls[0] as [{ options: { mounts: WeshMount[] } }];
    expect(options.mounts.some(mount => mount.type === 'naidan_sysfs')).toBe(false);
  });

  it('should pass the shared naidan sysfs access scope to the header wesh terminal', async () => {
    mockGetNaidanSysfsAccessScope.mockReturnValue('current_chat_only');
    wrapper = mountChatPane( {
      global: {
        plugins: [router],
        stubs: {
          ChatWeshTerminalModal: {
            name: 'ChatWeshTerminalModal',
            props: ['naidanSysfsAccessScope'],
            template: '<div data-testid="stub-chat-wesh-terminal" :data-access-scope="naidanSysfsAccessScope"></div>',
          },
        },
      },
    });

    expect(wrapper.find('[data-testid="stub-chat-wesh-terminal"]').attributes('data-access-scope')).toBe('current_chat_only');
  });

  it('should hide the chat inspector when debug mode is disabled', async () => {
    if (mockCurrentChat.value) mockCurrentChat.value.debugEnabled = false;
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    expect(wrapper.find('[data-testid="chat-inspector"]').exists()).toBe(false);
  });

  it('should render header icons (Settings, Outline, More)', async () => {
    mockActiveMessages.value = [{ id: toMessageId({ raw: 'm1' }), role: 'user', content: 'test', timestamp: 0, replies: { items: [] } }];
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    expect(wrapper.find('[data-testid="conversation-outline-button"]').exists()).toBe(true);
    expect(wrapper.find('button[title="Chat Settings & Model Override"]').exists()).toBe(true);
    expect(wrapper.find('button[title="More Actions"]').exists()).toBe(true);
  });

  it('should show jump to origin button when originChatId is present', async () => {
    if (mockCurrentChat.value) mockCurrentChat.value.originChatId = toChatId({ raw: 'original-id' });
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    expect(wrapper.find('button[title="Jump to original chat"]').exists()).toBe(true);
  });

  it('should show move to group menu and call moveChatToGroup when a group is selected', async () => {
    mockChatGroups.value = [{ id: 'group-1', name: 'Group 1' }];
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    const btn = wrapper.find('[data-testid="move-to-group-button"]');
    expect(btn.exists()).toBe(true);

    // Open menu
    await btn.trigger('click');
    expect(wrapper.text()).toContain('Move to Group');
    expect(wrapper.text()).toContain('Group 1');
    expect(wrapper.text()).toContain('Top Level');

    // Select group
    const groupBtn = wrapper.findAll('button').find(b => b.text().includes('Group 1'));
    await groupBtn?.trigger('click');

    expect(mockMoveChatToGroup).toHaveBeenCalledWith({ chatId: toChatId({ raw: '1' }), targetGroupId: 'group-1' });
  });

  describe('Custom Overrides Indicator', () => {
    it('shows indicator when endpoint is overridden', async () => {
      mockCurrentChat.value = reactive({
        id: 'c1', title: 'T', root: { items: [] },
        endpoint: { type: 'ollama', url: 'http://localhost:11434' },
        currentLeafId: undefined, debugEnabled: false, originChatId: undefined,
        modelId: undefined, createdAt: 0, updatedAt: 0,
      }) as any;
      wrapper = mountChatPane( { global: { plugins: [router] } });
      expect(wrapper.find('[data-testid="custom-overrides-indicator"]').exists()).toBe(true);
    });

    it('shows indicator when systemPrompt is overridden', async () => {
      mockCurrentChat.value = reactive({
        id: 'c1', title: 'T', root: { items: [] },
        systemPrompt: { content: 'test', behavior: 'override' },
        currentLeafId: undefined, debugEnabled: false, originChatId: undefined,
        modelId: undefined, createdAt: 0, updatedAt: 0,
      }) as any;
      wrapper = mountChatPane( { global: { plugins: [router] } });
      expect(wrapper.find('[data-testid="custom-overrides-indicator"]').exists()).toBe(true);
    });

    it('shows indicator when lmParameters are overridden', async () => {
      mockCurrentChat.value = reactive({
        id: 'c1', title: 'T', root: { items: [] },
        lmParameters: { temperature: 0.5 },
        currentLeafId: undefined, debugEnabled: false, originChatId: undefined,
        modelId: undefined, createdAt: 0, updatedAt: 0,
      }) as any;
      wrapper = mountChatPane( { global: { plugins: [router] } });
      expect(wrapper.find('[data-testid="custom-overrides-indicator"]').exists()).toBe(true);
    });

    it('does not show indicator when no overrides are present', async () => {
      mockCurrentChat.value = reactive({
        id: 'c1', title: 'T', root: { items: [] },
        currentLeafId: undefined, debugEnabled: false, originChatId: undefined,
        modelId: undefined, createdAt: 0, updatedAt: 0,
      }) as any;
      wrapper = mountChatPane( { global: { plugins: [router] } });
      expect(wrapper.find('[data-testid="custom-overrides-indicator"]').exists()).toBe(false);
    });
  });
});

describe('ChatPane Scrolling Logic', () => {
  let scrollTopSetterSpy: Mock;
  let scrollIntoViewSpy: Mock;
  let requestAnimationFrameSpy: Mock;

  beforeEach(() => {
    resetMocks();
    document.body.innerHTML = '<div id="app"></div>';
    scrollTopSetterSpy = vi.fn();
    scrollIntoViewSpy = vi.fn();
    requestAnimationFrameSpy = vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    setupScrollToMock();
    HTMLElement.prototype.scrollIntoView = scrollIntoViewSpy;
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrameSpy);
  });

  afterEach(() => {
    if (wrapper) {
      wrapper.unmount();
      wrapper = null;
    }
    document.body.innerHTML = '';
    delete (HTMLElement.prototype as any).scrollIntoView;
    delete (HTMLElement.prototype as any).scrollTo;
    vi.unstubAllGlobals();
  });

  function setupScrollMock(element: HTMLElement) {
    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: 500 });
    element.getBoundingClientRect = vi.fn().mockReturnValue({ top: 0, bottom: 500, height: 500, left: 0, right: 1000, width: 1000 });

    let internalScrollTop = 0;
    Object.defineProperty(element, 'scrollTop', {
      configurable: true,
      get: () => internalScrollTop,
      set: (val) => {
        internalScrollTop = val;
        scrollTopSetterSpy(val);
      },
    });

    // Mock querySelector to find our mocked messages
    const originalQuerySelector = element.querySelector.bind(element);
    element.querySelector = vi.fn().mockImplementation((selector: string) => {
      if (selector.startsWith('#message-') || selector.startsWith('#process-sequence-') || selector.startsWith('#tool-group-')) {
        const id = selector.replace(/^#(?:message|process-sequence|tool-group)-/, '');
        const mockEl = document.createElement('div');
        mockEl.id = selector.slice(1);
        const positions: Record<string, number> = {
          'u2': 250,
          'a1': 450,
          'a2': 550,
          'msg-asst': 450,
          'u1': 100,
          'user-1': 100,
          'seq-1': 350,
          'group-1': 300,
        };
        const top = positions[id] ?? 0;
        mockEl.getBoundingClientRect = vi.fn().mockImplementation(() => ({
          top: top - internalScrollTop,
          bottom: top + 100 - internalScrollTop,
          height: 100,
        }));
        return mockEl;
      }
      return originalQuerySelector(selector);
    });
  }

  it('does not scroll when a new user turn starts without an assistant-visible target yet', async () => {
    wrapper = mountChatPane( {
      attachTo: document.body,
      global: { plugins: [router] },
    });
    const container = wrapper.find('[data-testid="scroll-container"]').element as HTMLElement;
    setupScrollMock(container);

    // 1. Initial load phase
    mockActiveMessages.value = [{ id: toMessageId({ raw: 'init' }), role: 'assistant', content: 'hello', timestamp: Date.now(), replies: { items: [] } }];
    await flushPromises();
    await nextTick();
    scrollTopSetterSpy.mockClear();

    // 2. User sends message
    mockActiveMessages.value = [
      { id: toMessageId({ raw: 'init' }), role: 'assistant', content: 'hello', timestamp: Date.now(), replies: { items: [] } },
      { id: toMessageId({ raw: 'user-1' }), role: 'user', content: 'how are you?', timestamp: Date.now(), replies: { items: [] } },
    ];

    await flushPromises();
    await nextTick();
    await nextTick();

    // Should NOT scroll on user message — scrolling is deferred until the first assistant message appears
    expect(scrollTopSetterSpy).not.toHaveBeenCalled();
  });

  it('scrolls to the latest user message on initial open', async () => {
    wrapper = mountChatPane( {
      attachTo: document.body,
      global: { plugins: [router] },
    });
    const container = wrapper.find('[data-testid="scroll-container"]').element as HTMLElement;
    setupScrollMock(container);

    await flushPromises();
    await nextTick();
    await nextTick();

    scrollTopSetterSpy.mockClear();
    container.scrollTop = 0;
    scrollTopSetterSpy.mockClear();
    mockCurrentChat.value = {
      ...mockCurrentChat.value!,
      currentLeafId: toMessageId({ raw: 'leaf-open-user' }),
    };
    mockActiveMessages.value = [
      { id: toMessageId({ raw: 'u1' }), role: 'user', content: 'Hello', timestamp: Date.now(), replies: { items: [] } },
      { id: toMessageId({ raw: 'a1' }), role: 'assistant', content: 'Hi', timestamp: Date.now(), replies: { items: [] } },
      { id: toMessageId({ raw: 'u2' }), role: 'user', content: 'Last user message', timestamp: Date.now(), replies: { items: [] } },
      { id: toMessageId({ raw: 'a2' }), role: 'assistant', content: 'Final assistant message', timestamp: Date.now(), replies: { items: [] } },
    ];

    await flushPromises();
    await nextTick();
    await nextTick();
    expect(scrollTopSetterSpy).toHaveBeenCalledWith(200);
  });

  it('scrolls to and highlights the target message from a message-id link', async () => {
    mockActiveMessages.value = [
      { id: toMessageId({ raw: 'target-message' }), role: 'assistant', content: 'Target message', timestamp: Date.now(), replies: { items: [] } },
    ];
    wrapper = mountChatPane( {
      attachTo: document.body,
      global: { plugins: [router] },
    });
    const container = wrapper.find('[data-testid="scroll-container"]').element as HTMLElement;
    setupScrollMock(container);

    const targetEl = document.createElement('div');
    targetEl.id = 'message-target-message';
    targetEl.getBoundingClientRect = vi.fn().mockImplementation(() => ({ top: 250 - container.scrollTop, bottom: 350 - container.scrollTop, height: 100 }));
    container.querySelector = vi.fn().mockImplementation((selector: string) => {
      if (selector === '#message-target-message') return targetEl;
      return null;
    });

    await wrapper.setProps({ targetMessageId: toMessageId({ raw: 'target-message' }) });
    await flushPromises();
    await nextTick();

    expect(scrollTopSetterSpy).toHaveBeenCalled();
    expect(targetEl.className).toContain('bg-blue-50/50');
  });

  it('retries message-id link scrolling after the target message is rendered', async () => {
    wrapper = mountChatPane( {
      props: { targetMessageId: toMessageId({ raw: 'late-message' }) },
      attachTo: document.body,
      global: { plugins: [router] },
    });
    const container = wrapper.find('[data-testid="scroll-container"]').element as HTMLElement;
    setupScrollMock(container);

    const targetEl = document.createElement('div');
    targetEl.id = 'message-late-message';
    targetEl.getBoundingClientRect = vi.fn().mockImplementation(() => ({ top: 250 - container.scrollTop, bottom: 350 - container.scrollTop, height: 100 }));
    container.querySelector = vi.fn().mockImplementation((selector: string) => {
      if (selector === '#message-late-message') return targetEl;
      return null;
    });
    scrollTopSetterSpy.mockClear();

    mockActiveMessages.value = [
      { id: toMessageId({ raw: 'late-message' }), role: 'assistant', content: 'Late target message', timestamp: Date.now(), replies: { items: [] } },
    ];

    await flushPromises();
    await nextTick();

    expect(scrollTopSetterSpy).toHaveBeenCalled();
    expect(scrollTopSetterSpy.mock.calls.at(-1)?.[0]).toBe(50);
    expect(targetEl.className).toContain('bg-blue-50/50');
  });

  it('reserves response viewport and scrolls the new user turn to the top when an assistant placeholder appears', async () => {
    wrapper = mountChatPane( {
      attachTo: document.body,
      global: { plugins: [router] },
    });
    const container = wrapper.find('[data-testid="scroll-container"]').element as HTMLElement;
    setupScrollMock(container);

    await flushPromises();
    await nextTick();
    await nextTick();
    scrollTopSetterSpy.mockClear();
    container.scrollTop = 0;
    scrollTopSetterSpy.mockClear();
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 550 });

    const assistantId = toMessageId({ raw: 'a1' });
    mockActiveMessages.value = [
      { id: toMessageId({ raw: 'u1' }), role: 'user', content: 'hi', timestamp: Date.now(), replies: { items: [] } },
      { id: assistantId, role: 'assistant', content: '', timestamp: Date.now(), replies: { items: [] } },
    ];
    mockChatFlowOverride.value = [
      {
        type: 'message',
        node: mockActiveMessages.value[0]!,
        mode: 'content',
        flow: { position: 'standalone', nesting: 'none' },
        isFirstInNode: true,
        isLastInNode: true,
        isFirstInTurn: true,
      },
      {
        type: 'message',
        node: mockActiveMessages.value[1]!,
        mode: 'content',
        flow: { position: 'standalone', nesting: 'none' },
        isFirstInNode: true,
        isLastInNode: true,
        isFirstInTurn: true,
      },
    ];

    await flushPromises();
    await nextTick();
    await nextTick();

    expect(scrollTopSetterSpy).toHaveBeenCalledWith(100);
    const reserve = wrapper.find('[data-testid="response-viewport-reserve"]');
    expect(reserve.exists()).toBe(true);
    expect((reserve.element as HTMLElement).style.height).toBe('50px');
  });

  it('keeps the response viewport reserve stable until the next send or branch change', async () => {
    wrapper = mountChatPane( {
      attachTo: document.body,
      global: { plugins: [router] },
    });
    const container = wrapper.find('[data-testid="scroll-container"]').element as HTMLElement;
    setupScrollMock(container);

    await flushPromises();
    await nextTick();
    await nextTick();
    scrollTopSetterSpy.mockClear();
    container.scrollTop = 0;
    scrollTopSetterSpy.mockClear();
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 550 });

    const userMessage = { id: toMessageId({ raw: 'u1' }), role: 'user', content: 'hi', timestamp: Date.now(), replies: { items: [] } } as MessageNode;
    const assistantMessage = { id: toMessageId({ raw: 'a1' }), role: 'assistant', content: '', timestamp: Date.now(), replies: { items: [] } } as MessageNode;
    mockStreaming.value = true;
    mockActiveMessages.value = [userMessage, assistantMessage];
    mockChatFlowOverride.value = [
      {
        type: 'message',
        node: userMessage,
        mode: 'content',
        flow: { position: 'standalone', nesting: 'none' },
        isFirstInNode: true,
        isLastInNode: true,
        isFirstInTurn: true,
      },
      {
        type: 'message',
        node: assistantMessage,
        mode: 'content',
        flow: { position: 'standalone', nesting: 'none' },
        isFirstInNode: true,
        isLastInNode: true,
        isFirstInTurn: true,
      },
    ];

    await flushPromises();
    await nextTick();
    await nextTick();

    const reserve = wrapper.find('[data-testid="response-viewport-reserve"]');
    expect(reserve.exists()).toBe(true);
    expect((reserve.element as HTMLElement).style.height).toBe('50px');

    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 650 });
    assistantMessage.content = 'Assistant content now occupies the planned response viewport.';
    mockChatFlowOverride.value = [
      mockChatFlowOverride.value[0]!,
      {
        type: 'message',
        node: assistantMessage,
        mode: 'content',
        partContent: assistantMessage.content,
        flow: { position: 'standalone', nesting: 'none' },
        isFirstInNode: true,
        isLastInNode: true,
        isFirstInTurn: true,
      },
    ];

    await flushPromises();
    await nextTick();
    await nextTick();

    const updatedReserve = wrapper.find('[data-testid="response-viewport-reserve"]');
    expect(updatedReserve.exists()).toBe(true);
    expect((updatedReserve.element as HTMLElement).style.height).toBe('50px');

    mockStreaming.value = false;

    await flushPromises();
    await nextTick();
    await nextTick();

    const completedReserve = wrapper.find('[data-testid="response-viewport-reserve"]');
    expect(completedReserve.exists()).toBe(true);
    expect((completedReserve.element as HTMLElement).style.height).toBe('50px');

    const secondUserMessage = { id: toMessageId({ raw: 'u2' }), role: 'user', content: 'next question', timestamp: Date.now(), replies: { items: [] } } as MessageNode;
    const secondAssistantMessage = { id: toMessageId({ raw: 'a2' }), role: 'assistant', content: '', timestamp: Date.now(), replies: { items: [] } } as MessageNode;
    mockStreaming.value = true;
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 730 });
    mockActiveMessages.value = [userMessage, assistantMessage, secondUserMessage, secondAssistantMessage];
    mockChatFlowOverride.value = [
      mockChatFlowOverride.value[0]!,
      mockChatFlowOverride.value[1]!,
      {
        type: 'message',
        node: secondUserMessage,
        mode: 'content',
        flow: { position: 'standalone', nesting: 'none' },
        isFirstInNode: true,
        isLastInNode: true,
        isFirstInTurn: true,
      },
      {
        type: 'message',
        node: secondAssistantMessage,
        mode: 'content',
        flow: { position: 'standalone', nesting: 'none' },
        isFirstInNode: true,
        isLastInNode: true,
        isFirstInTurn: true,
      },
    ];

    await flushPromises();
    await nextTick();
    await nextTick();

    const nextSendReserve = wrapper.find('[data-testid="response-viewport-reserve"]');
    expect(nextSendReserve.exists()).toBe(true);
    expect((nextSendReserve.element as HTMLElement).style.height).toBe('20px');

    mockStreaming.value = false;
    mockCurrentChat.value = {
      ...mockCurrentChat.value!,
      currentLeafId: toMessageId({ raw: 'changed-branch' }),
    };

    await flushPromises();
    await nextTick();
    await nextTick();

    expect(wrapper.find('[data-testid="response-viewport-reserve"]').exists()).toBe(false);
  });

  it('does not treat a processing leaf update as an initial open', async () => {
    mockCurrentChat.value = {
      ...mockCurrentChat.value!,
      currentLeafId: toMessageId({ raw: 'old-leaf' }),
    };
    mockActiveMessages.value = [
      { id: toMessageId({ raw: 'old-user' }), role: 'user', content: 'before', timestamp: Date.now(), replies: { items: [] } },
      { id: toMessageId({ raw: 'old-assistant' }), role: 'assistant', content: 'before reply', timestamp: Date.now(), replies: { items: [] } },
    ];

    wrapper = mountChatPane( {
      attachTo: document.body,
      global: { plugins: [router] },
    });
    const container = wrapper.find('[data-testid="scroll-container"]').element as HTMLElement;
    setupScrollMock(container);

    await flushPromises();
    await nextTick();
    await nextTick();
    scrollTopSetterSpy.mockClear();
    container.scrollTop = 0;
    scrollTopSetterSpy.mockClear();
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 550 });

    mockStreaming.value = true;
    mockCurrentChat.value = {
      ...mockCurrentChat.value!,
      currentLeafId: toMessageId({ raw: 'streaming-assistant-leaf' }),
    };
    mockActiveMessages.value = [
      ...mockActiveMessages.value,
      { id: toMessageId({ raw: 'u1' }), role: 'user', content: 'hello, world', timestamp: Date.now(), replies: { items: [] } },
      { id: toMessageId({ raw: 'a1' }), role: 'assistant', content: '', timestamp: Date.now(), replies: { items: [] } },
    ];
    mockChatFlowOverride.value = [
      {
        type: 'message',
        node: mockActiveMessages.value[0]!,
        mode: 'content',
        flow: { position: 'standalone', nesting: 'none' },
        isFirstInNode: true,
        isLastInNode: true,
        isFirstInTurn: true,
      },
      {
        type: 'message',
        node: mockActiveMessages.value[1]!,
        mode: 'content',
        flow: { position: 'standalone', nesting: 'none' },
        isFirstInNode: true,
        isLastInNode: true,
        isFirstInTurn: true,
      },
      {
        type: 'message',
        node: mockActiveMessages.value[2]!,
        mode: 'content',
        flow: { position: 'standalone', nesting: 'none' },
        isFirstInNode: true,
        isLastInNode: true,
        isFirstInTurn: true,
      },
      {
        type: 'message',
        node: mockActiveMessages.value[3]!,
        mode: 'content',
        flow: { position: 'standalone', nesting: 'none' },
        isFirstInNode: true,
        isLastInNode: true,
        isFirstInTurn: true,
      },
    ];

    await flushPromises();
    await nextTick();
    await nextTick();

    expect(scrollTopSetterSpy).toHaveBeenCalledWith(100);
    expect(scrollTopSetterSpy).not.toHaveBeenCalledWith(50);
    const reserve = wrapper.find('[data-testid="response-viewport-reserve"]');
    expect(reserve.exists()).toBe(true);
    expect((reserve.element as HTMLElement).style.height).toBe('50px');
  });

  it('scrolls again after abort when a new user turn starts', async () => {
    wrapper = mountChatPane( {
      attachTo: document.body,
      global: { plugins: [router] },
    });
    const container = wrapper.find('[data-testid="scroll-container"]').element as HTMLElement;
    setupScrollMock(container);

    await flushPromises();
    await nextTick();
    await nextTick();
    scrollTopSetterSpy.mockClear();
    container.scrollTop = 0;
    scrollTopSetterSpy.mockClear();

    const firstUser = { id: toMessageId({ raw: 'u1' }), role: 'user', content: 'first', timestamp: Date.now(), replies: { items: [] } } as MessageNode;
    const abortedAssistant = { id: toMessageId({ raw: 'a1' }), role: 'assistant', content: '[Generation Aborted]', timestamp: Date.now(), replies: { items: [] } } as MessageNode;
    const retryUser = { id: toMessageId({ raw: 'u2' }), role: 'user', content: 'retry', timestamp: Date.now(), replies: { items: [] } } as MessageNode;
    const retryAssistant = { id: toMessageId({ raw: 'a2' }), role: 'assistant', content: '', timestamp: Date.now(), replies: { items: [] } } as MessageNode;

    mockActiveMessages.value = [firstUser, abortedAssistant];
    mockChatFlowOverride.value = [
      {
        type: 'message',
        node: firstUser,
        mode: 'content',
        flow: { position: 'standalone', nesting: 'none' },
        isFirstInNode: true,
        isLastInNode: true,
        isFirstInTurn: true,
      },
      {
        type: 'message',
        node: abortedAssistant,
        mode: 'content',
        flow: { position: 'standalone', nesting: 'none' },
        isFirstInNode: true,
        isLastInNode: true,
        isFirstInTurn: true,
      },
    ];

    await flushPromises();
    await nextTick();
    await nextTick();
    expect(scrollTopSetterSpy).toHaveBeenCalledWith(100);

    scrollTopSetterSpy.mockClear();
    container.scrollTop = 0;
    scrollTopSetterSpy.mockClear();
    mockActiveMessages.value = [firstUser, abortedAssistant, retryUser, retryAssistant];
    mockChatFlowOverride.value = [
      {
        type: 'message',
        node: firstUser,
        mode: 'content',
        flow: { position: 'standalone', nesting: 'none' },
        isFirstInNode: true,
        isLastInNode: true,
        isFirstInTurn: true,
      },
      {
        type: 'message',
        node: abortedAssistant,
        mode: 'content',
        flow: { position: 'standalone', nesting: 'none' },
        isFirstInNode: true,
        isLastInNode: true,
        isFirstInTurn: true,
      },
      {
        type: 'message',
        node: retryUser,
        mode: 'content',
        flow: { position: 'standalone', nesting: 'none' },
        isFirstInNode: true,
        isLastInNode: true,
        isFirstInTurn: true,
      },
      {
        type: 'message',
        node: retryAssistant,
        mode: 'content',
        flow: { position: 'standalone', nesting: 'none' },
        isFirstInNode: true,
        isLastInNode: true,
        isFirstInTurn: true,
      },
    ];

    await flushPromises();
    await nextTick();
    await nextTick();
    expect(scrollTopSetterSpy).toHaveBeenCalledWith(250);
  });

  it('only scrolls once for the same user turn', async () => {
    const userMessage = { id: toMessageId({ raw: 'u1' }), role: 'user', content: 'hi', timestamp: Date.now(), replies: { items: [] } } as MessageNode;
    const firstAssistant = { id: toMessageId({ raw: 'a1' }), role: 'assistant', content: 'first reply', timestamp: Date.now(), replies: { items: [] } } as MessageNode;
    const toolMessage = {
      id: toMessageId({ raw: 't1' }),
      role: 'tool',
      content: undefined,
      timestamp: Date.now(),
      replies: { items: [] },
      attachments: undefined,
      thinking: undefined,
      error: undefined,
      modelId: undefined,
      lmParameters: undefined,
      toolCalls: undefined,
      results: [],
    } as MessageNode;
    const secondAssistant = { id: toMessageId({ raw: 'a2' }), role: 'assistant', content: 'follow-up', timestamp: Date.now(), replies: { items: [] } } as MessageNode;

    wrapper = mountChatPane( {
      attachTo: document.body,
      global: { plugins: [router] },
    });
    const container = wrapper.find('[data-testid="scroll-container"]').element as HTMLElement;
    setupScrollMock(container);

    await flushPromises();
    await nextTick();
    await nextTick();
    scrollTopSetterSpy.mockClear();
    container.scrollTop = 0;
    scrollTopSetterSpy.mockClear();

    mockActiveMessages.value = [userMessage, firstAssistant];
    mockChatFlowOverride.value = [
      {
        type: 'message',
        node: userMessage,
        mode: 'content',
        flow: { position: 'standalone', nesting: 'none' },
        isFirstInNode: true,
        isLastInNode: true,
        isFirstInTurn: true,
      },
      {
        type: 'message',
        node: firstAssistant,
        mode: 'content',
        flow: { position: 'standalone', nesting: 'none' },
        isFirstInNode: true,
        isLastInNode: true,
        isFirstInTurn: true,
      },
    ];

    await flushPromises();
    await nextTick();
    await nextTick();

    expect(scrollTopSetterSpy).toHaveBeenCalledWith(100);

    scrollTopSetterSpy.mockClear();
    container.scrollTop = 0;
    scrollTopSetterSpy.mockClear();
    mockChatFlowOverride.value = [
      {
        type: 'message',
        node: userMessage,
        mode: 'content',
        flow: { position: 'standalone', nesting: 'none' },
        isFirstInNode: true,
        isLastInNode: true,
        isFirstInTurn: true,
      },
      {
        type: 'message',
        node: firstAssistant,
        mode: 'content',
        flow: { position: 'standalone', nesting: 'none' },
        isFirstInNode: true,
        isLastInNode: true,
        isFirstInTurn: true,
      },
      {
        type: 'message',
        node: toolMessage,
        mode: 'content',
        flow: { position: 'standalone', nesting: 'none' },
        isFirstInNode: true,
        isLastInNode: true,
        isFirstInTurn: false,
      },
    ];

    await flushPromises();
    await nextTick();
    await nextTick();

    expect(scrollTopSetterSpy).not.toHaveBeenCalled();

    mockChatFlowOverride.value = [
      {
        type: 'message',
        node: userMessage,
        mode: 'content',
        flow: { position: 'standalone', nesting: 'none' },
        isFirstInNode: true,
        isLastInNode: true,
        isFirstInTurn: true,
      },
      {
        type: 'message',
        node: firstAssistant,
        mode: 'content',
        flow: { position: 'standalone', nesting: 'none' },
        isFirstInNode: true,
        isLastInNode: true,
        isFirstInTurn: true,
      },
      {
        type: 'message',
        node: toolMessage,
        mode: 'content',
        flow: { position: 'standalone', nesting: 'none' },
        isFirstInNode: true,
        isLastInNode: true,
        isFirstInTurn: false,
      },
      {
        type: 'message',
        node: secondAssistant,
        mode: 'content',
        flow: { position: 'standalone', nesting: 'none' },
        isFirstInNode: true,
        isLastInNode: true,
        isFirstInTurn: false,
      },
    ];

    await flushPromises();
    await nextTick();
    await nextTick();

    expect(scrollTopSetterSpy).not.toHaveBeenCalled();
  });

  it('scrolls to the bottom on initial open if no user messages are found', async () => {
    wrapper = mountChatPane( {
      attachTo: document.body,
      global: { plugins: [router] },
    });
    const container = wrapper.find('[data-testid="scroll-container"]').element as HTMLElement;
    setupScrollMock(container);

    await flushPromises();
    await nextTick();
    await nextTick();

    scrollTopSetterSpy.mockClear();
    container.scrollTop = 0;
    scrollTopSetterSpy.mockClear();
    mockCurrentChat.value = {
      ...mockCurrentChat.value!,
      currentLeafId: toMessageId({ raw: 'leaf-open-bottom' }),
    };
    mockActiveMessages.value = [
      { id: toMessageId({ raw: 'a1' }), role: 'assistant', content: 'Hi', timestamp: Date.now(), replies: { items: [] } },
    ];

    await flushPromises();
    await nextTick();
    await nextTick();
    expect(scrollTopSetterSpy).toHaveBeenCalledWith(1000);
  });

  it('reserves response viewport and scrolls the latest user turn to the top when a process sequence appears', async () => {
    wrapper = mountChatPane( {
      attachTo: document.body,
      global: { plugins: [router] },
    });
    const container = wrapper.find('[data-testid="scroll-container"]').element as HTMLElement;
    setupScrollMock(container);

    await flushPromises();
    await nextTick();
    await nextTick();
    scrollTopSetterSpy.mockClear();
    container.scrollTop = 0;
    scrollTopSetterSpy.mockClear();
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 550 });

    mockActiveMessages.value = [
      { id: toMessageId({ raw: 'u1' }), role: 'user', content: 'hi', timestamp: Date.now(), replies: { items: [] } },
      { id: toMessageId({ raw: 'a1' }), role: 'assistant', content: '', timestamp: Date.now(), replies: { items: [] } },
    ];
    mockChatFlowOverride.value = [
      {
        type: 'message',
        node: mockActiveMessages.value[0]!,
        mode: 'content',
        flow: { position: 'standalone', nesting: 'none' },
        isFirstInNode: true,
        isLastInNode: true,
        isFirstInTurn: true,
      },
      {
        type: 'process_sequence',
        id: 'seq-1',
        items: [],
        flow: { position: 'standalone', nesting: 'none' },
        stats: {
          thinkingSteps: 0,
          toolCallCount: 1,
          toolNames: ['shell_execute'],
          isCurrentlyThinking: false,
          isCurrentlyToolRunning: true,
          isWaiting: false,
        },
        isFirstInTurn: true,
      },
    ];

    await flushPromises();
    await nextTick();
    await nextTick();
    expect(scrollTopSetterSpy).toHaveBeenCalledWith(100);
    const reserve = wrapper.find('[data-testid="response-viewport-reserve"]');
    expect(reserve.exists()).toBe(true);
    expect((reserve.element as HTMLElement).style.height).toBe('50px');
  });

  it('re-runs the initial open scroll when the active leaf changes in the same chat', async () => {
    mockCurrentChat.value = {
      ...mockCurrentChat.value!,
      currentLeafId: toMessageId({ raw: 'leaf-1' }),
    };
    mockActiveMessages.value = [
      { id: toMessageId({ raw: 'u1' }), role: 'user', content: 'first leaf', timestamp: Date.now(), replies: { items: [] } },
      { id: toMessageId({ raw: 'a1' }), role: 'assistant', content: 'reply', timestamp: Date.now(), replies: { items: [] } },
    ];

    wrapper = mountChatPane( {
      attachTo: document.body,
      global: { plugins: [router] },
    });
    const container = wrapper.find('[data-testid="scroll-container"]').element as HTMLElement;
    setupScrollMock(container);

    await flushPromises();
    await nextTick();
    await nextTick();
    scrollTopSetterSpy.mockClear();
    container.scrollTop = 0;
    scrollTopSetterSpy.mockClear();

    mockCurrentChat.value = {
      ...mockCurrentChat.value!,
      currentLeafId: toMessageId({ raw: 'leaf-2' }),
    };
    mockActiveMessages.value = [
      { id: toMessageId({ raw: 'u2' }), role: 'user', content: 'second leaf', timestamp: Date.now(), replies: { items: [] } },
      { id: toMessageId({ raw: 'a2' }), role: 'assistant', content: 'reply', timestamp: Date.now(), replies: { items: [] } },
    ];

    await flushPromises();
    await nextTick();
    await nextTick();
    expect(scrollTopSetterSpy).toHaveBeenCalledWith(200);
  });

  it('should not scroll to bottom on window resize (resize event suppression)', async () => {
    wrapper = mountChatPane( {
      attachTo: document.body,
      global: { plugins: [router] },
    });
    const container = wrapper.find('[data-testid="scroll-container"]').element as HTMLElement;
    setupScrollMock(container);

    await flushPromises();
    await nextTick();
    container.scrollTop = 0;
    scrollTopSetterSpy.mockClear();

    window.dispatchEvent(new Event('resize'));

    await flushPromises();
    await nextTick();
    expect(scrollTopSetterSpy).not.toHaveBeenCalled();
  });
});

describe('ChatPane Focus', () => {
  beforeEach(() => {
    resetMocks();
    document.body.innerHTML = '<div id="app"></div>';
    setupScrollToMock();
  });

  afterEach(() => {
    if (wrapper) {
      wrapper.unmount();
      wrapper = null;
    }
    document.body.innerHTML = '';
  });

  it('should focus the textarea after sending a message', async () => {
    wrapper = mountChatPane( {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });

    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]');

    // Find ChatInput component to access handleSend
    const chatInput = wrapper.findComponent(ChatInput);

    // Manually trigger the send logic to verify focus behavior
    // We already tested UI states separately
    await (chatInput.vm as any).handleSend();

    // Wait for focusInput nextTick
    await nextTick();
    await nextTick();

    expect(document.activeElement).toBe(textarea.element);
  });

  it('should focus the textarea when chat is opened', async () => {
    wrapper = mountChatPane( {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });

    await nextTick();
    await nextTick(); // Add extra nextTick for stability
    const textarea = wrapper.find('[data-testid="chat-input"]');
    expect(document.activeElement).toBe(textarea.element);
  });
});

describe('ChatPane Export Functionality', () => {
  beforeAll(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
  });

  // Mock browser APIs for file download
  const mockCreateObjectURL = vi.fn((blob: Blob | MediaSource) => {
    // Mock Blob content access for testing
    if (blob instanceof Blob) {
      // We can't easily mock blob.text() without implementing the whole Blob interface
      // But we can check the blob content in the test itself if needed
      (blob as any).text = async () => {
        return new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(reader.error);
          reader.readAsText(blob);
        });
      };
    }
    return 'blob:mockurl';
  });
  const mockRevokeObjectURL = vi.fn();
  const mockAnchorClick = vi.fn();
  const mockAppendChild = vi.fn();
  const mockRemoveChild = vi.fn();
  let originalCreateElement: any;

  beforeAll(() => {
    // Capture the original createElement once, before any mocks are applied
    originalCreateElement = document.createElement;
  });

  beforeEach(() => {
    resetMocks();
    document.body.innerHTML = '<div id="app"></div>';
    setupScrollToMock();

    // Setup browser API spies/mocks
    vi.spyOn(URL, 'createObjectURL').mockImplementation(mockCreateObjectURL as any);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(mockRevokeObjectURL);

    // Robust mock for document.createElement to avoid breaking Vue internals
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      // Create the real element first
      const el = originalCreateElement.call(document, tagName);

      // If it's an anchor tag, attach our spy
      if (tagName === 'a') {
        // Also attach spy to the real element's click just in case
        vi.spyOn(el, 'click').mockImplementation(mockAnchorClick);
        return el;
      }
      return el;
    });

    vi.spyOn(document.body, 'appendChild').mockImplementation(mockAppendChild);
    vi.spyOn(document.body, 'removeChild').mockImplementation(mockRemoveChild);
  });

  afterEach(() => {
    // Restore all mocks to their original state to ensure a clean slate before applying new mocks
    vi.restoreAllMocks();
    if (wrapper) {
      wrapper.unmount();
      wrapper = null;
    }
    document.body.innerHTML = '';
  });

  it('should export chat as Markdown (.txt)', async () => {
    mockCurrentChat.value = {
      id: toChatId({ raw: 'test-chat-id' }),
      title: 'Predefined Chat Title',
      root: { items: [] },
      currentLeafId: toMessageId({ raw: 'msg-2' }),
      debugEnabled: false,
      originChatId: undefined,
      modelId: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    mockActiveMessages.value = [
      { id: toMessageId({ raw: 'msg-1' }), role: 'user', content: 'Hello AI', timestamp: Date.now(), replies: { items: [] } },
      { id: toMessageId({ raw: 'msg-2' }), role: 'assistant', content: 'Hello User', timestamp: Date.now(), replies: { items: [] } },
    ];

    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    await nextTick(); // Ensure component is rendered and mocks are applied

    await wrapper.find('[data-testid="more-actions-button"]').trigger('click');
    const exportButton = wrapper.find('[data-testid="export-markdown-button"]');
    expect(exportButton.exists()).toBe(true);
    await exportButton.trigger('click');
    await flushPromises();

    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(mockAnchorClick).toHaveBeenCalled();
    expect(mockAppendChild).toHaveBeenCalledWith(expect.any(Object));
    expect(mockRemoveChild).toHaveBeenCalledWith(expect.any(Object));

    // Verify blob content (simplified check since we mocked createObjectURL)
    const blob = (mockCreateObjectURL as Mock).mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('text/plain;charset=utf-8');

    const text = await blob.text();
    expect(text).toContain('# Predefined Chat Title');
    expect(text).toContain(`\
## User:
Hello AI`);
    expect(text).toContain(`\
## AI:
Hello User`);

    // Verify filename
    const link = (mockAppendChild as Mock).mock.calls[0]?.[0];
    expect(link.download).toBe('Predefined Chat Title.txt');
  });

  it('should handle empty chat for markdown export (no current chat)', async () => {
    mockCurrentChat.value = null;
    mockActiveMessages.value = [];

    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    await nextTick();

    // Header (and export button) should not exist if currentChat is null
    const exportButton = wrapper.find('[data-testid="export-markdown-button"]');
    expect(exportButton.exists()).toBe(false);

    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(mockAnchorClick).not.toHaveBeenCalled();
  });

  it('should export with default title if current chat title is empty', async () => {
    mockCurrentChat.value = {
      id: toChatId({ raw: 'test-chat-id-2' }),
      title: '', // Empty title
      root: { items: [] },
      currentLeafId: toMessageId({ raw: 'msg-3' }),
      debugEnabled: false,
      originChatId: undefined,
      modelId: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    mockActiveMessages.value = [
      { id: toMessageId({ raw: 'msg-3' }), role: 'user', content: 'Another message', timestamp: Date.now(), replies: { items: [] } },
    ];

    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    await nextTick();

    await wrapper.find('[data-testid="more-actions-button"]').trigger('click');
    const exportButton = wrapper.find('[data-testid="export-markdown-button"]');
    await exportButton.trigger('click');
    await flushPromises();

    // Just verify the calls happened
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(mockAnchorClick).toHaveBeenCalled();

    const blob = (mockCreateObjectURL as Mock).mock.calls[0]?.[0];
    const text = await blob.text();
    expect(text).toContain('# New Chat');
    expect(text).toContain(`\
## User:
Another message`);

    const link = (mockAppendChild as Mock).mock.calls[0]?.[0];
    expect(link.download).toBe('new_chat.txt');
  });

  it('should handle empty active messages for export', async () => {
    mockCurrentChat.value = {
      id: toChatId({ raw: 'test-chat-id-3' }),
      title: 'Chat with no messages',
      root: { items: [] },
      currentLeafId: undefined,
      debugEnabled: false,
      originChatId: undefined,
      modelId: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    mockActiveMessages.value = []; // Empty messages

    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    await nextTick();

    await wrapper.find('[data-testid="more-actions-button"]').trigger('click');
    const exportButton = wrapper.find('[data-testid="export-markdown-button"]');
    await exportButton.trigger('click');
    await flushPromises();

    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(mockAnchorClick).toHaveBeenCalled();

    const blob = (mockCreateObjectURL as Mock).mock.calls[0]?.[0];
    const text = await blob.text();
    expect(text).toContain('# Chat with no messages');

    const link = (mockAppendChild as Mock).mock.calls[0]?.[0];
    expect(link.download).toBe('Chat with no messages.txt');
  });

  it('should export chat as URL', async () => {
    const mockUrl = 'http://localhost/#/?data-zip=mock-base64';
    mockGenerateChatShareURL.mockResolvedValue(mockUrl);

    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    await nextTick();

    // Open more menu
    const moreBtn = wrapper.find('[data-testid="more-actions-button"]');
    await moreBtn.trigger('click');

    const exportUrlBtn = wrapper.find('[data-testid="export-url-button"]');
    expect(exportUrlBtn.exists()).toBe(true);
    await exportUrlBtn.trigger('click');
    await flushPromises();

    expect(mockGenerateChatShareURL).toHaveBeenCalledWith({ chatId: toChatId({ raw: '1' }) });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(mockUrl);
    expect(mockAddToast).toHaveBeenCalledWith({
      message: 'Share URL copied to clipboard!',
      duration: 3000,
    });
  });
});

describe('ChatPane Textarea Sizing', () => {
  const mockWindowInnerHeight = 1000; // Mock viewport height for 80vh calculation
  let originalGetComputedStyle: any;

  // Helper to mock textarea dimensions (scrollHeight, offsetHeight)
  function mockTextareaDimensions(textarea: HTMLTextAreaElement, scrollHeight: number, offsetHeight?: number) {
    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: scrollHeight });
    Object.defineProperty(textarea, 'offsetHeight', { configurable: true, value: offsetHeight ?? scrollHeight }); // For clientHeight to be non-zero
    // For clientHeight calculation (offsetHeight - border - padding)
    // verticalPadding in mock getComputedStyle is 12+12+1+1 = 26
    Object.defineProperty(textarea, 'clientHeight', { configurable: true, value: (offsetHeight ?? scrollHeight) - 26 });
  }

  beforeAll(() => {
    originalGetComputedStyle = window.getComputedStyle; // Initialized once
  });

  beforeEach(() => {
    resetMocks();
    document.body.innerHTML = '<div id="app"></div>';
    setupScrollToMock();

    // Mock window.innerHeight for 80vh calculation
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: mockWindowInnerHeight });

    // Mock getComputedStyle for textarea to control line-height, padding, border
    // This is crucial for the new adjustTextareaHeight logic
    vi.spyOn(window, 'getComputedStyle').mockImplementation((elt: Element) => {
      // Only return custom computed style for textarea with data-testid='chat-input'
      if (elt instanceof HTMLTextAreaElement && (elt.dataset.testid === 'chat-input' || elt.tagName === 'TEXTAREA')) {
        // Use a base computed style and override
        return {
          lineHeight: '24px', // Mock line-height for calculation
          paddingTop: '12px',
          paddingBottom: '12px',
          borderTopWidth: '1px',
          borderBottomWidth: '1px',
          boxSizing: 'border-box', // Crucial for offsetHeight/clientHeight calculation consistency
        } as any;
      }
      // For all other elements or if not our target, call the original method
      return originalGetComputedStyle.call(window, elt);
    });
  });

  afterEach(() => {
    if (wrapper) {
      wrapper.unmount();
      wrapper = null;
    }
    document.body.innerHTML = '';
  });

  it('should initialize textarea height to a single line height', async () => {
    wrapper = mountChatPane( {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    await nextTick();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;

    // Mock initial dimensions (single line)
    mockTextareaDimensions(textarea, 24); // scrollHeight for 1 line of text
    // Manually trigger adjustTextareaHeight after mocking dimensions for initial state
    const chatInput = wrapper.findComponent(ChatInput);
    (chatInput.vm as any).adjustTextareaHeight({});
    await nextTick();

    const expectedHeight = 50; // 1 line (24) + padding (24) + border (2) = 50
    expect(parseFloat(textarea.style.height)).toBeCloseTo(expectedHeight);
    expect(textarea.style.overflowY).toBe('hidden');
  });

  it('should disable standard textarea resize handle', async () => {
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });
    const textarea = wrapper.find('[data-testid="chat-input"]');
    expect(textarea.classes()).toContain('resize-none');
  });

  it('should show maximize button only when content exceeds 6 lines', async () => {
    wrapper = mountChatPane( {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    await nextTick();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;

    // Initial state: empty input, no button
    expect(wrapper.find('[data-testid="maximize-button"]').exists()).toBe(false);

    // Typing 3 lines: still no button
    (wrapper.findComponent(ChatInput).vm as any).input = `\
Line 1
Line 2
Line 3`;
    mockTextareaDimensions(textarea, 24 * 3);
    await nextTick();
    await nextTick();
    expect(wrapper.find('[data-testid="maximize-button"]').exists()).toBe(false);

    // Typing 7 lines: button appears
    (wrapper.findComponent(ChatInput).vm as any).input = `\
Line 1
Line 2
Line 3
Line 4
Line 5
Line 6
Line 7`;
    mockTextareaDimensions(textarea, 24 * 7 + 26); // scrollHeight > maxSixLinesHeight (170)
    await nextTick();
    await nextTick();
    expect(wrapper.find('[data-testid="maximize-button"]').exists()).toBe(true);
  });

  it('should expand textarea to 80% viewport height when maximized and stay there even with small input', async () => {
    wrapper = mountChatPane( {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    await nextTick();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;

    // Make it long enough to show button
    (wrapper.findComponent(ChatInput).vm as any).input = 'A'.repeat(500);
    mockTextareaDimensions(textarea, 500);
    await nextTick();
    await nextTick();

    const maximizeButton = wrapper.find('[data-testid="maximize-button"]');
    expect(maximizeButton.exists()).toBe(true);

    // Click maximize button
    await maximizeButton.trigger('click');
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 150));
    await nextTick();

    const expected70vh = mockWindowInnerHeight * 0.7;
    expect(parseFloat(textarea.style.height)).toBeCloseTo(expected70vh);

    // Typing small content should NOT shrink it while maximized
    (wrapper.findComponent(ChatInput).vm as any).input = 'small content';
    mockTextareaDimensions(textarea, 24);
    await nextTick();
    await nextTick();
    expect(parseFloat(textarea.style.height)).toBeCloseTo(expected70vh);

    // Click minimize button
    await maximizeButton.trigger('click');
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 150));
    await nextTick();

    // After minimize, it should shrink to content size (single line since input is 'small content')
    const expectedHeightAfterMinimize = 50;
    expect(parseFloat(textarea.style.height)).toBeCloseTo(expectedHeightAfterMinimize);
  });

  it('should reset maximized state after sending a message', async () => {
    wrapper = mountChatPane( {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    await nextTick();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;

    // Fill content and maximize
    (wrapper.findComponent(ChatInput).vm as any).input = 'Message to send';
    mockTextareaDimensions(textarea, 500);
    await nextTick();
    await nextTick();

    const maximizeButton = wrapper.find('[data-testid="maximize-button"]');
    await maximizeButton.trigger('click');
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 150));
    await nextTick();

    expect(parseFloat(textarea.style.height)).toBeCloseTo(mockWindowInnerHeight * 0.7);

    // Mock sendMessage to be a slow promise so we can control the flow
    let resolveSendMessage: (val: boolean) => void;
    mockSendMessage.mockReturnValue(new Promise<boolean>(resolve => {
      resolveSendMessage = resolve;
    }));

    // Send the message
    const sendPromise = (wrapper.findComponent(ChatInput).vm as any).handleSend();
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 150)); // Wait for handleSend async part

    // After sending, the input is cleared, so we must mock the scrollHeight accordingly
    mockTextareaDimensions(textarea, 24);

    resolveSendMessage!(true);
    await sendPromise;
    await nextTick();
    await nextTick();

    // After send, maximized should be false and height should be reset to single line
    expect((wrapper.findComponent(ChatInput).vm as any).isMaximized).toBe(false);
    expect(parseFloat(textarea.style.height)).toBeCloseTo(50);
    expect(wrapper.find('[data-testid="maximize-button"]').exists()).toBe(false);
  });

  it('should reset height to minimum when handleSend starts even if it was at 6 lines', async () => {
    wrapper = mountChatPane( {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    await nextTick();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;

    // Fill content to 6 lines (not maximized)
    (wrapper.findComponent(ChatInput).vm as any).input = `\
Line 1
Line 2
Line 3
Line 4
Line 5
Line 6`;
    mockTextareaDimensions(textarea, 24 * 6 + 26);
    await nextTick();
    await nextTick();
    expect(parseFloat(textarea.style.height)).toBeCloseTo(170);

    // Start sending
    const sendPromise = (wrapper.findComponent(ChatInput).vm as any).handleSend();

    // Height reset now happens AFTER sendMessage resolves
    await mockSendMessage.mock.results[0]?.value;
    await sendPromise;

    // Clear mock dimensions to represent cleared input
    mockTextareaDimensions(textarea, 24);
    await nextTick();
    await nextTick();

    expect(parseFloat(textarea.style.height)).toBeCloseTo(50);
  });

  it('should reset maximized state IMMEDIATELY when handleSend starts', async () => {
    wrapper = mountChatPane( {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    await nextTick();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;

    // Fill content and maximize
    (wrapper.findComponent(ChatInput).vm as any).input = 'Message to send';
    mockTextareaDimensions(textarea, 500);
    await nextTick();

    const maximizeButton = wrapper.find('[data-testid="maximize-button"]');
    await maximizeButton.trigger('click');
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 150));
    await nextTick();
    expect((wrapper.findComponent(ChatInput).vm as any).isMaximized).toBe(true);

    // Mock sendMessage to be a slow promise
    let resolveSendMessage: (val: boolean) => void;
    mockSendMessage.mockReturnValue(new Promise<boolean>(resolve => {
      resolveSendMessage = resolve;
    }));

    // Start sending but do not await yet
    const sendPromise = (wrapper.findComponent(ChatInput).vm as any).handleSend();
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 150));

    // Immediate check
    expect((wrapper.findComponent(ChatInput).vm as any).isMaximized).toBe(false);

    // Resolve sendMessage
    resolveSendMessage!(true);
    await sendPromise;

    // After nextTick, height should already be adjusting back
    mockTextareaDimensions(textarea, 24);
    await nextTick();
    expect(parseFloat(textarea.style.height)).toBeCloseTo(50);
  });

  it('should hide maximize button when content is deleted below 6 lines', async () => {
    wrapper = mountChatPane( {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    await nextTick();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;

    // Fill content to show button
    (wrapper.findComponent(ChatInput).vm as any).input = `\
Line 1
Line 2
Line 3
Line 4
Line 5
Line 6
Line 7`;
    mockTextareaDimensions(textarea, 24 * 7 + 26);
    await nextTick();
    await nextTick();
    expect(wrapper.find('[data-testid="maximize-button"]').exists()).toBe(true);

    // Clear content
    (wrapper.findComponent(ChatInput).vm as any).input = '';
    mockTextareaDimensions(textarea, 24);
    await nextTick();
    await nextTick();
    expect(wrapper.find('[data-testid="maximize-button"]').exists()).toBe(false);
  });

  it('should scroll to bottom when textarea height increases to keep messages visible', async () => {
    wrapper = mountChatPane( {
      attachTo: document.body,
      global: { plugins: [router] },
    });
    const container = wrapper.find('[data-testid="scroll-container"]').element as HTMLElement;
    // Setup scroll mock for container
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 500 });
    let internalScrollTop = 500; // already at bottom
    const scrollTopSpy = vi.fn();
    Object.defineProperty(container, 'scrollTop', {
      configurable: true,
      get: () => internalScrollTop,
      set: (val) => {
        internalScrollTop = val; scrollTopSpy(val);
      },
    });

    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;
    mockTextareaDimensions(textarea, 24);
    await nextTick();
    scrollTopSpy.mockClear();

    // Simulate textarea expansion (1 line -> 3 lines)
    (wrapper.findComponent(ChatInput).vm as any).input = `\
Line 1
Line 2
Line 3`;
    mockTextareaDimensions(textarea, 24 * 3);
    await nextTick();
    await nextTick();

    // It should trigger scrollToBottom to compensate for the smaller container
    expect(scrollTopSpy).toHaveBeenCalled();
  });

  it('should not be extremely small when input is empty (reproduce and fix bug)', async () => {
    wrapper = mountChatPane( {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    await nextTick();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;

    // Type some content to make it expand
    (wrapper.findComponent(ChatInput).vm as any).input = `\
Some content to expand textarea
Line 2
Line 3
Line 4
Line 5
Line 6`;
    mockTextareaDimensions(textarea, 24 * 6 + 26); // Mock full 6 lines
    const chatInput = wrapper.findComponent(ChatInput);
    (chatInput.vm as any).adjustTextareaHeight({});
    await nextTick();
    const expandedHeight = parseFloat(textarea.style.height);
    expect(expandedHeight).toBeCloseTo(170);

    // Clear the input
    (wrapper.findComponent(ChatInput).vm as any).input = '';
    mockTextareaDimensions(textarea, 24); // After clearing, scrollHeight should be single line
    await nextTick(); // Trigger input watcher
    await nextTick(); // Allow adjustTextareaHeight to run

    // After clearing, height should revert to initial single-line height, not 0
    expect(parseFloat(textarea.style.height)).toBeCloseTo(50);
    expect(textarea.style.overflowY).toBe('hidden');
  });

  it('should NOT clear input if sendMessage returns false (regression: onboarding)', async () => {
    mockSendMessage.mockResolvedValueOnce(false);
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]');
    await textarea.setValue('Keep this text');

    const sendBtn = wrapper.find('[data-testid="send-button"]');
    await sendBtn.trigger('click');

    await flushPromises();

    expect(textarea.element.value).toBe('Keep this text');
  });

  it('removes message-id from the URL after sending a new message', async () => {
    await router.push('/?message-id=target-message&leaf=leaf-1');
    const replaceSpy = vi.spyOn(router, 'replace').mockResolvedValue(undefined);
    wrapper = mountChatPane( {
      props: { targetMessageId: toMessageId({ raw: 'target-message' }) },
      global: { plugins: [router] },
    });

    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]');
    await textarea.setValue('Continue from here');

    await wrapper.find('[data-testid="send-button"]').trigger('click');
    await flushPromises();

    expect(replaceSpy).toHaveBeenCalledWith({ query: { leaf: 'leaf-1' } });
  });

  it('should clear input IMMEDIATELY after handleSend returns, even if streaming continues (Regression Test)', async () => {
    // 1. Setup: mockSendMessage returns immediately while setting streaming to true
    mockSendMessage.mockImplementationOnce(async () => {
      // Simulate that generation starts in background
      mockStreaming.value = true;
      return true; //sendMessage returns success immediately after storage commit
    });

    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]');
    await textarea.setValue('This should be cleared');

    // 2. Act: Click send
    const sendBtn = wrapper.find('[data-testid="send-button"]');
    await sendBtn.trigger('click');

    // 3. Assert: Input is cleared even if mockStreaming is still true
    await flushPromises();
    expect(textarea.element.value).toBe('');
    expect(mockStreaming.value).toBe(true);
  });

  it('should reset maximized state when switching to a different chat', async () => {
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    // Set to maximized
    (wrapper.findComponent(ChatInput).vm as any).isMaximized = true;

    // Simulate chat ID change
    mockCurrentChat.value = { ...mockCurrentChat.value!, id: toChatId({ raw: 'chat-2' }) };
    await nextTick();
    await nextTick();

    expect((wrapper.findComponent(ChatInput).vm as any).isMaximized).toBe(false);
  });

  it('should have touch-visible class on attachment remove buttons', async () => {
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    // Manually add an attachment
    (wrapper.findComponent(ChatInput).vm as any).attachments = [{
      id: 'att-1',
      status: 'memory',
      blob: new Blob([''], { type: 'image/png' }),
      originalName: 'mem.png',
      mimeType: 'image/png',
      size: 10,
      uploadedAt: Date.now(),
    }];

    await nextTick();

    const removeBtn = wrapper.find('.group\\/att button');
    expect(removeBtn.classes()).toContain('touch-visible');
  });

  it('should handle large text paste by showing the maximize button immediately', async () => {
    wrapper = mountChatPane( {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    await nextTick();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;

    // Simulate pasting 50 lines
    (wrapper.findComponent(ChatInput).vm as any).input = 'Line\n'.repeat(50);
    mockTextareaDimensions(textarea, 24 * 50);
    await nextTick();
    await nextTick();

    expect(wrapper.find('[data-testid="maximize-button"]').exists()).toBe(true);
    expect(parseFloat(textarea.style.height)).toBeCloseTo(170); // Max 6 lines
  });

  it('should recalculate maximized height on window resize', async () => {
    wrapper = mountChatPane( {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    await nextTick();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;

    // Maximize
    (wrapper.findComponent(ChatInput).vm as any).isMaximized = true;
    await nextTick();
    await nextTick();

    expect(parseFloat(textarea.style.height)).toBeCloseTo(700); // 70% of 1000

    // Change window height and trigger resize
    Object.defineProperty(window, 'innerHeight', { writable: true, value: 500 });
    window.dispatchEvent(new Event('resize'));
    await nextTick();

    expect(parseFloat(textarea.style.height)).toBeCloseTo(350); // 70% of 500
  });

  it('should not use transition-all on textarea to avoid height flickering', async () => {
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });
    const textarea = wrapper.find('[data-testid="chat-input"]');
    expect(textarea.classes()).not.toContain('transition-all');
    expect(textarea.classes()).toContain('transition-colors');
  });

  it('should remain at minimum height for any 1-line content', async () => {
    wrapper = mountChatPane( {
      attachTo: document.getElementById('app')!,
      global: { plugins: [router] },
    });
    await nextTick();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]').element;

    // lineHeight (24) + verticalPadding (12+12+1+1 = 26) = 50
    // Actually in the test's getComputedStyle mock, padding/border sum to 26px
    // Let's use 50 as the expected minimum based on the mock values.
    const expectedMinHeight = 50;

    // Test with very short text
    (wrapper.vm as any).input = 'a';
    mockTextareaDimensions(textarea, 24); // scrollHeight for 1 line content
    await nextTick();
    await nextTick();
    expect(parseFloat(textarea.style.height)).toBeCloseTo(expectedMinHeight);

    // Test with longer text that still fits in 1 line
    (wrapper.vm as any).input = 'This is a longer string but still only one line';
    mockTextareaDimensions(textarea, 24);
    await nextTick();
    await nextTick();
    expect(parseFloat(textarea.style.height)).toBeCloseTo(expectedMinHeight);

    // Even if scrollHeight is slightly less (e.g., 20px), it should stay at minHeight (50px)
    mockTextareaDimensions(textarea, 20);
    await nextTick();
    await nextTick();
    expect(parseFloat(textarea.style.height)).toBeCloseTo(expectedMinHeight);
  });
});

describe('ChatPane Welcome Screen & Suggestions', () => {
  beforeEach(() => {
    resetMocks();
    document.body.innerHTML = '<div id="app"></div>';
    setupScrollToMock();
  });

  afterEach(() => {
    if (wrapper) {
      wrapper.unmount();
      wrapper = null;
    }
    document.body.innerHTML = '';
  });

  it('should show the welcome screen when there are no messages', async () => {
    wrapper = mountChatPane( {
      global: {
        plugins: [router],
        stubs: { WelcomeScreen: { template: '<div data-testid="welcome-screen-stub">Welcome</div>' } },
      },
    });

    expect(wrapper.find('[data-testid="welcome-screen-stub"]').exists()).toBe(true);
  });

  it('should fill the input and focus when WelcomeScreen emits select-suggestion', async () => {
    wrapper = mountChatPane( {
      attachTo: document.body,
      global: {
        plugins: [router],
        stubs: { WelcomeScreen: true },
      },
    });

    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]');
    const focusSpy = vi.spyOn(textarea.element, 'focus');

    const welcomeScreen = wrapper.findComponent({ name: 'WelcomeScreen' });
    await welcomeScreen.vm.$emit('select-suggestion', 'Test Suggestion');

    await nextTick();
    await nextTick();

    expect((textarea.element as HTMLTextAreaElement).value).toBe('Test Suggestion');
    expect(focusSpy).toHaveBeenCalled();
  });

  it('should hide the welcome screen when messages are present', async () => {
    mockActiveMessages.value = [{ id: toMessageId({ raw: '1' }), role: 'user', content: 'hi', timestamp: Date.now(), replies: { items: [] } }];
    wrapper = mountChatPane( {
      global: {
        plugins: [router],
        stubs: { WelcomeScreen: { template: '<div data-testid="welcome-screen-stub">Welcome</div>' } },
      },
    });

    expect(wrapper.find('[data-testid="welcome-screen-stub"]').exists()).toBe(false);
  });
});

describe('ChatPane Model Selection', () => {
  beforeEach(() => {
    resetMocks();
    mockAvailableModels.value = ['model-1', 'model-2'];
    mockFetchingModels.value = false;
    document.body.innerHTML = '<div id="app"></div>';
    setupScrollToMock();
  });

  afterEach(() => {
    if (wrapper) {
      wrapper.unmount();
      wrapper = null;
    }
    document.body.innerHTML = '';
  });

  it('should render available models in the dropdown', async () => {
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    const trigger = wrapper.find('[data-testid="model-selector-trigger"]');
    expect(trigger.exists()).toBe(true);

    await trigger.trigger('click');

    // The items are buttons in ModelSelector, teleported to body
    const modelButtons = Array.from(document.body.querySelectorAll('button'))
      .filter(b => mockAvailableModels.value.includes(b.textContent || ''));

    expect(modelButtons.length).toBe(2);
    expect(modelButtons[0]!.textContent).toBe('model-1');
    expect(modelButtons[1]!.textContent).toBe('model-2');
  });

  it('should pass a naturally sorted list of models to ModelSelector', async () => {
    mockAvailableModels.value = ['model-10', 'model-2', 'model-1'];
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    const selector = wrapper.getComponent({ name: 'ModelSelector' });
    expect(selector.props('models')).toEqual(['model-1', 'model-2', 'model-10']);
  });

  it('should display the global default model name as placeholder', async () => {
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    const trigger = wrapper.find('[data-testid="model-selector-trigger"]');
    expect(trigger.text()).toBe('global-default-model (Global)');
  });

  it('should trigger updateChatModel when a model is selected in ModelSelector', async () => {
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    // Open dropdown
    const trigger = wrapper.find('[data-testid="model-selector-trigger"]');
    await trigger.trigger('click');

    // Select 'model-2' from document.body
    const model2Btn = Array.from(document.body.querySelectorAll('button'))
      .find(b => b.textContent === 'model-2');

    (model2Btn as HTMLElement).click();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockUpdateChatModel).toHaveBeenCalledWith({ id: toChatId({ raw: '1' }), modelId: 'model-2' });
    expect(mockCurrentChat.value!.modelId).toBe('model-2');
  });

  it('should show loader when fetching models', async () => {
    mockFetchingModels.value = true;
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    expect(wrapper.find('.animate-spin').exists()).toBe(true);
  });

  it('should trigger fetchAvailableModels on mount if chat exists', async () => {
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    expect(mockFetchAvailableModels).toHaveBeenCalled();
  });

  it('should trigger fetchAvailableModels when switching chats', async () => {
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });
    mockFetchAvailableModels.mockClear();
    mockRenameChat.mockClear();
    mockSaveSettings.mockClear();

    // Simulate chat ID change
    if (mockCurrentChat.value) {
      mockCurrentChat.value = { ...mockCurrentChat.value, id: toChatId({ raw: 'chat-new' }) };
    }
    await nextTick();

    expect(mockFetchAvailableModels).toHaveBeenCalled();
  });

  it('automatically sends message when autoSendPrompt is provided', async () => {
    mockCurrentChat.value = {
      id: toChatId({ raw: '1' }),
      title: 'Test Chat',
      root: { items: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false,
    } as Chat;

    wrapper = mountChatPane( {
      props: {
        autoSendPrompt: 'automatic message',
      },
      global: {
        plugins: [router],
        stubs: { 'Logo': true, 'MessageItem': true, 'WelcomeScreen': true, 'ChatSettingsPanel': true },
      },
    });

    await flushPromises();
    await nextTick();
    await nextTick();
    await nextTick();

    expect(mockSendMessage).toHaveBeenCalledWith({ chatId: toChatId({ raw: '1' }), content: 'automatic message', parentId: undefined, attachments: [], lmParameters: expect.anything() });
    expect(wrapper.emitted('auto-sent')).toBeTruthy();
  });

  it('should sync reasoning effort between tools menu and settings panel in real-time', async () => {
    wrapper = mountChatPane( {
      global: {
        plugins: [router],
        stubs: { 'Logo': true, 'MessageItem': true, 'WelcomeScreen': true },
      },
    });
    await flushPromises();

    // 1. Initial state
    mockCurrentChat.value = {
      id: toChatId({ raw: '1' }),
      title: 'Test Chat',
      root: { items: [] },
      lmParameters: EMPTY_LM_PARAMETERS,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false,
    } as Chat;
    await nextTick();

    // 2. Open tools menu and change reasoning effort
    const toolsMenu = wrapper.findComponent({ name: 'ChatToolsMenu' });
    expect(toolsMenu.exists()).toBe(true);
    await toolsMenu.vm.$emit('update:reasoning-effort', 'high');
    await nextTick();

    // Verify currentChat was updated via the updateChatSettings call from ChatInput
    expect(mockCurrentChat.value.lmParameters?.reasoning?.effort).toBe('high');

    // 3. Open Settings Panel
    const settingsBtn = wrapper.find('button[data-testid="model-trigger"]');
    await settingsBtn.trigger('click');
    await vi.dynamicImportSettled();
    await flushPromises();
    await nextTick();

    await vi.waitFor(() => {
      expect(wrapper!.findComponent({ name: 'ChatSettingsPanel' }).exists()).toBe(true);
    });
    const settingsPanel = wrapper!.findComponent({ name: 'ChatSettingsPanel' });

    // Verify Settings Panel UI is synced
    const reasoningSettings = settingsPanel.findComponent({ name: 'ReasoningSettings' });
    expect(reasoningSettings.exists()).toBe(true);
    expect(reasoningSettings.props('selectedEffort')).toBe('high');

    // 4. Change reasoning effort in Settings Panel
    await reasoningSettings.vm.$emit('update:effort', 'low');
    await flushPromises();
    await nextTick();

    // Verify currentChat was updated via the panel's save mechanism
    expect(mockCurrentChat.value.lmParameters?.reasoning?.effort).toBe('low');

    // 5. Verify Tools Menu UI is also synced
    expect(toolsMenu.props('selectedReasoningEffort')).toBe('low');
  }, 20_000);
});
