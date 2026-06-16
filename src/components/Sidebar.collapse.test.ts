import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import Sidebar from './Sidebar.vue';
import { createRouter, createWebHistory } from 'vue-router';
import { ref, nextTick, reactive, computed } from 'vue';
import { useLayout } from '@/composables/useLayout';
import type { ChatGroup, SidebarItem } from '@/models/types';
import { toChatGroupId, toChatId } from '@/models/ids';

vi.mock('@/utils/dom', () => ({
  scrollIntoViewSafe: vi.fn(),
}));

const mockCurrentChat = ref<{ id: string; groupId?: string | null } | null>(null);
const mockCurrentChatGroup = ref<{ id: string } | null>(null);
const mockChatGroups = ref<ChatGroup[]>([]);
const mockSidebarItems = ref<SidebarItem[]>([
  { id: 'chat:1', type: 'chat', chat: { id: toChatId({ raw: '1' }), title: 'Test Chat', updatedAt: 0 } },
]);
const mockOpenChat = vi.fn();
const mockOpenChatGroup = vi.fn();
const mockCreateNewChat = vi.fn();
const mockSetChatGroupCollapsed = vi.fn();

vi.mock('vuedraggable', () => ({
  default: {
    name: 'draggable',
    template: '<div class="draggable-mock"><slot name="item" v-for="element in modelValue" :element="element"></slot></div>',
    props: ['modelValue'],
  },
}));

vi.mock('../composables/useLayout', () => ({
  useLayout: vi.fn(() => ({
    isSidebarOpen: ref(true),
    activeFocusArea: ref('chat'),
    setActiveFocusArea: vi.fn(),
    toggleSidebar: vi.fn(),
  })),
}));

vi.mock('../composables/useChat', () => ({
  useChat: vi.fn(() => ({
    currentChat: mockCurrentChat,
    currentChatGroup: mockCurrentChatGroup,
    streaming: ref(false),
    activeGenerations: reactive(new Map()),
    chatGroups: mockChatGroups,
    chats: ref([{ id: '1', title: 'Test Chat', updatedAt: 0 }]),
    sidebarItems: mockSidebarItems,
    loadChats: vi.fn(),
    openChat: mockOpenChat,
    openChatGroup: mockOpenChatGroup,
    createNewChat: mockCreateNewChat,
    setChatGroupCollapsed: mockSetChatGroupCollapsed,
    persistSidebarStructure: vi.fn(),
    isTaskRunning: vi.fn().mockReturnValue(false),
    isProcessing: vi.fn().mockReturnValue(false),
    abortChat: vi.fn(),
  })),
}));

vi.mock('../composables/chat/ui/useCurrentChatState', () => ({
  useCurrentChatState: () => ({
    currentChat: computed(() => mockCurrentChat.value),
    currentChatGroup: computed(() => mockCurrentChatGroup.value),
    currentChatId: computed(() => mockCurrentChat.value?.id),
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
    openChat: ({ chatId }: { chatId: string; leafId?: string }) => mockOpenChat({ id: chatId }),
    openChatAtMessage: vi.fn(),
    openChatGroup: ({ groupId }: { groupId: string | null }) => mockOpenChatGroup({ id: groupId }),
    TEST_ONLY: {},
  }),
}));

vi.mock('../composables/chat/ui/useChatLifecycle', () => ({
  useChatLifecycle: () => ({
    createNewChat: mockCreateNewChat,
    deleteChat: vi.fn(),
    deleteAllChats: vi.fn(),
    TEST_ONLY: {},
  }),
}));

vi.mock('../composables/chat/ui/useSidebarStructure', () => ({
  useSidebarStructure: () => ({
    persistSidebarStructure: vi.fn(),
    setChatGroupCollapsed: ({ groupId, isCollapsed }: { groupId: string; isCollapsed: boolean }) =>
      mockSetChatGroupCollapsed({ groupId, isCollapsed }),
    TEST_ONLY: {},
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref({ endpointUrl: 'http://localhost' }),
    availableModels: ref([]),
    isFetchingModels: ref(false),
    save: vi.fn(),
    updateGlobalModel: vi.fn(),
  }),
}));

vi.mock('../composables/useTheme', () => ({
  useTheme: () => ({
    themeMode: ref('dark'),
    setTheme: vi.fn(),
  }),
}));

describe('Sidebar Collapse Functionality', () => {
  const router = createRouter({
    history: createWebHistory(),
    routes: [{ path: '/', component: { template: 'div' } }],
  });

  const isSidebarOpen = ref(true);

  beforeEach(() => {
    isSidebarOpen.value = true;
    mockCurrentChat.value = null;
    mockCurrentChatGroup.value = null;
    mockChatGroups.value = [];
    mockSidebarItems.value = [
      { id: 'chat:1', type: 'chat', chat: { id: toChatId({ raw: '1' }), title: 'Test Chat', updatedAt: 0 } },
    ];
    vi.clearAllMocks();
    (useLayout as any).mockReturnValue({
      isSidebarOpen,
      activeFocusArea: ref('chat'),
      setActiveFocusArea: vi.fn(),
      toggleSidebar: vi.fn(),
    });
  });

  it('toggles isSidebarOpen when the toggle button is clicked', async () => {
    const toggleSidebar = vi.fn(() => {
      isSidebarOpen.value = !isSidebarOpen.value;
    });
    (useLayout as any).mockReturnValue({
      isSidebarOpen,
      activeFocusArea: ref('chat'),
      setActiveFocusArea: vi.fn(),
      toggleSidebar,
    });

    const wrapper = mount(Sidebar, {
      global: { plugins: [router], stubs: { 'lucide-vue-next': true, 'Logo': true } },
    });

    const toggleBtn = wrapper.find('[data-testid="sidebar-toggle"]');
    await toggleBtn.trigger('click');
    expect(toggleSidebar).toHaveBeenCalled();
    expect(isSidebarOpen.value).toBe(false);
  });

  it('hides elements when collapsed', async () => {
    isSidebarOpen.value = false;
    const wrapper = mount(Sidebar, {
      global: { plugins: [router], stubs: { 'lucide-vue-next': true, 'Logo': true } },
    });
    await nextTick();

    // Logo should be hidden
    expect(wrapper.find('logo-stub').exists()).toBe(false);

    // Title should be hidden
    expect(wrapper.find('h1').exists()).toBe(false);

    // Chat list (nav) content should be hidden (using template v-if)
    const nav = wrapper.find('[data-testid="sidebar-nav"]');
    expect(nav.text()).toBe('');

    // Version text in footer should be hidden
    expect(wrapper.text()).not.toContain('v0.1.0');

    // New Chat button should NOT have text
    const newChatBtn = wrapper.find('[data-testid="new-chat-button"]');
    expect(newChatBtn.text()).not.toContain('New Chat');
  });

  it('shows elements when expanded', async () => {
    isSidebarOpen.value = true;
    const wrapper = mount(Sidebar, {
      global: { plugins: [router], stubs: { 'lucide-vue-next': true, 'Logo': true } },
    });
    await nextTick();

    expect(wrapper.find('logo-stub').exists()).toBe(true);
    expect(wrapper.find('h1').exists()).toBe(true);
    const nav = wrapper.find('[data-testid="sidebar-nav"]');
    expect(nav.text()).not.toBe('');
    expect(wrapper.text()).toContain('New Chat');
  });

  it('applies correct sizing classes in collapsed mode', async () => {
    isSidebarOpen.value = false;
    const wrapper = mount(Sidebar, {
      global: { plugins: [router], stubs: { 'lucide-vue-next': true, 'Logo': true } },
    });
    await nextTick();

    const newChatBtn = wrapper.find('[data-testid="new-chat-button"]');
    expect(newChatBtn.classes()).toContain('w-8');
    expect(newChatBtn.classes()).toContain('h-8');

    const settingsBtn = wrapper.find('button[title="Settings"]');
    expect(settingsBtn.classes()).toContain('w-8');
    expect(settingsBtn.classes()).toContain('h-8');
  });

  it('shows "New Chat in Group" button when collapsed and a group is active', async () => {
    isSidebarOpen.value = false;
    mockCurrentChat.value = { id: '1', groupId: 'group1' };
    mockCurrentChatGroup.value = null;
    mockChatGroups.value = [{ id: toChatGroupId({ raw: 'group1' }), name: 'Test Group', isCollapsed: false, updatedAt: 0, items: [] }];

    const wrapper = mount(Sidebar, {
      global: { plugins: [router], stubs: { 'lucide-vue-next': true, 'Logo': true } },
    });
    await nextTick();

    const groupBtn = wrapper.find('[data-testid="new-chat-in-group-button"]');
    expect(groupBtn.exists()).toBe(true);

    await groupBtn.trigger('click');
    expect(mockCreateNewChat).toHaveBeenCalledWith(expect.objectContaining({ groupId: 'group1' }));
  });

  it('hides "New Chat in Group" button when sidebar is open', async () => {
    isSidebarOpen.value = true;
    mockCurrentChat.value = { id: '1', groupId: 'group1' };
    mockCurrentChatGroup.value = null;
    mockChatGroups.value = [{ id: toChatGroupId({ raw: 'group1' }), name: 'Test Group', isCollapsed: false, updatedAt: 0, items: [] }];

    const wrapper = mount(Sidebar, {
      global: { plugins: [router], stubs: { 'lucide-vue-next': true, 'Logo': true } },
    });
    await nextTick();

    const groupBtn = wrapper.find('[data-testid="new-chat-in-group-button"]');
    expect(groupBtn.exists()).toBe(false);
  });
});
