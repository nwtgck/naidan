import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref, nextTick } from 'vue';
import App from './App.vue';
import { useChat } from './composables/useChat';
import { useSettings } from './composables/useSettings';
import { useRouter } from 'vue-router';

vi.mock('./composables/useChat', () => ({
  useChat: vi.fn()
}));

vi.mock('./composables/useSettings', () => ({
  useSettings: vi.fn()
}));

vi.mock('vue-router', () => ({
  useRouter: vi.fn(),
  RouterView: {
    template: '<div data-testid="router-view"><slot /></div>'
  }
}));

// Mock sub-components
vi.mock('./components/Sidebar.vue', () => ({
  default: {
    name: 'Sidebar',
    template: '<div data-testid="sidebar"><button @click="$emit(\'open-settings\')">Settings</button></div>',
    emits: ['open-settings']
  }
}));
vi.mock('./components/SettingsModal.vue', () => ({
  default: {
    name: 'SettingsModal',
    template: '<div v-if="isOpen" data-testid="settings-modal"></div>',
    props: ['isOpen']
  }
}));
vi.mock('./components/OnboardingModal.vue', () => ({
  default: {
    name: 'OnboardingModal',
    template: '<div data-testid="onboarding-modal"></div>'
  }
}));
vi.mock('./components/DebugPanel.vue', () => ({
  default: {
    name: 'DebugPanel',
    template: '<div data-testid="debug-panel"></div>'
  }
}));
vi.mock('./components/ToastContainer.vue', () => ({
  default: {
    name: 'ToastContainer',
    template: '<div data-testid="toast-container"></div>'
  }
}));

describe('App', () => {
  const mockInit = vi.fn();
  const mockCreateNewChat = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (useChat as any).mockReturnValue({
      createNewChat: mockCreateNewChat,
      currentChat: ref(null)
    });
    (useSettings as any).mockReturnValue({
      init: mockInit,
      initialized: ref(true),
      settings: ref({ endpointUrl: 'http://localhost:11434' })
    });
    (useRouter as any).mockReturnValue({
      push: vi.fn()
    });
  });

  it('calls settings.init on mount', () => {
    mount(App, {
      global: {
        stubs: {
          'router-view': true,
          'transition': true
        }
      }
    });
    expect(mockInit).toHaveBeenCalled();
  });

  it('renders core components', () => {
    const wrapper = mount(App, {
      global: {
        stubs: {
          'router-view': true,
          'transition': true
        }
      }
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
          'transition': true
        }
      }
    });
    
    expect(wrapper.find('[data-testid="settings-modal"]').exists()).toBe(false);
    
    await wrapper.find('[data-testid="sidebar"] button').trigger('click');
    
    expect(wrapper.find('[data-testid="settings-modal"]').exists()).toBe(true);
  });

  it('shows OnboardingModal when endpointUrl is missing', async () => {
    (useSettings as any).mockReturnValue({
      init: mockInit,
      initialized: ref(true),
      settings: ref({ endpointUrl: '' })
    });

    const wrapper = mount(App, {
      global: {
        stubs: {
          'router-view': true,
          'transition': true
        }
      }
    });
    
    expect(wrapper.find('[data-testid="onboarding-modal"]').exists()).toBe(true);
  });

  it('triggers createNewChat and navigates on Ctrl+Shift+O', async () => {
    const mockRouterPush = vi.fn();
    const currentChat = ref<any>(null);
    const localMockCreateNewChat = vi.fn(async () => {
      currentChat.value = { id: 'new-chat-id' };
    });
    
    (useRouter as any).mockReturnValue({ push: mockRouterPush });
    (useChat as any).mockReturnValue({
      createNewChat: localMockCreateNewChat,
      currentChat
    });

    mount(App, {
      global: {
        stubs: {
          'router-view': true,
          'transition': true
        }
      }
    });

    // Simulate Ctrl+Shift+O
    const event = new KeyboardEvent('keydown', {
      key: 'o',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true
    });
    window.dispatchEvent(event);

    await nextTick();
    await nextTick();

    expect(localMockCreateNewChat).toHaveBeenCalled();
    expect(mockRouterPush).toHaveBeenCalledWith('/chat/new-chat-id');
  });

  it('triggers createNewChat and navigates on Meta+Shift+O (Mac)', async () => {
    const mockRouterPush = vi.fn();
    const currentChat = ref<any>(null);
    const localMockCreateNewChat = vi.fn(async () => {
      currentChat.value = { id: 'mac-chat-id' };
    });
    
    (useRouter as any).mockReturnValue({ push: mockRouterPush });
    (useChat as any).mockReturnValue({
      createNewChat: localMockCreateNewChat,
      currentChat
    });

    mount(App, {
      global: {
        stubs: {
          'router-view': true,
          'transition': true
        }
      }
    });

    // Simulate Meta+Shift+O (Cmd on Mac)
    const event = new KeyboardEvent('keydown', {
      key: 'o',
      metaKey: true,
      shiftKey: true,
      bubbles: true
    });
    window.dispatchEvent(event);

    await nextTick();
    await nextTick();

    expect(localMockCreateNewChat).toHaveBeenCalled();
    expect(mockRouterPush).toHaveBeenCalledWith('/chat/mac-chat-id');
  });
});
