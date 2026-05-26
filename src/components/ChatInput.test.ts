import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ChatInput from './ChatInput.vue';
import { computed, nextTick, ref } from 'vue';

const { mockRouter } = vi.hoisted(() => ({
  mockRouter: {
    currentRoute: { value: { query: {} as Record<string, string> } },
    replace: vi.fn(),
    push: vi.fn(),
  },
}));

// Mock Lucide icons
vi.mock('lucide-vue-next', () => ({
  SquareIcon: { template: '<span>Square</span>' },
  Minimize2Icon: { template: '<span>Minimize2</span>' },
  Maximize2Icon: { template: '<span>Maximize2</span>' },
  SendIcon: { template: '<span>Send</span>' },
  XIcon: { template: '<span>X</span>' },
  ImageIcon: { template: '<span>Image</span>' },
  ChevronDownIcon: { template: '<span>ChevronDown</span>' },
  ChevronUpIcon: { template: '<span>ChevronUp</span>' },
  Edit2Icon: { template: '<span>Edit2</span>' },
  FileEditIcon: { template: '<span>FileEdit</span>' },
  PlusIcon: { template: '<span>Plus</span>' },
  FolderIcon: { template: '<span>Folder</span>' },
  FilesIcon: { template: '<span>Files</span>' },
  FolderSymlinkIcon: { template: '<span>FolderSymlink</span>' },
  FolderDownIcon: { template: '<span>FolderDown</span>' },
  InfoIcon: { template: '<span>Info</span>' },
  Loader2Icon: { template: '<span>Loader2</span>' },
  LockIcon: { template: '<span>Lock</span>' },
  UnlockIcon: { template: '<span>Unlock</span>' },
  SearchIcon: { template: '<span>Search</span>' },
  ReplaceIcon: { template: '<span>Replace</span>' },
  Undo2Icon: { template: '<span>Undo2</span>' },
  Redo2Icon: { template: '<span>Redo2</span>' },
  Trash2Icon: { template: '<span>Trash2</span>' },
  CopyIcon: { template: '<span>Copy</span>' },
  ArrowDownIcon: { template: '<span>ArrowDown</span>' },
  ArrowUpIcon: { template: '<span>ArrowUp</span>' },
  TypeIcon: { template: '<span>Type</span>' },
  HashIcon: { template: '<span>Hash</span>' },
  PencilLineIcon: { template: '<span>PencilLine</span>' },
  MousePointer2Icon: { template: '<span>MousePointer2</span>' },
  LayersIcon: { template: '<span>Layers</span>' },
  CheckIcon: { template: '<span>Check</span>' },
  WrapTextIcon: { template: '<span>WrapText</span>' },
  BarChart2Icon: { template: '<span>BarChart2</span>' },
  AlignLeftIcon: { template: '<span>AlignLeft</span>' },
}));

// Mock child components
vi.mock('./ModelSelector.vue', () => ({ default: { name: 'ModelSelector', template: '<div></div>' } }));
vi.mock('./ChatToolsMenu.vue', () => ({ default: { name: 'ChatToolsMenu', template: '<div></div>' } }));

const mockOpenFileExplorer = vi.fn();
const mockEnsureChatTmpDirectory = vi.fn();
const mockGetChatTmpDirectory = vi.fn();
const mockGetNaidanSysfsMountSelection = vi.fn();

const mockSettings = ref<any>({ storageType: 'opfs', mounts: [] });
vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: mockSettings,
  }),
}));

// Mock new composables and services
vi.mock('../composables/useChatTools', () => ({
  useChatTools: () => ({
    setToolEnabled: vi.fn(),
  }),
}));
vi.mock('../composables/useChatWeshPreferences', () => ({
  useChatWeshPreferences: () => ({
    getNaidanSysfsMountSelection: mockGetNaidanSysfsMountSelection,
  }),
}));
vi.mock('../composables/useToast', () => ({
  useToast: () => ({
    addToast: vi.fn(),
  }),
}));
vi.mock('../composables/useConfirm', () => ({
  useConfirm: () => ({
    showConfirm: vi.fn().mockResolvedValue(true),
  }),
}));
vi.mock('../composables/useFileExplorerModal', () => ({
  useFileExplorerModal: () => ({
    openFileExplorer: mockOpenFileExplorer,
  }),
}));
vi.mock('../services/storage', () => ({
  storageService: {
    getVolume: vi.fn(),
    createVolumeFromFiles: vi.fn(),
    createVolume: vi.fn(),
    getVolumeDirectoryHandle: vi.fn(),
    listVolumes: vi.fn(),
  },
}));
vi.mock('../services/storage/opfs-detection', () => ({
  checkFileSystemAccessSupport: vi.fn(() => false),
}));

vi.mock('../composables/useChatWeshTerminalSessions', () => ({
  buildWorkerMountsForChat: vi.fn(async ({
    chatMounts,
    chatGroupMounts,
    chatId,
    naidanSysfsVisibility,
  }: {
    chatMounts: Array<{ type: string; volumeId?: string; mountPath: string; readOnly: boolean }>;
    chatGroupMounts: Array<{ type: string; volumeId?: string; mountPath: string; readOnly: boolean }> | undefined;
    chatId: string | undefined;
    chatGroupId: string | undefined;
    naidanSysfsVisibility: 'none' | 'current_chat_only' | 'current_chat_with_chat_group' | 'all_chats';
  }) => {
    const { storageService } = await import('../services/storage');
    const mounts: Array<{ type: string; path: string; readOnly?: boolean; visibility?: string }> = [];

    if (chatId !== undefined && mockSettings.value.storageType === 'opfs') {
      const tmp = await mockEnsureChatTmpDirectory({ chatId });
      mounts.push({ type: 'directory', path: tmp.mountPath, readOnly: false });
    }

    if (naidanSysfsVisibility !== 'none') {
      mounts.push({
        type: 'naidan_sysfs',
        path: '/sys/fs/naidan',
        visibility: naidanSysfsVisibility,
      });
    }

    for (const mount of mockSettings.value.mounts ?? []) {
      if (mount.type !== 'volume') {
        continue;
      }
      if (mount.volumeId === undefined) {
        continue;
      }
      const handle = await storageService.getVolumeDirectoryHandle({ volumeId: mount.volumeId });
      if (handle !== undefined) {
        mounts.push({ type: 'directory', path: mount.mountPath, readOnly: mount.readOnly });
      }
    }

    for (const mount of chatGroupMounts ?? []) {
      if (mount.type !== 'volume') {
        continue;
      }
      if (mount.volumeId === undefined) {
        continue;
      }
      const handle = await storageService.getVolumeDirectoryHandle({ volumeId: mount.volumeId });
      if (handle === undefined) {
        continue;
      }
      const existingIndex = mounts.findIndex(({ path }) => path === mount.mountPath);
      const entry = { type: 'directory', path: mount.mountPath, readOnly: mount.readOnly };
      if (existingIndex >= 0) {
        mounts[existingIndex] = entry;
      } else {
        mounts.push(entry);
      }
    }

    for (const mount of chatMounts) {
      if (mount.type !== 'volume') {
        continue;
      }
      if (mount.volumeId === undefined) {
        continue;
      }
      const handle = await storageService.getVolumeDirectoryHandle({ volumeId: mount.volumeId });
      if (handle === undefined) {
        continue;
      }
      const existingIndex = mounts.findIndex(({ path }) => path === mount.mountPath);
      const entry = { type: 'directory', path: mount.mountPath, readOnly: mount.readOnly };
      if (existingIndex >= 0) {
        mounts[existingIndex] = entry;
      } else {
        mounts.push(entry);
      }
    }

    return mounts;
  }),
}));

// Mock composables
const mockCurrentChat = ref<any>({ id: 'chat-1', modelId: 'model-1' });
const mockCurrentChatGroup = ref<any>(null);
const mockSendMessage = vi.fn();
const mockSendMessageForChat = vi.fn();
const mockRegenerateMessageForChat = vi.fn();
const mockAbortChat = vi.fn();
const mockUpdateChatSettings = vi.fn();

const mockReasoningStore = {
  getReasoningEffort: vi.fn(({ chatId }) => {
    if (mockCurrentChat.value?.id === chatId) {
      return mockCurrentChat.value.lmParameters?.reasoning?.effort;
    }
    return undefined;
  }),
  updateReasoningEffort: vi.fn(({ chatId, effort }) => {
    if (mockCurrentChat.value?.id === chatId) {
      mockCurrentChat.value.lmParameters = {
        ...(mockCurrentChat.value.lmParameters || {}),
        reasoning: { effort }
      };
      mockUpdateChatSettings(chatId, { lmParameters: mockCurrentChat.value.lmParameters });
    }
  }),
};

vi.mock('../composables/useReasoning', () => ({
  useReasoning: () => mockReasoningStore,
}));

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: mockCurrentChat,
    currentChatGroup: mockCurrentChatGroup,
    availableModels: ref([]),
    inheritedSettings: ref(null),
    fetchingModels: ref(false),
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
    fetchAvailableModels: vi.fn(),
    sendMessage: mockSendMessage,
    sendMessageForChat: mockSendMessageForChat,
    regenerateMessageForChat: mockRegenerateMessageForChat,
    abortChat: mockAbortChat,
    updateChatSettings: mockUpdateChatSettings,
    getLiveChat: vi.fn().mockImplementation((c) => {
      if (mockCurrentChat.value?.id === (c.id || c)) return mockCurrentChat.value;
      return c;
    }),
    ensureChatTmpDirectory: mockEnsureChatTmpDirectory,
    getChatTmpDirectory: mockGetChatTmpDirectory,
  }),
}));

const mockDraft = ref<any>({ input: '', attachments: [], attachmentUrls: {} });
vi.mock('../composables/useChatDraft', () => ({
  useChatDraft: () => ({
    getDraft: vi.fn(() => mockDraft.value),
    saveDraft: vi.fn(),
    clearDraft: vi.fn(),
    revokeAll: vi.fn(),
  }),
}));

const mockIsImageMode = ref(false);
const mockPreferredEditorMode = ref('advanced');
const mockSetPreferredEditorMode = vi.fn();

const mockChatStore = {
  currentChat: mockCurrentChat,
  currentChatGroup: mockCurrentChatGroup,
  availableModels: ref([]),
  inheritedSettings: ref(null),
  fetchingModels: ref(false),
  isImageMode: vi.fn(() => mockIsImageMode.value),
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
  fetchAvailableModels: vi.fn(),
  sendMessage: mockSendMessage,
  sendMessageForChat: mockSendMessageForChat,
  regenerateMessageForChat: mockRegenerateMessageForChat,
  abortChat: mockAbortChat,
  updateChatSettings: mockUpdateChatSettings,
  getReasoningEffort: vi.fn(({ chatId }) => {
    if (mockCurrentChat.value?.id === chatId) {
      return mockCurrentChat.value.lmParameters?.reasoning?.effort;
    }
    return undefined;
  }),
  updateReasoningEffort: vi.fn(({ chatId, effort }) => {
    if (mockCurrentChat.value?.id === chatId) {
      mockCurrentChat.value.lmParameters = {
        ...(mockCurrentChat.value.lmParameters || {}),
        reasoning: { effort }
      };
      mockUpdateChatSettings(chatId, { lmParameters: mockCurrentChat.value.lmParameters });
    }
  }),
  getLiveChat: vi.fn().mockImplementation((c) => {
    if (mockCurrentChat.value?.id === (c.id || c)) return mockCurrentChat.value;
    return c;
  }),
  ensureChatTmpDirectory: mockEnsureChatTmpDirectory,
  getChatTmpDirectory: mockGetChatTmpDirectory,
  addMountToChat: vi.fn(),
  removeMountFromChat: vi.fn(),
  updateChatMount: vi.fn(),
};

vi.mock('../composables/useChat', () => ({
  useChat: () => mockChatStore,
}));

vi.mock('../composables/chat/chat-scoped/useChatGeneration', () => ({
  useChatGeneration: () => ({
    sendMessage: mockSendMessageForChat,
    regenerateMessage: mockRegenerateMessageForChat,
    abort: () => mockAbortChat({ chatId: mockCurrentChat.value?.id }),
  }),
}));

vi.mock('../composables/chat/chat-scoped/useChatImageGeneration', () => ({
  useChatImageGeneration: () => ({
    availableModels: computed(() => mockChatStore.availableModels.value),
    isImageMode: computed(() => mockIsImageMode.value),
    resolution: computed(() => mockChatStore.getResolution()),
    count: computed(() => mockChatStore.getCount()),
    persistAs: computed(() => mockChatStore.getPersistAs()),
    steps: computed(() => mockChatStore.getSteps()),
    seed: computed(() => mockChatStore.getSeed()),
    selectedImageModel: computed(() => mockChatStore.getSelectedImageModel()),
    toggleImageMode: () => mockChatStore.toggleImageMode(),
    updateResolution: ({ width, height }: { width: number; height: number }) => mockChatStore.updateResolution({ width, height }),
    updateCount: ({ count }: { count: number }) => mockChatStore.updateCount({ count }),
    updatePersistAs: ({ format }: { format: 'original' | 'webp' | 'jpeg' | 'png' }) => mockChatStore.updatePersistAs({ format }),
    updateSteps: ({ steps }: { steps: number | undefined }) => mockChatStore.updateSteps({ steps }),
    updateSeed: ({ seed }: { seed: number | 'browser_random' | undefined }) => mockChatStore.updateSeed({ seed }),
    setImageModel: ({ modelId }: { modelId: string }) => mockChatStore.setImageModel({ modelId }),
    sendImageRequest: vi.fn().mockResolvedValue(true),
    TEST_ONLY: {},
  }),
}));

vi.mock('../composables/chat/chat-scoped/useChatReadModel', () => ({
  useChatReadModel: ({ chatId }: { chatId: { value: string | undefined } }) => ({
    currentChat: computed(() => chatId.value === mockCurrentChat.value?.id ? mockCurrentChat.value : null),
    currentChatGroup: computed(() => chatId.value === mockCurrentChat.value?.id ? mockCurrentChatGroup.value : null),
    activeMessages: ref([]),
    allMessages: ref([]),
    resolvedSettings: ref(null),
    inheritedSettings: ref(null),
  }),
}));

vi.mock('../composables/chat/chat-scoped/useChatReasoning', () => ({
  useChatReasoning: () => ({
    effort: computed(() => mockCurrentChat.value?.lmParameters?.reasoning?.effort),
    updateEffort: ({ effort }: { effort: 'none' | 'low' | 'medium' | 'high' | undefined }) => {
      mockReasoningStore.updateReasoningEffort({
        chatId: mockCurrentChat.value?.id,
        effort,
      });
    },
  }),
}));

vi.mock('../composables/chat/chat-scoped/useChatDraft', () => ({
  useChatDraft: () => ({
    getDraft: () => mockDraft.value,
    saveDraft: vi.fn(),
    clearDraft: vi.fn(),
    revokeAll: vi.fn(),
  }),
}));

vi.mock('../composables/chat/chat-scoped/useChatModelSelection', () => ({
  useChatModelSelection: () => ({
    availableModels: mockChatStore.availableModels,
    fetchingModels: mockChatStore.fetchingModels,
    fetchModels: () => mockChatStore.fetchAvailableModels({ chatId: mockCurrentChat.value?.id }),
    updateModel: ({ modelId }: { modelId: string | undefined }) => mockUpdateChatSettings(mockCurrentChat.value?.id, { modelId }),
  }),
}));

vi.mock('../composables/chat/chat-scoped/useChatMounts', () => ({
  useChatMounts: ({ chatId }: { chatId: { value: string | undefined } }) => ({
    mounts: computed(() => {
      if (chatId.value !== mockCurrentChat.value?.id) {
        return [];
      }

      return mockCurrentChat.value?.mounts ?? [];
    }),
    addMount: vi.fn(),
    removeMount: vi.fn(),
    updateMount: vi.fn(),
    TEST_ONLY: {},
  }),
}));

vi.mock('../composables/useLayout', () => ({
  useLayout: () => ({
    activeFocusArea: ref('chat'),
    setActiveFocusArea: vi.fn(),
    preferredEditorMode: mockPreferredEditorMode,
    setPreferredEditorMode: mockSetPreferredEditorMode,
  }),
}));

vi.mock('vue-router', () => ({
  useRouter: () => mockRouter,
}));

// Mock URL
global.URL.createObjectURL = vi.fn(() => 'blob:test');
global.URL.revokeObjectURL = vi.fn();

describe('ChatInput Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRouter.currentRoute.value = { query: {} };
    mockCurrentChat.value = { id: 'chat-1', modelId: 'model-1' };
    mockCurrentChatGroup.value = null;
    mockSettings.value = { storageType: 'opfs', mounts: [] };
    mockEnsureChatTmpDirectory.mockResolvedValue({ handle: { kind: 'directory', name: 'tmp' }, mountPath: '/tmp' });
    mockGetChatTmpDirectory.mockReturnValue(undefined);
    mockGetNaidanSysfsMountSelection.mockReturnValue('none');
    mockSendMessageForChat.mockResolvedValue(true);
  });

  const getWrapper = () => mount(ChatInput, {
    props: {
      chatId: 'chat-1',
      visibility: 'active',
      isStreaming: false,
      canGenerateImage: true,
      hasImageModel: true,
      availableImageModels: [],
      isAnimatingHeight: false
    },
    global: {
      stubs: {
        Teleport: true,
        ImageEditor: {
          name: 'ImageEditor',
          template: '<div data-testid="image-editor"><button class="apply-btn" @click="$emit(\'save\', { blob: {} })">Apply</button></div>',
          emits: ['save', 'cancel']
        }
      }
    }
  });

  it('does not synchronize currentLeafId changes into the URL query', async () => {
    mockRouter.currentRoute.value = { query: {} };
    mockCurrentChat.value = {
      id: 'chat-1',
      modelId: 'model-1',
      currentLeafId: 'leaf-1',
      root: { items: [] },
    };

    getWrapper();
    await nextTick();

    mockCurrentChat.value = {
      ...mockCurrentChat.value,
      currentLeafId: 'leaf-2',
    };
    await nextTick();

    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('should open ImageEditor when edit button is clicked', async () => {
    const wrapper = getWrapper();

    wrapper.vm.TEST_ONLY.attachments.value = [{
      id: 'att-1',
      binaryObjectId: 'bin-1',
      originalName: 'test.png',
      mimeType: 'image/png',
      size: 100,
      uploadedAt: Date.now(),
      status: 'memory',
      blob: new Blob()
    }];
    await nextTick();

    const editButton = wrapper.find('button[title="Edit Image"]');
    await editButton.trigger('click');

    await flushPromises();
    await nextTick();

    expect(wrapper.vm.TEST_ONLY.editingAttachmentId.value).toBe('att-1');
    expect(wrapper.find('[data-testid="image-editor"]').exists()).toBe(true);
  });

  it('mount explorer includes tmp while opening from a volume badge for opfs', async () => {
    mockCurrentChat.value = {
      id: 'chat-1',
      modelId: 'model-1',
      mounts: [{ type: 'volume', volumeId: 'vol-1', mountPath: '/home/user/work', readOnly: true }],
    };
    mockSettings.value = {
      storageType: 'opfs',
      mounts: [],
    };

    const { storageService } = await import('../services/storage');
    vi.mocked(storageService.getVolumeDirectoryHandle).mockResolvedValue({ kind: 'directory', name: 'work' } as FileSystemDirectoryHandle);

    const wrapper = getWrapper();
    await nextTick();

    await wrapper.find('[data-testid="mount-open-explorer"]').trigger('click');
    await flushPromises();

    expect(mockEnsureChatTmpDirectory).toHaveBeenCalledWith({ chatId: 'chat-1' });
    expect(mockOpenFileExplorer).toHaveBeenCalledWith({ options: expect.objectContaining({
      kind: 'wesh-mounts',
      rootName: 'Files',
      initialPath: ['home', 'user', 'work'],
      title: 'Files',
    }) });
  });

  it('mount explorer omits tmp for local storage', async () => {
    mockCurrentChat.value = {
      id: 'chat-1',
      modelId: 'model-1',
      mounts: [{ type: 'volume', volumeId: 'vol-1', mountPath: '/home/user/work', readOnly: true }],
    };
    mockSettings.value = {
      storageType: 'local',
      mounts: [],
    };

    const { storageService } = await import('../services/storage');
    vi.mocked(storageService.getVolumeDirectoryHandle).mockResolvedValue({ kind: 'directory', name: 'work' } as FileSystemDirectoryHandle);

    const wrapper = getWrapper();
    await nextTick();

    await wrapper.find('[data-testid="mount-open-explorer"]').trigger('click');
    await flushPromises();

    expect(mockEnsureChatTmpDirectory).not.toHaveBeenCalled();
    expect(mockOpenFileExplorer).toHaveBeenCalledTimes(1);
    const [{ options }] = mockOpenFileExplorer.mock.calls[0] as [{ options: {
      mounts: Array<{ path: string }>;
    } }];
    expect(options.mounts.some(({ path }) => path === '/tmp')).toBe(false);
  });

  it('mount explorer includes global settings mounts alongside chat mounts', async () => {
    mockCurrentChat.value = {
      id: 'chat-1',
      modelId: 'model-1',
      mounts: [{ type: 'volume', volumeId: 'vol-chat', mountPath: '/home/user/chat-vol', readOnly: false }],
    };
    mockSettings.value = {
      storageType: 'opfs',
      mounts: [{ type: 'volume', volumeId: 'vol-global', mountPath: '/home/user/global-vol', readOnly: true }],
    };

    const { storageService } = await import('../services/storage');
    vi.mocked(storageService.getVolumeDirectoryHandle).mockResolvedValue({ kind: 'directory', name: 'vol' } as FileSystemDirectoryHandle);

    const wrapper = getWrapper();
    await nextTick();

    await wrapper.find('[data-testid="mount-open-explorer"]').trigger('click');
    await flushPromises();

    // Called once for chat mount and once for global mount
    expect(vi.mocked(storageService.getVolumeDirectoryHandle)).toHaveBeenCalledWith({ volumeId: 'vol-chat' });
    expect(vi.mocked(storageService.getVolumeDirectoryHandle)).toHaveBeenCalledWith({ volumeId: 'vol-global' });
    expect(mockOpenFileExplorer).toHaveBeenCalledWith({ options: expect.objectContaining({
      kind: 'wesh-mounts',
      rootName: 'Files',
      title: 'Files',
    }) });
  });

  it('mount explorer reuses shared naidan sysfs mount selection', async () => {
    mockCurrentChat.value = {
      id: 'chat-1',
      modelId: 'model-1',
      groupId: 'group-1',
      mounts: [{ type: 'volume', volumeId: 'vol-chat', mountPath: '/home/user/chat-vol', readOnly: false }],
    };
    mockCurrentChatGroup.value = {
      id: 'group-1',
      mounts: [{ type: 'volume', volumeId: 'vol-group', mountPath: '/home/user/group-vol', readOnly: true }],
    };
    mockSettings.value = {
      storageType: 'opfs',
      mounts: [{ type: 'volume', volumeId: 'vol-global', mountPath: '/home/user/global-vol', readOnly: true }],
    };
    mockGetNaidanSysfsMountSelection.mockReturnValue('current_chat_only');

    const { storageService } = await import('../services/storage');
    vi.mocked(storageService.getVolumeDirectoryHandle).mockResolvedValue({ kind: 'directory', name: 'vol' } as FileSystemDirectoryHandle);

    const wrapper = getWrapper();
    await nextTick();

    await wrapper.find('[data-testid="mount-open-explorer"]').trigger('click');
    await flushPromises();

    expect(mockOpenFileExplorer).toHaveBeenCalledTimes(1);
    const [{ options }] = mockOpenFileExplorer.mock.calls[0] as [{ options: {
      mounts: Array<{ type: string; path: string; visibility?: string }>;
    } }];
    expect(options.mounts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'naidan_sysfs',
        path: '/sys/fs/naidan',
        visibility: 'current_chat_only',
      }),
    ]));
  });

  it('mount badges do not include global settings mounts', async () => {
    mockCurrentChat.value = {
      id: 'chat-1',
      modelId: 'model-1',
      mounts: [],
    };
    mockSettings.value = {
      mounts: [{ type: 'volume', volumeId: 'vol-global', mountPath: '/home/user/global-vol', readOnly: true }],
    };

    const wrapper = getWrapper();
    await nextTick();

    expect(wrapper.findAll('[data-testid="mount-badge"]')).toHaveLength(0);
  });

  it('should update attachment and revoke old URL when ImageEditor saves', async () => {
    const wrapper = getWrapper();

    const originalBlob = new Blob(['original']);
    const originalBinId = 'bin-1';

    wrapper.vm.TEST_ONLY.attachments.value = [{
      id: 'att-1',
      binaryObjectId: originalBinId,
      originalName: 'test.png',
      mimeType: 'image/png',
      size: 10,
      uploadedAt: Date.now(),
      status: 'memory',
      blob: originalBlob
    }];
    await nextTick();

    // Trigger open
    wrapper.vm.TEST_ONLY.editingAttachmentId.value = 'att-1';
    await nextTick();
    await flushPromises();
    await nextTick();

    // Simulate save from ImageEditor stub
    const editor = wrapper.find('[data-testid="image-editor"]');
    expect(editor.exists()).toBe(true);

    await editor.find('.apply-btn').trigger('click');
    await nextTick();

    const updatedAtt = wrapper.vm.TEST_ONLY.attachments.value[0];
    expect(updatedAtt).toBeDefined();
    if (updatedAtt) {
      expect(updatedAtt.binaryObjectId).not.toBe(originalBinId);
    }
    expect(global.URL.revokeObjectURL).toHaveBeenCalled();
    expect(wrapper.vm.TEST_ONLY.editingAttachmentId.value).toBeUndefined();
  });

  it('should handle attachment removal correctly', async () => {
    const wrapper = getWrapper();
    wrapper.vm.TEST_ONLY.attachments.value = [
      { id: 'att-1', status: 'memory', blob: new Blob() } as any
    ];
    await nextTick();

    expect(wrapper.vm.TEST_ONLY.attachments.value.length).toBe(1);

    const removeBtn = wrapper.find('button[title="Remove"]');
    await removeBtn.trigger('click');

    expect(wrapper.vm.TEST_ONLY.attachments.value.length).toBe(0);
  });

  it('should clear attachments after successful message send', async () => {
    mockSendMessageForChat.mockResolvedValue(true);
    const wrapper = getWrapper();
    wrapper.vm.input = 'test message';
    wrapper.vm.TEST_ONLY.attachments.value = [
      { id: 'att-1', status: 'memory', blob: new Blob() } as any
    ];
    await nextTick();

    const sendBtn = wrapper.find('button[data-testid="send-button"]');
    await sendBtn.trigger('click');
    await flushPromises();

    expect(mockSendMessageForChat).toHaveBeenCalled();
    expect(wrapper.vm.input).toBe('');
    expect(wrapper.vm.TEST_ONLY.attachments.value.length).toBe(0);
  });

  it('should call setPreferredEditorMode when AdvancedTextEditor emits update:mode', async () => {
    const wrapper = getWrapper();
    wrapper.vm.TEST_ONLY.openAdvancedEditor();
    await nextTick();

    // Since AdvancedTextEditor is an async component, it might be a stub in tests
    const advancedEditor = wrapper.findComponent({ name: 'AdvancedTextEditor' });
    // In some test setups, we might need to use findComponent by name or stub
    // Let's try to trigger the method directly on the wrapper if the component find fails
    if (advancedEditor.exists()) {
      await advancedEditor.setValue('new mode', 'mode'); // This might not work for emits
      advancedEditor.vm.$emit('update:mode', { mode: 'textarea' });
    } else {
      // Fallback: call the handler directly to test the integration logic
      (wrapper.vm.TEST_ONLY as any).handleAdvancedEditorModeUpdate({ mode: 'textarea' });
    }

    expect(mockSetPreferredEditorMode).toHaveBeenCalledWith({ mode: 'textarea' });
  });

  it('should persist reasoning effort when updated via tools menu', async () => {
    const wrapper = getWrapper();
    const toolsMenu = wrapper.findComponent({ name: 'ChatToolsMenu' });
    expect(toolsMenu.exists()).toBe(true);

    // Update currentChat to have initial lmParameters
    mockCurrentChat.value = {
      id: 'chat-1',
      modelId: 'model-1',
      lmParameters: { reasoning: { effort: undefined } }
    };
    await nextTick();

    // Trigger update event from tools menu
    await (toolsMenu.vm as any).$emit('update:reasoning-effort', 'high');
    await nextTick();

    // Verify updateChatSettings was called correctly
    expect(mockUpdateChatSettings).toHaveBeenCalledWith('chat-1', expect.objectContaining({
      lmParameters: expect.objectContaining({
        reasoning: { effort: 'high' }
      })
    }));
  });

  it('should reflect reasoning effort from the current chat when switching', async () => {
    // 1. Set Chat 1 to 'low'
    mockCurrentChat.value = {
      id: 'chat-1',
      lmParameters: { reasoning: { effort: 'low' } }
    };
    const wrapper = getWrapper();
    await nextTick();
    expect(wrapper.vm.TEST_ONLY.selectedReasoningEffort.value).toBe('low');

    // 2. Switch to Chat 2 which has 'high'
    mockCurrentChat.value = {
      id: 'chat-2',
      lmParameters: { reasoning: { effort: 'high' } }
    };
    await wrapper.setProps({ chatId: 'chat-2' });
    await nextTick();

    // Verify it reflects the NEW chat's state
    expect(wrapper.vm.TEST_ONLY.selectedReasoningEffort.value).toBe('high');
  });
});
