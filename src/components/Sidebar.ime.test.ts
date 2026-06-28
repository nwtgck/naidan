import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import Sidebar from './Sidebar.vue';
import { createRouter, createWebHistory } from 'vue-router';
import { ref, computed, reactive } from 'vue';
import type { ChatGroup, ChatSummary, SidebarItem } from '@/models/types';
import { idToRaw, toChatGroupId, toChatId } from '@/models/ids';

const mockChatGroups = ref<ChatGroup[]>([]);
const mockChats = ref<ChatSummary[]>([]);
const mockSettings = reactive({
  endpoint: { type: 'openai' as const, url: 'http://localhost:11434' },
  defaultModelId: 'llama3',
});

const mockCreateChatGroup = vi.fn();
const mockRenameChatGroup = vi.fn();
const mockRenameChat = vi.fn();

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: ref(null),
    currentChatGroup: ref(null),
    streaming: ref(false),
    activeGenerations: reactive(new Map()),
    chatGroups: mockChatGroups,
    chats: mockChats,
    sidebarItems: computed<SidebarItem[]>(() => {
      const items: SidebarItem[] = [];
      mockChatGroups.value.forEach(g => items.push({ id: `chat_group:${idToRaw({ id: g.id })}`, type: 'chat_group', chatGroup: g }));
      mockChats.value.filter(c => !c.groupId).forEach(c => items.push({ id: `chat:${idToRaw({ id: c.id })}`, type: 'chat', chat: c }));
      return items;
    }),
    createChatGroup: mockCreateChatGroup,
    renameChatGroup: mockRenameChatGroup,
    renameChat: mockRenameChat,
    openChatGroup: vi.fn(),
    setChatGroupCollapsed: vi.fn(),
    persistSidebarStructure: vi.fn(),
    isTaskRunning: vi.fn().mockReturnValue(false),
    isProcessing: vi.fn().mockReturnValue(false),
    abortChat: vi.fn(),
  }),
}));

vi.mock('../composables/chat/ui/useCurrentChatState', () => ({
  useCurrentChatState: () => ({
    currentChat: computed(() => null),
    currentChatGroup: computed(() => null),
    currentChatId: computed(() => undefined),
    activeMessages: computed(() => []),
    allMessages: computed(() => []),
    resolvedSettings: computed(() => null),
    inheritedSettings: computed(() => null),
    chatGroups: computed(() => mockChatGroups.value),
    sidebarItems: computed<SidebarItem[]>(() => {
      const items: SidebarItem[] = [];
      mockChatGroups.value.forEach(g => items.push({ id: `chat_group:${idToRaw({ id: g.id })}`, type: 'chat_group', chatGroup: g }));
      mockChats.value.filter(c => !c.groupId).forEach(c => items.push({ id: `chat:${idToRaw({ id: c.id })}`, type: 'chat', chat: c }));
      return items;
    }),
    TEST_ONLY: {},
  }),
}));

vi.mock('../composables/chat/ui/useChatOrganization', () => ({
  useChatOrganization: () => ({
    createChatGroup: mockCreateChatGroup,
    deleteChatGroup: vi.fn(),
    duplicateChatGroup: vi.fn(),
    renameChatGroup: mockRenameChatGroup,
    updateChatGroupMetadata: vi.fn(),
    moveChatToGroup: vi.fn(),
    reorderSidebarChatAfterSend: vi.fn(),
    TEST_ONLY: {},
  }),
}));

vi.mock('../composables/chat/useChatMetadata', () => ({
  useChatMetadata: () => ({
    rename: ({ chatId, title }: { chatId: string, title: string }) => mockRenameChat({ id: chatId, newTitle: title }),
    TEST_ONLY: {},
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref(mockSettings),
    availableModels: ref([]),
    isFetchingModels: ref(false),
    save: vi.fn(),
  }),
}));

vi.mock('../composables/useLayout', () => ({
  useLayout: () => ({
    isSidebarOpen: ref(true),
    toggleSidebar: vi.fn(),
  }),
}));

vi.mock('vuedraggable', () => ({
  default: {
    name: 'draggable',
    template: '<div class="draggable-mock"><slot name="item" v-for="element in modelValue" :element="element"></slot></div>',
    props: ['modelValue'],
  },
}));

describe('Sidebar IME handling', () => {
  const router = createRouter({
    history: createWebHistory(),
    routes: [{ path: '/', component: { template: 'div' } }],
  });

  const globalStubs = {
    'lucide-vue-next': true,
    'Logo': true,
    'ThemeToggle': true,
    'ModelSelector': true,
  };

  beforeEach(() => {
    mockChatGroups.value = [];
    mockChats.value = [];
    vi.clearAllMocks();
  });

  it('should NOT create chat group on enter if IME is composing', async () => {
    const wrapper = mount(Sidebar, {
      global: { plugins: [router], stubs: globalStubs },
    });

    // Open creation input
    await wrapper.find('[data-testid="create-chat-group-button"]').trigger('click');
    const input = wrapper.find('[data-testid="chat-group-name-input"]');

    await input.setValue('Japanese Name');

    // Simulate Enter keyup while composing (IME confirming candidate)
    await input.trigger('keydown', {
      key: 'Enter',
      isComposing: true,
    });

    expect(mockCreateChatGroup).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="chat-group-name-input"]').exists()).toBe(true);
  });

  it('should NOT rename chat group on enter if IME is composing', async () => {
    const group: ChatGroup = { id: toChatGroupId({ raw: 'g1' }), name: 'Old Group', isCollapsed: false, updatedAt: 0, items: [] };
    mockChatGroups.value = [group];

    const wrapper = mount(Sidebar, {
      global: { plugins: [router], stubs: globalStubs },
    });

    // @ts-expect-error - access internal sync
    wrapper.vm.syncLocalItems();
    await wrapper.vm.$nextTick();

    // Start editing
    await wrapper.find('button[class*="hover:text-blue-600"]').trigger('click'); // Pencil button for group

    const input = wrapper.find('[data-testid="chat-group-rename-input"]');
    expect(input.exists()).toBe(true);

    await input.setValue('New Group Name');

    // Simulate Enter keydown while composing
    await input.trigger('keydown', {
      key: 'Enter',
      isComposing: true,
    });

    expect(mockRenameChatGroup).not.toHaveBeenCalled();
    expect(input.exists()).toBe(true);
  });

  it('should NOT rename chat on enter if IME is composing', async () => {
    const chat: ChatSummary = { id: toChatId({ raw: 'c1' }), title: 'Old Chat', updatedAt: 0 };
    mockChats.value = [chat];

    const wrapper = mount(Sidebar, {
      global: { plugins: [router], stubs: globalStubs },
    });

    // @ts-expect-error - access internal sync
    wrapper.vm.syncLocalItems();
    await wrapper.vm.$nextTick();

    // Start editing
    await wrapper.find('button[class*="hover:text-blue-600"]').trigger('click'); // Pencil button for chat

    const input = wrapper.find('[data-testid="chat-rename-input"]');
    expect(input.exists()).toBe(true);

    await input.setValue('New Chat Title');

    // Simulate Enter keyup while composing
    await input.trigger('keydown', {
      key: 'Enter',
      isComposing: true,
    });

    expect(mockRenameChat).not.toHaveBeenCalled();
    expect(input.exists()).toBe(true);
  });
});
