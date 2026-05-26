import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mount } from '@vue/test-utils';
import Sidebar from './Sidebar.vue';
import { ref, reactive, nextTick, computed } from 'vue';
import { useRouter, useRoute } from 'vue-router';
vi.mock('vue-router', () => ({
  useRouter: vi.fn(),
  useRoute: vi.fn(),
}));

vi.mock('lucide-vue-next', () => {
  const mockIcon = { render: () => null };
  return {
    __esModule: true,
    ChevronDownIcon: mockIcon,
    ChevronUpIcon: mockIcon,
    ChevronRightIcon: mockIcon,
    FolderIcon: mockIcon,
    PencilIcon: mockIcon,
    Trash2Icon: mockIcon,
    SquarePenIcon: mockIcon,
    SettingsIcon: mockIcon,
    BotIcon: mockIcon,
    Loader2Icon: mockIcon,
    MoonIcon: mockIcon,
    SunIcon: mockIcon,
    MenuIcon: mockIcon,
    PanelLeftIcon: mockIcon,
    PlusIcon: mockIcon,
    SearchIcon: mockIcon,
    HistoryIcon: mockIcon,
    UserIcon: mockIcon,
    GithubIcon: mockIcon,
    DownloadIcon: mockIcon,
    UploadIcon: mockIcon,
    DatabaseIcon: mockIcon,
    WrenchIcon: mockIcon,
    InfoIcon: mockIcon,
    MessageSquarePlusIcon: mockIcon,
    CpuIcon: mockIcon,
    NetworkIcon: mockIcon,
    ClockIcon: mockIcon,
    LogOutIcon: mockIcon,
    FolderPlusIcon: mockIcon,
    MessageSquareIcon: mockIcon,
    LayoutIcon: mockIcon,
    ExternalLinkIcon: mockIcon,
    CopyIcon: mockIcon,
    CheckIcon: mockIcon,
    XIcon: mockIcon,
    AlertCircleIcon: mockIcon,
    MoreVerticalIcon: mockIcon,
    MoreHorizontalIcon: mockIcon,
    ArrowUp: mockIcon,
    ArrowDownIcon: mockIcon,
    ArrowLeftIcon: mockIcon,
    ArrowRightIcon: mockIcon,
    RefreshCwIcon: mockIcon,
    TerminalIcon: mockIcon,
    Key: mockIcon,
    GlobeIcon: mockIcon,
    LockIcon: mockIcon,
    Shield: mockIcon,
    EyeIcon: mockIcon,
    EyeOffIcon: mockIcon,
    FileTextIcon: mockIcon,
    ImageIcon: mockIcon,
    File: mockIcon,
    FolderOpenIcon: mockIcon,
    Share2: mockIcon,
    ZapIcon: mockIcon,
    SendIcon: mockIcon,
    Mic: mockIcon,
    StopCircle: mockIcon,
    PlayIcon: mockIcon,
    PauseIcon: mockIcon,
    Volume2Icon: mockIcon,
    VolumeX: mockIcon,
    LanguagesIcon: mockIcon,
    Sparkles: mockIcon,
    BoxIcon: mockIcon,
    Command: mockIcon,
    Hash: mockIcon,
    AtSign: mockIcon,
    Tag: mockIcon,
    Calendar: mockIcon,
    Heart: mockIcon,
    Star: mockIcon,
    Bookmark: mockIcon,
    FilterIcon: mockIcon,
    ListIcon: mockIcon,
    Grid: mockIcon,
    Maximize2Icon: mockIcon,
    Minimize2Icon: mockIcon,
    MonitorIcon: mockIcon,
    HardDriveIcon: mockIcon,
    Package: mockIcon,
    GhostIcon: mockIcon,
    MessageSquarePlus: mockIcon,
  };
});

const mockChatGroups = ref<any[]>([]);
const mockChats = ref<any[]>([]);
const mockSidebarItems = ref<any[]>([]);
const mockCurrentChat = ref(null);
const mockCurrentChatGroup = ref(null);
const mockIsProcessing = vi.fn().mockReturnValue(false);

vi.mock('../composables/useLayout', () => ({
  useLayout: () => ({
    isSidebarOpen: ref(true),
    isDebugOpen: ref(false),
    activeFocusArea: ref('sidebar'),
    setActiveFocusArea: vi.fn(),
    toggleSidebar: vi.fn(),
    toggleDebug: vi.fn(),
  }),
}));

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: mockCurrentChat,
    currentChatGroup: mockCurrentChatGroup,
    streaming: ref(false),
    activeGenerations: reactive(new Map()),
    chatGroups: mockChatGroups,
    chats: mockChats,
    sidebarItems: mockSidebarItems,
    loadChats: vi.fn(),
    deleteChat: vi.fn(),
    renameChat: vi.fn(),
    createChatGroup: vi.fn(),
    deleteChatGroup: vi.fn(),
    renameChatGroup: vi.fn(),
    setChatGroupCollapsed: vi.fn(),
    persistSidebarStructure: vi.fn(),
    isProcessing: vi.fn().mockReturnValue(false),
  }),
}));

vi.mock('../composables/chat/ui/useSidebarData', () => ({
  useSidebarData: () => ({
    currentChat: mockCurrentChat,
    currentChatGroup: mockCurrentChatGroup,
    sidebarItems: mockSidebarItems,
    chatGroups: mockChatGroups,
    isProcessing: mockIsProcessing,
    persistSidebarStructure: vi.fn(),
    setChatGroupCollapsed: vi.fn(),
    createChatGroup: vi.fn(),
    deleteChatGroup: vi.fn(),
    createNewChat: vi.fn(),
    openChat: vi.fn(),
    openChatGroup: vi.fn(),
    deleteChat: vi.fn(),
    renameChat: vi.fn(),
    renameChatGroup: vi.fn(),
    duplicateChatGroup: vi.fn(),
  }),
}));

vi.mock('../composables/chat/ui/useCurrentChatState', () => ({
  useCurrentChatState: () => ({
    currentChat: computed(() => mockCurrentChat.value),
    currentChatGroup: computed(() => mockCurrentChatGroup.value),
    currentChatId: computed(() => (mockCurrentChat.value as { id?: string } | null)?.id),
    activeMessages: computed(() => []),
    allMessages: computed(() => []),
    resolvedSettings: computed(() => null),
    inheritedSettings: computed(() => null),
    chatGroups: computed(() => mockChatGroups.value),
    sidebarItems: computed(() => mockSidebarItems.value),
    TEST_ONLY: {},
  }),
}));

vi.mock('../composables/chat/ui/useChatNavigation', () => ({
  useChatNavigation: () => ({
    openChat: vi.fn(),
    openChatAtMessage: vi.fn(),
    openChatGroup: vi.fn(),
    TEST_ONLY: {},
  }),
}));

vi.mock('../composables/chat/ui/useSidebarStructure', () => ({
  useSidebarStructure: () => ({
    persistSidebarStructure: vi.fn(),
    setChatGroupCollapsed: vi.fn(),
    TEST_ONLY: {},
  }),
}));

vi.mock('../composables/chat/ui/useChatLifecycle', () => ({
  useChatLifecycle: () => ({
    createNewChat: vi.fn(),
    deleteChat: vi.fn(),
    deleteAllChats: vi.fn(),
    TEST_ONLY: {},
  }),
}));

vi.mock('../composables/chat/ui/useChatOrganization', () => ({
  useChatOrganization: () => ({
    createChatGroup: vi.fn(),
    deleteChatGroup: vi.fn(),
    duplicateChatGroup: vi.fn(),
    renameChatGroup: vi.fn(),
    updateChatGroupMetadata: vi.fn(),
    moveChatToGroup: vi.fn(),
    reorderSidebarChatAfterSend: vi.fn(),
    TEST_ONLY: {},
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: reactive({ endpointUrl: 'http://localhost' }),
    availableModels: ref([]),
    isFetchingModels: ref(false),
    updateGlobalModel: vi.fn(),
  }),
}));

describe('Sidebar Animation Logic', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (useRouter as Mock).mockReturnValue({ push: vi.fn() });
    (useRoute as Mock).mockReturnValue({ path: '/', query: {}, params: {} });

    const items = [
      { id: 'c1', title: 'Chat 1' },
      { id: 'c2', title: 'Chat 2' },
      { id: 'c3', title: 'Chat 3' },
      { id: 'c4', title: 'Chat 4' },
      { id: 'c5', title: 'Chat 5' },
      { id: 'c6', title: 'Chat 6' },
      { id: 'c7', title: 'Chat 7' },
    ].map(c => ({ id: c.id, type: 'chat', chat: c }));

    const group = {
      id: 'g1',
      name: 'Test Group',
      isCollapsed: false,
      items: items
    };

    mockChatGroups.value = [group];
    mockSidebarItems.value = [
      { id: 'g1', type: 'chat_group', chatGroup: group }
    ];
  });

  it('maintains items in DOM during collapse animation delay', async () => {
    const wrapper = mount(Sidebar, {
      global: {
        stubs: {
          'router-link': true,
          'draggable': {
            template: '<div><slot name="item" v-for="item in $attrs.modelValue" :element="item"></slot></div>'
          },
          'ThemeToggle': true,
          'ModelSelector': true
        }
      }
    });

    await nextTick();

    // Initially compact (5 items)
    expect(wrapper.findAll('.sidebar-chat-item')).toHaveLength(5);

    // Expand
    const showMoreBtn = wrapper.find('[data-testid="show-more-button"]');
    await showMoreBtn.trigger('click');
    expect(wrapper.findAll('.sidebar-chat-item')).toHaveLength(7);

    // Collapse (Show less)
    await showMoreBtn.trigger('click');

    // Should STILL have 7 items immediately after clicking (due to collapsingGroupIds)
    expect(wrapper.findAll('.sidebar-chat-item')).toHaveLength(7);

    // Advance time by 200ms (halfway through 400ms transition)
    vi.advanceTimersByTime(200);
    await nextTick();
    expect(wrapper.findAll('.sidebar-chat-item')).toHaveLength(7);

    // Advance time to 401ms (after transition)
    vi.advanceTimersByTime(201);
    await nextTick();

    // Now it should be back to 5
    expect(wrapper.findAll('.sidebar-chat-item')).toHaveLength(5);
  });
});
