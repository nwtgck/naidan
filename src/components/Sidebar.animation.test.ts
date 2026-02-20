import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mount } from '@vue/test-utils';
import Sidebar from './Sidebar.vue';
import { ref, reactive, nextTick } from 'vue';
import { useRouter, useRoute } from 'vue-router';

vi.mock('vue-router', () => ({
  useRouter: vi.fn(),
  useRoute: vi.fn(),
}));

vi.mock('lucide-vue-next', () => {
  const mockIcon = { render: () => null };
  return {
    __esModule: true,
    ChevronDown: mockIcon,
    ChevronUp: mockIcon,
    ChevronRight: mockIcon,
    Folder: mockIcon,
    Pencil: mockIcon,
    Trash2: mockIcon,
    SquarePen: mockIcon,
    SettingsIcon: mockIcon,
    Settings: mockIcon,
    Bot: mockIcon,
    Loader2: mockIcon,
    Moon: mockIcon,
    Sun: mockIcon,
    Menu: mockIcon,
    PanelLeft: mockIcon,
    Plus: mockIcon,
    Search: mockIcon,
    History: mockIcon,
    User: mockIcon,
    Github: mockIcon,
    Download: mockIcon,
    Upload: mockIcon,
    Database: mockIcon,
    Wrench: mockIcon,
    Info: mockIcon,
    Cpu: mockIcon,
    Network: mockIcon,
    Clock: mockIcon,
    LogOut: mockIcon,
    FolderPlus: mockIcon,
    MessageSquare: mockIcon,
    Layout: mockIcon,
    ExternalLink: mockIcon,
    Copy: mockIcon,
    Check: mockIcon,
    X: mockIcon,
    AlertCircle: mockIcon,
    MoreVertical: mockIcon,
    MoreHorizontal: mockIcon,
    ArrowUp: mockIcon,
    ArrowDown: mockIcon,
    ArrowLeft: mockIcon,
    ArrowRight: mockIcon,
    RefreshCw: mockIcon,
    Terminal: mockIcon,
    Key: mockIcon,
    Globe: mockIcon,
    Lock: mockIcon,
    Shield: mockIcon,
    Eye: mockIcon,
    EyeOff: mockIcon,
    FileText: mockIcon,
    Image: mockIcon,
    File: mockIcon,
    FolderOpen: mockIcon,
    Share2: mockIcon,
    Zap: mockIcon,
    Send: mockIcon,
    Mic: mockIcon,
    StopCircle: mockIcon,
    Play: mockIcon,
    Pause: mockIcon,
    Volume2: mockIcon,
    VolumeX: mockIcon,
    Languages: mockIcon,
    Sparkles: mockIcon,
    Box: mockIcon,
    Command: mockIcon,
    Hash: mockIcon,
    AtSign: mockIcon,
    Tag: mockIcon,
    Calendar: mockIcon,
    Heart: mockIcon,
    Star: mockIcon,
    Bookmark: mockIcon,
    Filter: mockIcon,
    List: mockIcon,
    Grid: mockIcon,
    Maximize2: mockIcon,
    Minimize2: mockIcon,
    Monitor: mockIcon,
    HardDrive: mockIcon,
    Package: mockIcon,
  };
});

const mockChatGroups = ref<any[]>([]);
const mockChats = ref<any[]>([]);
const mockSidebarItems = ref<any[]>([]);

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
    currentChat: ref(null),
    currentChatGroup: ref(null),
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