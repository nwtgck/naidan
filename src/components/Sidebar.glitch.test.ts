import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import Sidebar from './Sidebar.vue';
import { createRouter, createWebHistory } from 'vue-router';
import { ref, computed, nextTick, reactive } from 'vue';
import type { ChatSummary, SidebarItem } from '@/models/types';

const mockChats = ref<ChatSummary[]>([]);
const mockActiveTasks = reactive(new Set<string>());
const mockCurrentChat = ref(null);
const mockCurrentChatGroup = ref(null);

vi.mock('../composables/useLayout', () => ({
  useLayout: () => ({
    isSidebarOpen: ref(true),
    activeFocusArea: ref('chat'),
    setActiveFocusArea: vi.fn(),
    toggleSidebar: vi.fn(),
  }),
}));

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: mockCurrentChat,
    currentChatGroup: mockCurrentChatGroup,
    chatGroups: ref([]),
    chats: mockChats,
    sidebarItems: computed<SidebarItem[]>(() => {
      return mockChats.value.map(c => ({ id: `chat:${c.id}`, type: 'chat', chat: c }));
    }),
    isTaskRunning: ({ chatId }: { chatId: string }) => Array.from(mockActiveTasks).some(t => t.endsWith(':' + chatId)),
    isProcessing: ({ chatId }: { chatId: string }) => Array.from(mockActiveTasks).some(t => t.startsWith('process:') && t.endsWith(':' + chatId)),
    openChat: vi.fn(),
    openChatGroup: vi.fn(),
  }),
}));

vi.mock('../composables/chat/ui/useSidebarData', () => ({
  useSidebarData: () => ({
    currentChat: computed(() => mockCurrentChat.value),
    currentChatGroup: computed(() => mockCurrentChatGroup.value),
    sidebarItems: computed<SidebarItem[]>(() => {
      return mockChats.value.map(c => ({ id: `chat:${c.id}`, type: 'chat', chat: c }));
    }),
    chatGroups: computed(() => []),
    isProcessing: ({ chatId }: { chatId: string }) =>
      Array.from(mockActiveTasks).some(task => task.startsWith('process:') && task.endsWith(`:${chatId}`)),
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
    currentChatId: computed(() => undefined),
    activeMessages: computed(() => []),
    allMessages: computed(() => []),
    resolvedSettings: computed(() => null),
    inheritedSettings: computed(() => null),
    chatGroups: computed(() => []),
    sidebarItems: computed<SidebarItem[]>(() => mockChats.value.map(c => ({ id: `chat:${c.id}`, type: 'chat', chat: c }))),
    TEST_ONLY: {},
  }),
}));

vi.mock('../composables/chat/global/chat-core-singletons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../composables/chat/global/chat-core-singletons')>();
  return {
    ...actual,
    isProcessing: ({ chatId }: { chatId: string }) =>
      Array.from(mockActiveTasks).some(task => task.startsWith('process:') && task.endsWith(`:${chatId}`)),
  };
});

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref({ endpointUrl: 'http://localhost' }),
    availableModels: ref([]),
    isFetchingModels: ref(false),
  }),
}));

vi.mock('../composables/useConfirm', () => ({
  useConfirm: () => ({
    showConfirm: vi.fn(),
  }),
}));

vi.mock('lucide-vue-next', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    Loader2Icon: { template: '<div class="loader-mock animate-spin"></div>' },
  };
});

describe('Sidebar Glitch Reproduction', () => {
  const router = createRouter({
    history: createWebHistory(),
    routes: [{ path: '/', component: { template: 'div' } }],
  });

  const globalStubs = {
    'Logo': true,
    'ThemeToggle': true,
    'ModelSelector': true,
    'draggable': {
      template: '<div><slot name="item" v-for="item in modelValue" :element="item" :index="0"></slot></div>',
      props: ['modelValue']
    }
  };

  beforeEach(() => {
    mockChats.value = [
      { id: 'chat-1', title: 'Chat 1', updatedAt: 0 },
      { id: 'chat-2', title: 'Chat 2', updatedAt: 0 },
    ];
    mockActiveTasks.clear();
    vi.clearAllMocks();
  });

  it('should show spinner when a "fetch" task is running if Sidebar uses isTaskRunning', async () => {
    const wrapper = mount(Sidebar, {
      global: { plugins: [router], stubs: globalStubs },
    });

    // Manually trigger sync
    const vm = wrapper.vm as any;
    vm.sidebarItemsLocal = [
      { id: 'chat:chat-1', type: 'chat', chat: { id: 'chat-1', title: 'Chat 1', updatedAt: 0 } },
      { id: 'chat:chat-2', type: 'chat', chat: { id: 'chat-2', title: 'Chat 2', updatedAt: 0 } },
    ];
    await nextTick();

    // No spinner initially
    expect(wrapper.find('.loader-mock').exists()).toBe(false);

    // Simulate opening chat-1 which triggers a fetch task
    mockActiveTasks.add('fetch:chat-1');
    await nextTick();

    const chat1Item = wrapper.findAll('.sidebar-chat-item').find(i => i.text().includes('Chat 1'));
    // DESIRED BEHAVIOR: It should NOT show the spinner for fetch task
    expect(chat1Item?.find('.loader-mock').exists()).toBe(false);

    // But it SHOULD show for process task
    mockActiveTasks.add('process:chat-1');
    await nextTick();
    expect(chat1Item?.find('.loader-mock').exists()).toBe(true);
  });
});
