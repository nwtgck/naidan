import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref, nextTick } from 'vue';
import App from './App.vue';
import type { Chat } from './models/types';

import { useSettings } from './composables/useSettings';
import { useConfirm } from './composables/useConfirm';
import { useRouter } from 'vue-router';


// Define mock refs in module scope so they can be shared
const mockCreateNewChat = vi.fn();
const mockLoadChats = vi.fn();
const mockCurrentChat = ref<Chat | null>(null);
const mockChats = ref<Chat[]>([]);

vi.mock('./composables/useChat', () => ({
  useChat: () => ({
    createNewChat: mockCreateNewChat,
    loadChats: mockLoadChats,
    currentChat: mockCurrentChat,
    chats: mockChats,
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
  RouterView: {
    template: '<div data-testid="router-view"><slot /></div>',
  },
}));

vi.mock('./components/CustomDialog.vue', () => ({
  default: {
    name: 'CustomDialog',
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
    `,
  },
}));

// Mock sub-components
vi.mock('./components/Sidebar.vue', () => ({
  default: {
    name: 'Sidebar',
    template: '<div data-testid="sidebar"><button @click="$emit(\'open-settings\')">Settings</button></div>',
    emits: ['open-settings'],
  },
}));
vi.mock('./components/SettingsModal.vue', () => ({
  default: {
    name: 'SettingsModal',
    template: '<div v-if="isOpen" data-testid="settings-modal"></div>',
    props: ['isOpen'],
  },
}));
vi.mock('./components/OnboardingModal.vue', () => ({
  default: {
    name: 'OnboardingModal',
    template: '<div data-testid="onboarding-modal"></div>',
  },
}));
vi.mock('./components/DebugPanel.vue', () => ({
  default: {
    name: 'DebugPanel',
    template: '<div data-testid="debug-panel"></div>',
  },
}));
vi.mock('./components/ToastContainer.vue', () => ({
  default: {
    name: 'ToastContainer',
    template: '<div data-testid="toast-container"></div>',
  },
}));

describe('App', () => {
  const mockInit = vi.fn();
  const mockRouterPush = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockCurrentChat.value = null;
    mockChats.value = [{ id: 'existing' } as unknown as Chat];

    (useSettings as unknown as Mock).mockReturnValue({
      init: mockInit,
      initialized: ref(true),
      settings: ref({ endpointUrl: 'http://localhost:11434' }),
    });
    (useRouter as unknown as Mock).mockReturnValue({
      push: mockRouterPush,
      currentRoute: ref({ path: '/' }),
    });
  });

  it('calls settings.init on mount', async () => {
    mount(App, {
      global: {
        stubs: {
          'router-view': true,
          'transition': true,
        },
      },
    });
    await nextTick();
    expect(mockInit).toHaveBeenCalled();
  });

  it('renders core components', async () => {
    const wrapper = mount(App, {
      global: {
        stubs: {
          'router-view': true,
          'transition': true,
        },
      },
    });
    await nextTick();
    expect(wrapper.find('[data-testid="sidebar"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="debug-panel"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="toast-container"]').exists()).toBe(true);
    expect(mockLoadChats).toHaveBeenCalled();
  });

  it('automatically creates a new chat if none exist and on root path', async () => {
    mockChats.value = [];
    mockCreateNewChat.mockImplementation(async () => {
      mockCurrentChat.value = { id: 'auto-chat-id' } as unknown as Chat;
    });

    mount(App, {
      global: {
        stubs: {
          'router-view': true,
          'transition': true,
        },
      },
    });

    await nextTick();
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

    mount(App, {
      global: {
        stubs: {
          'router-view': true,
          'transition': true,
        },
      },
    });

    await nextTick();
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
    const currentRoute = ref({ path: '/settings' });
    (useRouter as unknown as Mock).mockReturnValue({
      push: mockRouterPush,
      currentRoute,
    });

    mount(App, {
      global: {
        stubs: { 'router-view': true, 'transition': true },
      },
    });

    await nextTick();
    // Clear calls from immediate watch execution on mount
    mockCreateNewChat.mockClear();

    // Navigate to root
    currentRoute.value.path = '/';
    
    await nextTick();
    await nextTick();
    await nextTick();

    expect(mockCreateNewChat).toHaveBeenCalled();
  });

  it('opens SettingsModal when Sidebar emits open-settings', async () => {
    const wrapper = mount(App, {
      global: {
        stubs: {
          'router-view': true,
          'transition': true,
        },
      },
    });
    await nextTick();
    
    expect(wrapper.find('[data-testid="settings-modal"]').exists()).toBe(false);
    
    await wrapper.find('[data-testid="sidebar"] button').trigger('click');
    
    expect(wrapper.find('[data-testid="settings-modal"]').exists()).toBe(true);
  });

  it('shows OnboardingModal when endpointUrl is missing', async () => {
    (useSettings as unknown as Mock).mockReturnValue({
      init: mockInit,
      initialized: ref(true),
      settings: ref({ endpointUrl: '' }),
    });

    const wrapper = mount(App, {
      global: {
        stubs: {
          'router-view': true,
          'transition': true,
        },
      },
    });
    await nextTick();
    
    expect(wrapper.find('[data-testid="onboarding-modal"]').exists()).toBe(true);
  });

  it('triggers createNewChat and navigates on Ctrl+Shift+O', async () => {
    mockCreateNewChat.mockImplementation(async () => {
      mockCurrentChat.value = { id: 'new-chat-id' } as unknown as Chat;
    });
    
    mount(App, {
      global: {
        stubs: {
          'router-view': true,
          'transition': true,
        },
      },
    });
    await nextTick();

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

    expect(mockCreateNewChat).toHaveBeenCalled();
    expect(mockRouterPush).toHaveBeenCalledWith('/chat/new-chat-id');
  });

  it('triggers createNewChat and navigates on Meta+Shift+O (Mac)', async () => {
    mockCreateNewChat.mockImplementation(async () => {
      mockCurrentChat.value = { id: 'mac-chat-id' } as unknown as Chat;
    });
    
    mount(App, {
      global: {
        stubs: {
          'router-view': true,
          'transition': true,
        },
      },
    });
    await nextTick();

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

    expect(mockCreateNewChat).toHaveBeenCalled();
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

    const wrapper = mount(App, {
      global: {
        stubs: {
          'router-view': true,
          'transition': true,
        },
      },
    });

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
