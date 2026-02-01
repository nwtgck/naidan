import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import Sidebar from './Sidebar.vue';
import { createRouter, createWebHistory } from 'vue-router';
import { ref, computed, nextTick, reactive } from 'vue';
import type { ChatGroup, ChatSummary, SidebarItem } from '../models/types';

// --- Mocks Data ---
const mockChatGroups = ref<ChatGroup[]>([]);
const mockChats = ref<ChatSummary[]>([]);
const mockSettings = reactive({
  endpointUrl: undefined as string | undefined,
  endpointType: 'openai' as 'openai' | 'ollama' | 'transformers_js',
  defaultModelId: 'llama3',
});
const mockAvailableModels = ref(['model-1', 'model-2']);
const mockIsFetchingModels = ref(false);
const mockUpdateGlobalModel = vi.fn();

// --- Vitest Mocks ---
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
    streaming: ref(false),
    chatGroups: mockChatGroups,
    chats: mockChats,
    sidebarItems: computed<SidebarItem[]>(() => []),
    loadChats: vi.fn(),
    isTaskRunning: vi.fn().mockReturnValue(false),
    isProcessing: vi.fn().mockReturnValue(false),
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref(mockSettings),
    availableModels: mockAvailableModels,
    isFetchingModels: mockIsFetchingModels,
    updateGlobalModel: mockUpdateGlobalModel,
  }),
}));

vi.mock('../composables/useConfirm', () => ({
  useConfirm: () => ({
    showConfirm: vi.fn(),
  }),
}));

vi.mock('../composables/useTheme', () => ({
  useTheme: () => ({
    themeMode: ref('dark'),
    setTheme: vi.fn(),
  }),
}));

// Mock draggable component
vi.mock('vuedraggable', () => ({
  default: {
    name: 'draggable',
    template: '<div class="draggable-mock"><slot name="item" v-for="element in modelValue" :element="element"></slot></div>',
    props: ['modelValue'],
  },
}));

describe('Sidebar Transformers.js Support', () => {
  const router = createRouter({
    history: createWebHistory(),
    routes: [{ path: '/', component: { template: 'div' } }],
  });

  const globalStubs = {
    'lucide-vue-next': true,
    'Logo': true,
    'ThemeToggle': true,
    'ModelSelector': {
      name: 'ModelSelector',
      template: '<div data-testid="model-selector-mock" :model-value="modelValue">{{ modelValue }}</div>',
      props: ['modelValue', 'models', 'loading']
    },
  };

  beforeEach(() => {
    mockSettings.endpointUrl = undefined;
    mockSettings.endpointType = 'openai';
    mockSettings.defaultModelId = 'model-1';
    mockAvailableModels.value = ['model-1', 'model-2'];
    vi.clearAllMocks();
  });

  it('renders the model selector when endpointType is transformers_js even if endpointUrl is missing', async () => {
    mockSettings.endpointType = 'transformers_js';
    mockSettings.endpointUrl = undefined;

    const wrapper = mount(Sidebar, {
      global: { plugins: [router], stubs: globalStubs },
    });
    await nextTick();

    const selector = wrapper.find('[data-testid="model-selector-mock"]');
    expect(selector.exists()).toBe(true);
    expect(wrapper.text()).toContain('Default model');
  });

  it('does not render the selector if endpointUrl is missing and type is NOT transformers_js', async () => {
    mockSettings.endpointType = 'openai';
    mockSettings.endpointUrl = undefined;

    const wrapper = mount(Sidebar, {
      global: { plugins: [router], stubs: globalStubs },
    });
    await nextTick();

    const selector = wrapper.find('[data-testid="model-selector-mock"]');
    expect(selector.exists()).toBe(false);
  });

  it('calls updateGlobalModel when model is changed in transformers_js mode', async () => {
    mockSettings.endpointType = 'transformers_js';
    
    const wrapper = mount(Sidebar, {
      global: { plugins: [router], stubs: globalStubs },
    });
    await nextTick();

    const selector = wrapper.getComponent({ name: 'ModelSelector' });
    await selector.vm.$emit('update:modelValue', 'model-2');

    expect(mockUpdateGlobalModel).toHaveBeenCalledWith('model-2');
  });
});
