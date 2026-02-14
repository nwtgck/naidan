import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref, defineComponent } from 'vue';
import App from './App.vue';
import { createRouter, createWebHistory } from 'vue-router';
import type { Chat } from './models/types';

// Mock ChatArea to track mounting/unmounting
const mountSpy = vi.fn();
const unmountSpy = vi.fn();

const MockChatArea = defineComponent({
  name: 'ChatArea', // Needs to match if we want to mimic real component name, though usually not strict
  template: '<div data-testid="chat-area">Chat Content</div>',
  mounted() {
    mountSpy();
  },
  unmounted() {
    unmountSpy();
  }
});

// Create a real router instance for the test
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: MockChatArea },
    { path: '/chat/:id', component: MockChatArea }
  ]
});

// Mock Composables
const mockCreateNewChat = vi.fn();
const mockCurrentChat = ref<Chat | null>(null);
const mockChats = ref<Chat[]>([]);
const mockChatGroups = ref<any[]>([]);

vi.mock('./composables/useChat', () => ({
  useChat: () => ({
    createNewChat: mockCreateNewChat,
    createChatGroup: vi.fn(),
    loadChats: vi.fn(),
    currentChat: mockCurrentChat,
    currentChatGroup: ref(null),
    chats: mockChats,
    chatGroups: mockChatGroups,
    isProcessing: () => false,
    sidebarItems: ref([]),
    persistSidebarStructure: vi.fn(),
    openChat: async (id: string) => {
      mockCurrentChat.value = { id } as Chat;
    },
  }),
}));

vi.mock('./composables/useSettings', () => ({
  useSettings: () => ({
    init: vi.fn(),
    initialized: ref(true),
    isOnboardingDismissed: ref(true),
    isFetchingModels: ref(false),
    settings: ref({ endpointUrl: 'http://localhost:11434' }),
    availableModels: ref([]),
  }),
}));

vi.mock('./composables/useConfirm', () => ({
  useConfirm: () => ({
    isConfirmOpen: ref(false),
    confirmTitle: ref(''),
    confirmMessage: ref(''),
    confirmConfirmButtonText: ref(''),
    confirmCancelButtonText: ref(''),
    confirmButtonVariant: ref('default'),
    handleConfirm: vi.fn(),
    handleCancel: vi.fn(),
    showConfirm: vi.fn(),
  }),
}));

vi.mock('./composables/usePrompt', () => ({
  usePrompt: () => ({
    isPromptOpen: ref(false),
    promptTitle: ref(''),
    promptMessage: ref(''),
    promptInputValue: ref(''),
    handlePromptConfirm: vi.fn(),
    handlePromptCancel: vi.fn(),
  }),
}));

vi.mock('./composables/useLayout', () => ({
  useLayout: () => ({
    isSidebarOpen: ref(true),
    activeFocusArea: ref('chat'),
    setActiveFocusArea: vi.fn(),
    toggleSidebar: vi.fn(),
  }),
}));

vi.mock('./composables/useOPFSExplorer', () => ({
  useOPFSExplorer: () => ({
    isOPFSOpen: ref(false),
  }),
}));

// Mock sub-components
vi.mock('./components/Sidebar.vue', () => ({
  default: {
    template: '<div data-testid="sidebar"></div>',
    emits: ['open-settings']
  }
}));

vi.mock('./components/OnboardingModal.vue', () => ({ default: { template: '<div></div>' } }));
vi.mock('./components/ToastContainer.vue', () => ({ default: { template: '<div></div>' } }));
vi.mock('./components/SettingsModal.vue', () => ({ default: { template: '<div></div>' } }));
vi.mock('./components/DebugPanel.vue', () => ({ default: { template: '<div></div>' } }));
vi.mock('./components/CustomDialog.vue', () => ({ default: { template: '<div></div>' } }));
vi.mock('./components/OPFSExplorer.vue', () => ({ default: { template: '<div></div>' } }));

describe('App Navigation & Regression Tests', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mountSpy.mockClear();
    unmountSpy.mockClear();
    mockCurrentChat.value = null;
    mockChats.value = [];
    await router.push('/');
    await router.isReady();
  });

  it('reuses component on route change between chats to prevent flickering', async () => {
    mount(App, {
      global: {
        plugins: [router],
        stubs: {
          'transition': false,
          'SettingsModal': true,
          'DebugPanel': true,
          'CustomDialog': true,
          'OPFSExplorer': true,
          'OnboardingModal': true,
          'ToastContainer': true,
          'Sidebar': true
        }
      }
    });

    await flushPromises();

    // Initial mount at /
    expect(mountSpy).toHaveBeenCalledTimes(1);

    // Navigate to a chat
    mockCurrentChat.value = { id: 'chat-1' } as Chat;
    await router.push('/chat/chat-1');
    await flushPromises();

    // Should NOT have remounted
    expect(unmountSpy).not.toHaveBeenCalled();
    expect(mountSpy).toHaveBeenCalledTimes(1);

    // Now navigate to another chat
    mockCurrentChat.value = { id: 'chat-2' } as Chat;
    await router.push('/chat/chat-2');
    await flushPromises();

    // Should still be reused
    expect(unmountSpy).not.toHaveBeenCalled();
    expect(mountSpy).toHaveBeenCalledTimes(1);
  });
});
