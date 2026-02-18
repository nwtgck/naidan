import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';

// 1. Mock LLM providers to prevent real network calls
const mockListModels = vi.fn().mockResolvedValue(['model-1', 'model-2']);
vi.mock('./services/llm', () => ({
  OpenAIProvider: class {
    constructor() {}
    listModels = mockListModels;
  },
  OllamaProvider: class {
    constructor() {}
    listModels = mockListModels;
  },
}));

// 2. Mock storage service
const storageMocks = vi.hoisted(() => ({
  init: vi.fn(),
  loadSettings: vi.fn().mockResolvedValue(null),
  updateSettings: vi.fn(),
  switchProvider: vi.fn(),
  getCurrentType: vi.fn().mockReturnValue('local'),
  subscribeToChanges: vi.fn().mockReturnValue(() => {}),
  notify: vi.fn(),
}));

vi.mock('./services/storage', () => ({
  storageService: storageMocks,
}));

vi.mock('./services/storage/opfs-detection', () => ({
  checkOPFSSupport: vi.fn().mockResolvedValue(true),
}));

// 3. Mock useSettings with internal state and reset helpers
vi.mock('./composables/useSettings', async () => {
  const vue = await import('vue');

  // Singleton state for the mock
  const settings = vue.ref({ endpointUrl: '', endpointType: 'openai', defaultModelId: '' });
  const manualDismiss = vue.ref(false);
  const initialized = vue.ref(true);
  const isFetchingModels = vue.ref(false);
  const availableModels = vue.ref([]);

  const isOnboardingDismissed = vue.computed(() => {
    const hasEndpoint = !!settings.value.endpointUrl || settings.value.endpointType === 'transformers_js';
    const hasModel = !!settings.value.defaultModelId;
    return manualDismiss.value || (hasEndpoint && hasModel);
  });

  return {
    useSettings: () => ({
      init: vi.fn(),
      initialized,
      isOnboardingDismissed,
      isFetchingModels,
      settings,
      availableModels,
      updateGlobalEndpoint: async (options: any) => {
        settings.value = { ...settings.value, endpointType: options.type, endpointUrl: options.url };
      },
      updateGlobalModel: async (modelId: string) => {
        settings.value = { ...settings.value, defaultModelId: modelId };
      },
      // Test Helpers
      __reset: () => {
        settings.value = { endpointUrl: '', endpointType: 'openai', defaultModelId: '' };
        manualDismiss.value = false;
        initialized.value = true;
      }
    })
  };
});

// 4. Mock other composables/components
vi.mock('./composables/useChat', () => ({
  useChat: () => ({
    createNewChat: vi.fn(),
    createChatGroup: vi.fn(),
    loadChats: vi.fn(),
    currentChat: { value: null },
    currentChatGroup: { value: null },
    chats: { value: [] },
    chatGroups: { value: [] },
    isProcessing: () => false,
    sidebarItems: { value: [] },
    persistSidebarStructure: vi.fn(),
    openChat: vi.fn(),
  }),
}));

vi.mock('./composables/useConfirm', () => ({
  useConfirm: () => ({
    isConfirmOpen: { value: false },
    handleConfirm: vi.fn(),
    handleCancel: vi.fn(),
    showConfirm: vi.fn(),
  }),
}));

vi.mock('./composables/usePrompt', () => ({
  usePrompt: () => ({
    isPromptOpen: { value: false },
    handlePromptConfirm: vi.fn(),
    handlePromptCancel: vi.fn(),
  }),
}));

vi.mock('./composables/useLayout', () => ({
  useLayout: () => ({
    isSidebarOpen: { value: true },
    activeFocusArea: { value: 'chat' },
    setActiveFocusArea: vi.fn(),
    toggleSidebar: vi.fn(),
  }),
}));

vi.mock('./composables/useOPFSExplorer', () => ({
  useOPFSExplorer: () => ({ isOPFSOpen: { value: false } }),
}));

vi.mock('./composables/useTheme', () => ({ useTheme: vi.fn() }));
vi.mock('./composables/useGlobalSearch', () => ({ useGlobalSearch: () => ({ toggleSearch: vi.fn() }) }));

vi.mock('./components/Sidebar.vue', () => ({ __esModule: true, default: { template: '<div></div>' } }));
vi.mock('./components/ToastContainer.vue', () => ({ __esModule: true, default: { template: '<div></div>' } }));
vi.mock('./components/SettingsModal.vue', () => ({ __esModule: true, default: { template: '<div></div>' } }));
vi.mock('./components/DebugPanel.vue', () => ({ __esModule: true, default: { template: '<div></div>' } }));
vi.mock('./components/CustomDialog.vue', () => ({ __esModule: true, default: { template: '<div></div>' } }));
vi.mock('./components/OPFSExplorer.vue', () => ({ __esModule: true, default: { template: '<div></div>' } }));
vi.mock('./components/GlobalSearchModal.vue', () => ({ __esModule: true, default: { template: '<div></div>' } }));

vi.mock('./components/OnboardingModal.vue', () => ({
  __esModule: true,
  default: { template: '<div data-testid="onboarding-modal"></div>' }
}));

import App from './App.vue';
import { useSettings } from './composables/useSettings';

describe('App Global Settings Sync', () => {
  let router: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    (useSettings() as any).__reset(); // Reset the shared state in the mock

    router = createRouter({
      history: createWebHistory(),
      routes: [{ path: '/', component: { template: '<div></div>' } }]
    });

    await router.push('/');
    await router.isReady();
  });

  it('hides onboarding modal when both endpoint and model are provided in query', async () => {
    const wrapper = mount(App, {
      global: {
        plugins: [router],
        stubs: {
          'transition': true,
          'OnboardingModal': false,
        }
      }
    });

    await flushPromises();

    // Initial state: Onboarding is visible
    expect(wrapper.find('[data-testid="onboarding-modal"]').exists()).toBe(true);

    // Provide both endpoint and model via query parameters
    await router.push({
      path: '/',
      query: {
        'global-endpoint-type': 'ollama',
        'global-endpoint-url': 'http://localhost:11434',
        'global-model': 'llama3'
      }
    });

    await flushPromises();
    await nextTick();

    // Onboarding should be hidden
    expect(wrapper.find('[data-testid="onboarding-modal"]').exists()).toBe(false);
  });

  it('keeps onboarding modal if only endpoint is provided', async () => {
    const wrapper = mount(App, {
      global: {
        plugins: [router],
        stubs: {
          'transition': true,
          'OnboardingModal': false,
        }
      }
    });

    await flushPromises();

    await router.push({
      path: '/',
      query: {
        'global-endpoint-type': 'ollama',
        'global-endpoint-url': 'http://localhost:11434'
      }
    });

    await flushPromises();
    await nextTick();

    // Still visible because model is missing
    expect(wrapper.find('[data-testid="onboarding-modal"]').exists()).toBe(true);
  });

  it('syncs global endpoint settings from query parameters', async () => {
    mount(App, {
      global: {
        plugins: [router],
        stubs: { 'transition': true }
      }
    });

    await router.push({
      path: '/',
      query: {
        'global-endpoint-type': 'ollama',
        'global-endpoint-url': 'http://localhost:11434'
      }
    });
    await flushPromises();

    const { settings } = useSettings();
    expect(settings.value.endpointType).toBe('ollama');
    expect(settings.value.endpointUrl).toBe('http://localhost:11434');
  });

  it('syncs global model from query parameters', async () => {
    mount(App, {
      global: {
        plugins: [router],
        stubs: { 'transition': true }
      }
    });

    await router.push({
      path: '/',
      query: {
        'global-model': 'llama3'
      }
    });
    await flushPromises();

    const { settings } = useSettings();
    expect(settings.value.defaultModelId).toBe('llama3');
  });

  it('syncs both endpoint and model when both are provided', async () => {
    mount(App, {
      global: {
        plugins: [router],
        stubs: { 'transition': true }
      }
    });

    await router.push({
      path: '/',
      query: {
        'global-endpoint-type': 'openai',
        'global-endpoint-url': 'https://api.openai.com/v1',
        'global-model': 'gpt-4'
      }
    });
    await flushPromises();

    const { settings } = useSettings();
    expect(settings.value.endpointType).toBe('openai');
    expect(settings.value.endpointUrl).toBe('https://api.openai.com/v1');
    expect(settings.value.defaultModelId).toBe('gpt-4');
  });
});
