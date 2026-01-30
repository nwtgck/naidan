import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import Sidebar from './Sidebar.vue';
import { createRouter, createWebHistory } from 'vue-router';
import { ref, computed, nextTick, reactive } from 'vue';
import type { ChatSummary, SidebarItem } from '../models/types';

const mockChats = ref<ChatSummary[]>([]);
const mockActiveGenerations = reactive(new Map());

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
    currentChat: ref(null),
    currentChatGroup: ref(null),
    streaming: computed(() => mockActiveGenerations.size > 0),
    activeGenerations: mockActiveGenerations,
    chatGroups: ref([]),
    chats: mockChats,
    sidebarItems: computed<SidebarItem[]>(() => {
      return mockChats.value.map(c => ({ id: `chat:${c.id}`, type: 'chat', chat: c }));
    }),
    loadChats: vi.fn(),
    createChatGroup: vi.fn(),
    openChat: vi.fn(),
    openChatGroup: vi.fn(),
    setChatGroupCollapsed: vi.fn(),
    persistSidebarStructure: vi.fn(),

    deleteAllChats: vi.fn(),
    isTaskRunning: (id: string) => mockActiveGenerations.has(id),
    isProcessing: (id: string) => mockActiveGenerations.has(id),
    abortChat: vi.fn(),
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref({ endpointUrl: 'http://localhost' }),
    availableModels: ref([]),
    isFetchingModels: ref(false),
    save: vi.fn(),
  }),
}));

vi.mock('../composables/useTheme', () => ({
  useTheme: () => ({
    themeMode: ref('dark'),
    setTheme: vi.fn(),
  }),
}));

vi.mock('lucide-vue-next', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    Loader2: { template: '<div class="loader-mock animate-spin"></div>' },
  };
});

describe('Sidebar Streaming Indicators', () => {
  const router = createRouter({
    history: createWebHistory(),
    routes: [{ path: '/', component: { template: 'div' } }],
  });

  const globalStubs = {
    'Logo': true,
    'ThemeToggle': true,
    'ModelSelector': true,
  };

  beforeEach(() => {
    mockChats.value = [
      { id: 'chat-1', title: 'Chat 1', updatedAt: 0 },
      { id: 'chat-2', title: 'Chat 2', updatedAt: 0 },
    ];
    mockActiveGenerations.clear();
    vi.clearAllMocks();
  });

  it('should display a loading spinner for a chat that is currently streaming', async () => {
    // Set chat-1 as active/streaming
    mockActiveGenerations.set('chat-1', { controller: new AbortController(), chat: { id: 'chat-1' } });

    const wrapper = mount(Sidebar, {
      global: { plugins: [router], stubs: globalStubs },
    });
    
    // Manually trigger sync because watch/onMounted might be tricky in this test setup
    const vm = wrapper.vm as any;
    vm.sidebarItemsLocal = [
      { id: 'chat:chat-1', type: 'chat', chat: { id: 'chat-1', title: 'Chat 1', updatedAt: 0 } },
      { id: 'chat:chat-2', type: 'chat', chat: { id: 'chat-2', title: 'Chat 2', updatedAt: 0 } },
    ];
    await nextTick();

    const chatItems = wrapper.findAll('.sidebar-chat-item');
    const chat1Item = chatItems.find(i => i.text().includes('Chat 1'));
    expect(chat1Item?.exists()).toBe(true);
    expect(chat1Item?.find('.loader-mock').exists()).toBe(true);

    const chat2Item = chatItems.find(i => i.text().includes('Chat 2'));
    expect(chat2Item?.find('.loader-mock').exists()).toBe(false);
  });

  it('should update indicators when streaming state changes', async () => {
    const wrapper = mount(Sidebar, {
      global: { plugins: [router], stubs: globalStubs },
    });
    const vm = wrapper.vm as any;
    vm.sidebarItemsLocal = [
      { id: 'chat:chat-1', type: 'chat', chat: { id: 'chat-1', title: 'Chat 1', updatedAt: 0 } },
      { id: 'chat:chat-2', type: 'chat', chat: { id: 'chat-2', title: 'Chat 2', updatedAt: 0 } },
    ];
    await nextTick();

    expect(wrapper.find('.loader-mock').exists()).toBe(false);

    // Start streaming for chat-2
    mockActiveGenerations.set('chat-2', { controller: new AbortController(), chat: { id: 'chat-2' } });
    await nextTick();

    const chat2Item = wrapper.findAll('.sidebar-chat-item').find(i => i.text().includes('Chat 2'));
    expect(chat2Item?.find('.loader-mock').exists()).toBe(true);

    // Stop streaming
    mockActiveGenerations.delete('chat-2');
    await nextTick();

    expect(wrapper.find('.loader-mock').exists()).toBe(false);
  });
});
