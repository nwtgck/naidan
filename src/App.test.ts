import { describe, it, expect, vi, beforeEach, afterAll, type Mock } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref, reactive, nextTick } from 'vue';
import App from './App.vue';
import type { Chat } from './models/types';
import { asyncComponentTracker } from './utils/async-component-test-utils';

vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue')>();
  const { wrapVueWithAsyncTracking } = await vi.importActual<any>('./utils/async-component-test-utils');
  return wrapVueWithAsyncTracking(actual);
});

import { useSettings } from './composables/useSettings';
import { useConfirm } from './composables/useConfirm';
import { useRouter, useRoute } from 'vue-router';

// Define mock refs in module scope so they can be shared
const mockCreateNewChat = vi.fn();
const mockCreateChatGroup = vi.fn();
const mockLoadChats = vi.fn();
const mockCurrentChat = ref<Chat | null>(null);
const mockChats = ref<Chat[]>([]);
const mockChatGroups = ref<any[]>([]);

vi.mock('./composables/useChat', () => ({
  useChat: () => ({
    createNewChat: mockCreateNewChat,
    createChatGroup: mockCreateChatGroup,
    loadChats: mockLoadChats,
    currentChat: mockCurrentChat,
    currentChatGroup: ref(null),
    chats: mockChats,
    chatGroups: mockChatGroups,
  }),
}));

vi.mock('./composables/useSettings', () => ({
  useSettings: vi.fn(),
}));

vi.mock('./composables/useConfirm', () => ({
  useConfirm: vi.fn(() => ({
    isConfirmOpen: ref(false),
    confirmTitle: ref(''),
    confirmMessage: ref(''),
    confirmConfirmButtonText: ref(''),
    confirmCancelButtonText: ref(''),
    confirmButtonVariant: ref('default'),
    handleConfirm: vi.fn(),
    handleCancel: vi.fn(),
  })),
}));

vi.mock('vue-router', () => ({
  useRouter: vi.fn(),
  useRoute: vi.fn(),
  RouterView: {
    template: '<div data-testid="router-view"><slot /></div>',
  },
}));

// Core components are kept synchronous and mocked simply
vi.mock('./components/Sidebar.vue', () => ({
  default: {
    name: 'Sidebar',
    template: '<div data-testid="sidebar"></div>',
  },
}));

vi.mock('./components/OnboardingModal.vue', () => ({
  default: {
    name: 'OnboardingModal',
    setup() {
      const { initialized, isOnboardingDismissed } = useSettings();
      return { show: computed(() => initialized.value && !isOnboardingDismissed.value) };
    },
    template: '<div v-if="show" data-testid="onboarding-modal"></div>',
  },
}));

import { computed } from 'vue';

vi.mock('./components/ToastContainer.vue', () => ({
  default: {
    name: 'ToastContainer',
    template: '<div data-testid="toast-container"></div>',
  },
}));

// We DON'T vi.mock the components that are defineAsyncComponent in App.vue
// Instead we stub them in the mount options.

describe('App', () => {
  afterAll(async () => {
    await asyncComponentTracker.wait();
  });

  const mockInit = vi.fn();
  const currentRoute = reactive({ path: '/', query: {} as any });
  const mockRouterPush = vi.fn((p) => {
    if (typeof p === 'string') {
      currentRoute.path = p;
    } else if (p && typeof p === 'object' && p.path) {
      currentRoute.path = p.path;
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockCurrentChat.value = null;
    mockChats.value = [{ id: 'existing' } as unknown as Chat];
    currentRoute.path = '/';
    currentRoute.query = {};

    (useSettings as unknown as Mock).mockReturnValue({
      init: mockInit,
      initialized: ref(true),
      isOnboardingDismissed: ref(true),
      isFetchingModels: ref(false),
      settings: ref({ endpointUrl: 'http://localhost:11434' }),
    });

    (useRouter as unknown as Mock).mockReturnValue({
      push: mockRouterPush,
      currentRoute: ref(currentRoute),
    });
    (useRoute as unknown as Mock).mockReturnValue(currentRoute);
  });

  const mountApp = () => mount(App, {
    global: {
      stubs: {
        'router-view': true,
        'transition': true,
        // Stub the async components
        'SettingsModal': {
          template: '<div v-if="isOpen" data-testid="settings-modal"></div>',
          props: ['isOpen']
        },
        'DebugPanel': {
          template: '<div data-testid="debug-panel"></div>'
        },
        CustomDialog: {
          props: ['show', 'title', 'message', 'confirmButtonText', 'cancelButtonText', 'confirmButtonVariant', 'showInput', 'inputValue'],
          emits: ['confirm', 'cancel', 'update:inputValue'],
          template: `
            <div v-if="show" data-testid="custom-dialog" :data-confirm-variant="confirmButtonVariant">
              <h3 data-testid="dialog-title">{{ title }}</h3>
              <p data-testid="dialog-message">{{ message }}</p>
              <input v-if="showInput" :value="inputValue" @input="$emit('update:inputValue', $event.target.value)" data-testid="dialog-input" />
              <button @click="$emit('cancel')" data-testid="dialog-cancel-button">{{ cancelButtonText }}</button>
              <button @click="$emit('confirm')" :class="confirmButtonVariant === 'danger' ? 'bg-red-600' : ''" data-testid="dialog-confirm-button">{{ confirmButtonText }}</button>
            </div>
          `
        },
        OPFSExplorer: true,
        GroupSettingsPanel: true
      },
    },
  });

  it('renders core components', async () => {
    const wrapper = mountApp();
    await flushPromises();
    expect(wrapper.find('[data-testid="sidebar"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="debug-panel"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="toast-container"]').exists()).toBe(true);
  });

  it('automatically creates a new chat if none exist and on root path', async () => {
    mockChats.value = [];
    mockCreateNewChat.mockImplementation(async () => {
      mockCurrentChat.value = { id: 'auto-chat-id' } as unknown as Chat;
    });

    mountApp();

    await flushPromises();
    await nextTick();
    await nextTick();

    expect(mockCreateNewChat).toHaveBeenCalled();
    expect(mockRouterPush).toHaveBeenCalledWith('/chat/auto-chat-id');
  });

  it('automatically creates a new chat if history is cleared (chats length becomes 0)', async () => {
    mockChats.value = [{ id: 'existing-chat' } as unknown as Chat];
    mockCreateNewChat.mockImplementation(async () => {
      mockCurrentChat.value = { id: 'post-clear-chat-id' } as unknown as Chat;
    });

    mountApp();

    await flushPromises();
    expect(mockCreateNewChat).not.toHaveBeenCalled();

    // Simulate clearing history
    mockChats.value = [];
    
    await nextTick();
    await nextTick();
    await nextTick();

    expect(mockCreateNewChat).toHaveBeenCalled();
    expect(mockRouterPush).toHaveBeenCalledWith('/chat/post-clear-chat-id');
  });

  it('automatically creates a new chat when navigating back to root from another path if history is empty', async () => {
    mockChats.value = [];
    const currentRoute = reactive({ path: '/settings', query: {} as any });
    (useRouter as unknown as Mock).mockReturnValue({
      push: mockRouterPush,
      currentRoute: ref(currentRoute),
    });
    (useRoute as Mock).mockReturnValue(currentRoute);

    mountApp();

    await flushPromises();
    // Clear calls from immediate watch execution on mount
    mockCreateNewChat.mockClear();

    // Navigate to root
    currentRoute.path = '/';
    
    await nextTick();
    await nextTick();
    await nextTick();

    expect(mockCreateNewChat).toHaveBeenCalled();
  });

  it('automatically creates a new chat and preserves query param when q is present on root path', async () => {
    mockChats.value = [{ id: 'existing' } as unknown as Chat];
    const currentRoute = reactive({ path: '/', query: { q: 'hello' } });
    (useRouter as unknown as Mock).mockReturnValue({
      push: mockRouterPush,
      currentRoute: ref(currentRoute),
    });
    (useRoute as Mock).mockReturnValue(currentRoute);
    mockCreateNewChat.mockImplementation(async () => {
      mockCurrentChat.value = { id: 'q-chat-id' } as unknown as Chat;
    });

    mountApp();

    await flushPromises();
    await nextTick();
    await nextTick();

    expect(mockCreateNewChat).toHaveBeenCalled();
    expect(mockRouterPush).toHaveBeenCalledWith({
      path: '/chat/q-chat-id',
      query: { q: 'hello' }
    });
  });

  it('automatically creates a new chat in a group when both q and chat-group are present', async () => {
    mockChats.value = [{ id: 'existing' } as unknown as Chat];
    mockChatGroups.value = [{ id: 'group-123', name: 'Existing Group' }];
    const currentRoute = reactive({ path: '/', query: { q: 'hello', 'chat-group': 'group-123' } });
    (useRouter as unknown as Mock).mockReturnValue({
      push: mockRouterPush,
      currentRoute: ref(currentRoute),
    });
    (useRoute as Mock).mockReturnValue(currentRoute);
    mockCreateNewChat.mockImplementation(async (groupId) => {
      mockCurrentChat.value = { id: 'grouped-chat-id', groupId } as unknown as Chat;
    });

    mountApp();

    await flushPromises();
    await nextTick();
    await nextTick();

    expect(mockCreateNewChat).toHaveBeenCalledWith({
      groupId: 'group-123',
      modelId: undefined,
      systemPrompt: undefined
    });
    expect(mockRouterPush).toHaveBeenCalledWith({
      path: '/chat/grouped-chat-id',
      query: { q: 'hello' }
    });
  });

  it('automatically creates a new chat in a group by name when chat-group matches a group name', async () => {
    mockChats.value = [{ id: 'existing' } as unknown as Chat];
    mockChatGroups.value = [{ id: 'group-uuid-123', name: 'Query Group' }];
    const currentRoute = reactive({ path: '/', query: { q: 'hello', 'chat-group': 'Query Group' } });
    (useRouter as unknown as Mock).mockReturnValue({
      push: mockRouterPush,
      currentRoute: ref(currentRoute),
    });
    (useRoute as Mock).mockReturnValue(currentRoute);
    mockCreateNewChat.mockImplementation(async (options) => {
      mockCurrentChat.value = { id: 'grouped-chat-id', groupId: options.groupId } as unknown as Chat;
    });

    mountApp();

    await flushPromises();
    await nextTick();
    await nextTick();

    expect(mockCreateNewChat).toHaveBeenCalledWith({
      groupId: 'group-uuid-123',
      modelId: undefined,
      systemPrompt: undefined
    });
  });

  it('automatically creates a new group if chat-group name does not exist', async () => {
    mockChats.value = [{ id: 'existing' } as unknown as Chat];
    mockChatGroups.value = [];
    const currentRoute = reactive({ path: '/', query: { q: 'hello', 'chat-group': 'New Group Name' } });
    (useRouter as unknown as Mock).mockReturnValue({
      push: mockRouterPush,
      currentRoute: ref(currentRoute),
    });
    (useRoute as Mock).mockReturnValue(currentRoute);
    mockCreateChatGroup.mockResolvedValue('new-group-uuid');
    mockCreateNewChat.mockImplementation(async (options) => {
      mockCurrentChat.value = { id: 'grouped-chat-id', groupId: options.groupId } as unknown as Chat;
    });

    mountApp();

    await flushPromises();
    await nextTick();
    await nextTick();

    expect(mockCreateChatGroup).toHaveBeenCalledWith('New Group Name');
    expect(mockCreateNewChat).toHaveBeenCalledWith({
      groupId: 'new-group-uuid',
      modelId: undefined,
      systemPrompt: undefined
    });
  });

  it('automatically creates a new chat with model override when q and model are present', async () => {
    mockChats.value = [{ id: 'existing' } as unknown as Chat];
    const currentRoute = reactive({ path: '/', query: { q: 'hello', model: 'special-model' } });
    (useRouter as unknown as Mock).mockReturnValue({
      push: mockRouterPush,
      currentRoute: ref(currentRoute),
    });
    (useRoute as Mock).mockReturnValue(currentRoute);
    mockCreateNewChat.mockImplementation(async (options) => {
      mockCurrentChat.value = { id: 'model-chat-id', groupId: options.groupId, modelId: options.modelId } as unknown as Chat;
    });

    mountApp();

    await flushPromises();
    await nextTick();
    await nextTick();

    expect(mockCreateNewChat).toHaveBeenCalledWith({
      groupId: undefined,
      modelId: 'special-model',
      systemPrompt: undefined
    });
    expect(mockRouterPush).toHaveBeenCalledWith({
      path: '/chat/model-chat-id',
      query: { q: 'hello' }
    });
  });

  it('automatically creates a new chat with system prompt override when system-prompt query is present', async () => {
    mockChats.value = [{ id: 'existing' } as unknown as Chat];
    const currentRoute = reactive({ path: '/', query: { q: 'hello', 'system-prompt': 'You are a helpful assistant' } });
    (useRouter as unknown as Mock).mockReturnValue({
      push: mockRouterPush,
      currentRoute: ref(currentRoute),
    });
    (useRoute as Mock).mockReturnValue(currentRoute);
    mockCreateNewChat.mockImplementation(async (options) => {
      mockCurrentChat.value = { id: 'sp-chat-id', systemPrompt: options.systemPrompt } as unknown as Chat;
    });

    mountApp();

    await flushPromises();
    await nextTick();
    await nextTick();

    expect(mockCreateNewChat).toHaveBeenCalledWith({
      groupId: undefined,
      modelId: undefined,
      systemPrompt: { behavior: 'override', content: 'You are a helpful assistant' }
    });
    expect(mockRouterPush).toHaveBeenCalledWith({
      path: '/chat/sp-chat-id',
      query: { q: 'hello' }
    });
  });

  it('does NOT create a new chat when system-prompt is present but q is missing', async () => {
    mockChats.value = [{ id: 'existing' } as any]; // Non-empty list
    const currentRoute = reactive({ path: '/', query: { 'system-prompt': 'You are a cat' } });
    (useRouter as any).mockReturnValue({
      push: mockRouterPush,
      currentRoute: ref(currentRoute),
    });
    (useRoute as any).mockReturnValue(currentRoute);

    mountApp();
    await flushPromises();

    expect(mockCreateNewChat).not.toHaveBeenCalled();
  });

  it('creates a plain chat when list is empty even if system-prompt is in URL but q is missing', async () => {
    mockChats.value = []; // Empty list
    const currentRoute = reactive({ path: '/', query: { 'system-prompt': 'You are a cat' } });
    (useRouter as any).mockReturnValue({
      push: mockRouterPush,
      currentRoute: ref(currentRoute),
    });
    (useRoute as any).mockReturnValue(currentRoute);

    mountApp();
    await flushPromises();

    // Should create a chat because len === 0, but parameters should be ignored
    expect(mockCreateNewChat).toHaveBeenCalledWith({
      groupId: undefined,
      modelId: undefined,
      systemPrompt: undefined
    });
  });

  it('automatically creates a new chat with system prompt override when sp query is present', async () => {
    mockChats.value = [{ id: 'existing' } as unknown as Chat];
    const currentRoute = reactive({ path: '/', query: { q: 'hello', sp: 'Be concise' } });
    (useRouter as unknown as Mock).mockReturnValue({
      push: mockRouterPush,
      currentRoute: ref(currentRoute),
    });
    (useRoute as Mock).mockReturnValue(currentRoute);
    mockCreateNewChat.mockImplementation(async (options) => {
      mockCurrentChat.value = { id: 'sp-alias-id', systemPrompt: options.systemPrompt } as unknown as Chat;
    });

    mountApp();

    await flushPromises();
    await nextTick();
    await nextTick();

    expect(mockCreateNewChat).toHaveBeenCalledWith({
      groupId: undefined,
      modelId: undefined,
      systemPrompt: { behavior: 'override', content: 'Be concise' }
    });
  });

  it('opens SettingsModal when route query settings is present', async () => {
    const wrapper = mountApp();
    await flushPromises();
    
    expect(wrapper.find('[data-testid="settings-modal"]').exists()).toBe(false);
    
    currentRoute.query = { settings: 'connection' };
    await nextTick();
    
    expect(wrapper.find('[data-testid="settings-modal"]').exists()).toBe(true);
  });

  it('shows OnboardingModal when endpointUrl is missing', async () => {
    (useSettings as unknown as Mock).mockReturnValue({
      init: mockInit,
      initialized: ref(true),
      isOnboardingDismissed: ref(false),
      settings: ref({ endpointUrl: '' }),
    });

    const wrapper = mountApp();
    await flushPromises();
    
    expect(wrapper.find('[data-testid="onboarding-modal"]').exists()).toBe(true);
  });

  it('toggles OnboardingModal visibility based on isOnboardingDismissed state', async () => {
    const isOnboardingDismissed = ref(false);
    (useSettings as unknown as Mock).mockReturnValue({
      init: mockInit,
      initialized: ref(true),
      isOnboardingDismissed,
      settings: ref({ endpointUrl: '' }),
    });

    const wrapper = mountApp();
    await flushPromises();
    
    // Initially shown
    expect(wrapper.find('[data-testid="onboarding-modal"]').exists()).toBe(true);

    // Simulate dismissal (Skip)
    isOnboardingDismissed.value = true;
    await nextTick();
    expect(wrapper.find('[data-testid="onboarding-modal"]').exists()).toBe(false);

    // Simulate undoing dismissal
    isOnboardingDismissed.value = false;
    await nextTick();
    expect(wrapper.find('[data-testid="onboarding-modal"]').exists()).toBe(true);
  });

  it('triggers createNewChat and navigates on Ctrl+Shift+O', async () => {
    mockCreateNewChat.mockImplementation(async () => {
      mockCurrentChat.value = { id: 'new-chat-id' } as unknown as Chat;
    });
    
    mountApp();
    await flushPromises();

    // Simulate Ctrl+Shift+O
    const event = new KeyboardEvent('keydown', {
      key: 'o',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
    });
    window.dispatchEvent(event);

    await nextTick();
    await nextTick();

    expect(mockCreateNewChat).toHaveBeenCalledWith({
      groupId: undefined,
      modelId: undefined,
      systemPrompt: undefined
    });
    expect(mockRouterPush).toHaveBeenCalledWith('/chat/new-chat-id');
  });

  it('triggers createNewChat and navigates on Meta+Shift+O (Mac)', async () => {
    mockCreateNewChat.mockImplementation(async () => {
      mockCurrentChat.value = { id: 'mac-chat-id' } as unknown as Chat;
    });
    
    mountApp();
    await flushPromises();

    // Simulate Meta+Shift+O (Cmd on Mac)
    const event = new KeyboardEvent('keydown', {
      key: 'o',
      metaKey: true,
      shiftKey: true,
      bubbles: true,
    });
    window.dispatchEvent(event);

    await nextTick();
    await nextTick();

    expect(mockCreateNewChat).toHaveBeenCalledWith({
      groupId: undefined,
      modelId: undefined,
      systemPrompt: undefined
    });
    expect(mockRouterPush).toHaveBeenCalledWith('/chat/mac-chat-id');
  });

  it('shows CustomDialog with danger variant for confirm button when requested', async () => {
    const mockIsConfirmOpen = ref(false);
    const mockConfirmTitle = ref('');
    const mockConfirmMessage = ref('');
    const mockConfirmConfirmButtonText = ref('');
    const mockConfirmCancelButtonText = ref('');
    const mockConfirmButtonVariant = ref('default');
    const mockHandleConfirm = vi.fn();
    const mockHandleCancel = vi.fn();

    (useConfirm as unknown as Mock).mockReturnValue({
      isConfirmOpen: mockIsConfirmOpen,
      confirmTitle: mockConfirmTitle,
      confirmMessage: mockConfirmMessage,
      confirmConfirmButtonText: mockConfirmConfirmButtonText,
      confirmCancelButtonText: mockConfirmCancelButtonText,
      confirmButtonVariant: mockConfirmButtonVariant,
      handleConfirm: mockHandleConfirm,
      handleCancel: mockHandleCancel,
    });

    const wrapper = mountApp();
    await flushPromises();

    // Simulate opening the dialog with danger variant
    mockIsConfirmOpen.value = true;
    mockConfirmTitle.value = 'Confirm Reset';
    mockConfirmMessage.value = 'Are you sure you want to reset data?';
    mockConfirmConfirmButtonText.value = 'Reset';
    mockConfirmCancelButtonText.value = 'Cancel';
    mockConfirmButtonVariant.value = 'danger';

    await nextTick();

    const confirmButton = wrapper.find('[data-testid="custom-dialog"] [data-testid="dialog-confirm-button"]');
    expect(confirmButton.exists()).toBe(true);
    expect(confirmButton.text()).toBe('Reset');
    expect(confirmButton.classes()).toContain('bg-red-600');
  });
});