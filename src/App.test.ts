import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref, nextTick } from 'vue';
import App from './App.vue';
import { useChat } from './composables/useChat';
import { useSettings } from './composables/useSettings';
import { useConfirm } from './composables/useConfirm';
import { useRouter } from 'vue-router';
import type { Chat } from './models/types';

vi.mock('./composables/useChat', () => ({
  useChat: vi.fn(),
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
  const mockCreateNewChat = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (useChat as unknown as Mock).mockReturnValue({
      createNewChat: mockCreateNewChat,
      currentChat: ref(null),
    });
    (useSettings as unknown as Mock).mockReturnValue({
      init: mockInit,
      initialized: ref(true),
      settings: ref({ endpointUrl: 'http://localhost:11434' }),
    });
    (useRouter as unknown as Mock).mockReturnValue({
      push: vi.fn(),
    });
  });

  it('calls settings.init on mount', () => {
    mount(App, {
      global: {
        stubs: {
          'router-view': true,
          'transition': true,
        },
      },
    });
    expect(mockInit).toHaveBeenCalled();
  });

  it('renders core components', () => {
    const wrapper = mount(App, {
      global: {
        stubs: {
          'router-view': true,
          'transition': true,
        },
      },
    });
    expect(wrapper.find('[data-testid="sidebar"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="debug-panel"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="toast-container"]').exists()).toBe(true);
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
    
    expect(wrapper.find('[data-testid="onboarding-modal"]').exists()).toBe(true);
  });

  it('triggers createNewChat and navigates on Ctrl+Shift+O', async () => {
    const mockRouterPush = vi.fn();
    const currentChat = ref<Chat | null>(null);
    const localMockCreateNewChat = vi.fn(async () => {
      currentChat.value = { id: 'new-chat-id' } as Chat;
    });
    
    (useRouter as unknown as Mock).mockReturnValue({ push: mockRouterPush });
    (useChat as unknown as Mock).mockReturnValue({
      createNewChat: localMockCreateNewChat,
      currentChat,
    });

    mount(App, {
      global: {
        stubs: {
          'router-view': true,
          'transition': true,
        },
      },
    });

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

    expect(localMockCreateNewChat).toHaveBeenCalled();
    expect(mockRouterPush).toHaveBeenCalledWith('/chat/new-chat-id');
  });

  it('triggers createNewChat and navigates on Meta+Shift+O (Mac)', async () => {
    const mockRouterPush = vi.fn();
    const currentChat = ref<Chat | null>(null);
    const localMockCreateNewChat = vi.fn(async () => {
      currentChat.value = { id: 'mac-chat-id' } as Chat;
    });
    
    (useRouter as unknown as Mock).mockReturnValue({ push: mockRouterPush });
    (useChat as unknown as Mock).mockReturnValue({
      createNewChat: localMockCreateNewChat,
      currentChat,
    });

    mount(App, {
      global: {
        stubs: {
          'router-view': true,
          'transition': true,
        },
      },
    });

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

    expect(localMockCreateNewChat).toHaveBeenCalled();
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
