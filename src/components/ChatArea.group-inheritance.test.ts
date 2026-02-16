import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref, reactive, nextTick } from 'vue';
import ChatArea from './ChatArea.vue';
import ModelSelector from './ModelSelector.vue';
import { createRouter, createWebHistory } from 'vue-router';


// --- Mocks ---

const mockCurrentChat = ref<any>(null);
const mockChatGroups = ref<any[]>([]);
const mockResolvedSettings = ref<any>(null);
const mockInheritedSettings = ref<any>(null);

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: mockCurrentChat,
    chatGroups: mockChatGroups,
    resolvedSettings: mockResolvedSettings,
    inheritedSettings: mockInheritedSettings,
    activeMessages: ref([]),
    activeGenerations: reactive(new Map()),
    streaming: ref(false),
    generatingTitle: ref(false),
    availableModels: ref([]),
    fetchingModels: ref(false),
    fetchAvailableModels: vi.fn(),
    updateChatModel: vi.fn(),
    saveChat: vi.fn(),
    generateChatTitle: vi.fn(),
    toggleDebug: vi.fn(),
    getSiblings: vi.fn().mockReturnValue([]),
    moveChatToGroup: vi.fn(),
    isTaskRunning: vi.fn().mockReturnValue(false),
    isProcessing: vi.fn().mockReturnValue(false),
    abortChat: vi.fn(),
    isImageMode: vi.fn(() => false),
    toggleImageMode: vi.fn(),
    getResolution: vi.fn(() => ({ width: 512, height: 512 })),
    getCount: vi.fn(() => 1),
    updateCount: vi.fn(),
    getSteps: vi.fn(() => undefined),
    updateSteps: vi.fn(),
    getSeed: vi.fn(() => 'browser_random'),
    updateSeed: vi.fn(),
    getPersistAs: vi.fn(() => 'original'),
    updatePersistAs: vi.fn(),
    updateResolution: vi.fn(),
    setImageModel: vi.fn(),
    getSelectedImageModel: vi.fn(),
    getSortedImageModels: vi.fn(() => []),
    imageModeMap: ref({}),
    imageResolutionMap: ref({}),
    imageCountMap: ref({}),
    imagePersistAsMap: ref({}),
    imageModelOverrideMap: ref({}),
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref({ defaultModelId: 'global-model' }),
  }),
}));

// Mock router
const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/', component: { template: 'div' } }],
});

describe('ChatArea Group Inheritance UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCurrentChat.value = {
      id: 'chat-1',
      title: 'Test Chat',
      modelId: undefined, // Inheriting
      groupId: null,
    };
    mockChatGroups.value = [];

    // Default resolution (Global)
    mockResolvedSettings.value = {
      modelId: 'global-model',
      sources: { modelId: 'global' }
    };
    mockInheritedSettings.value = {
      modelId: 'global-model',
      sources: { modelId: 'global' }
    };
  });

  it('displays "Model (Global)" when inheriting from global settings', async () => {
    const wrapper = mount(ChatArea, {
      global: { plugins: [router], stubs: { Logo: true, MessageItem: true, WelcomeScreen: true, ChatSettingsPanel: true } }
    });
    await nextTick();

    const modelBadge = wrapper.find('[data-testid="model-trigger"]');
    expect(modelBadge.text()).toContain('global-model (Global)');

    const selector = wrapper.getComponent(ModelSelector);
    expect(selector.props('placeholder')).toBe('global-model (Global)');
  });

  it('displays "Model (Group)" when inheriting from a chat group', async () => {
    mockCurrentChat.value.groupId = 'group-1';
    mockResolvedSettings.value = {
      modelId: 'group-model',
      sources: { modelId: 'chat_group' }
    };
    mockInheritedSettings.value = {
      modelId: 'group-model',
      sources: { modelId: 'chat_group' }
    };

    const wrapper = mount(ChatArea, {
      global: { plugins: [router], stubs: { Logo: true, MessageItem: true, WelcomeScreen: true, ChatSettingsPanel: true } }
    });
    await nextTick();

    const modelBadge = wrapper.find('[data-testid="model-trigger"]');
    expect(modelBadge.text()).toContain('group-model (Group)');
  });

  it('displays only the model name when a chat-specific override is set', async () => {
    mockCurrentChat.value.modelId = 'specific-model';
    mockResolvedSettings.value = {
      modelId: 'specific-model',
      sources: { modelId: 'chat' }
    };
    // Inherited would still be global-model
    mockInheritedSettings.value = {
      modelId: 'global-model',
      sources: { modelId: 'global' }
    };

    const wrapper = mount(ChatArea, {
      global: { plugins: [router], stubs: { Logo: true, MessageItem: true, WelcomeScreen: true, ChatSettingsPanel: true } }
    });
    await nextTick();

    // Header badge should show the specific model without suffix
    const modelBadge = wrapper.find('[data-testid="model-trigger"]');
    expect(modelBadge.text()).toBe('specific-model');
    expect(modelBadge.text()).not.toContain('(Global)');
    expect(modelBadge.text()).not.toContain('(Group)');

    // BUT the ModelSelector placeholder (the "Inherit" preview) should show what it reverts to
    const selector = wrapper.getComponent(ModelSelector);
    expect(selector.props('placeholder')).toBe('global-model (Global)');
  });

  it('updates labels immediately when inherited settings change (e.g. moving between groups)', async () => {
    const wrapper = mount(ChatArea, {
      global: { plugins: [router], stubs: { Logo: true, MessageItem: true, WelcomeScreen: true, ChatSettingsPanel: true } }
    });
    await nextTick();

    // 1. Initially Global
    expect(wrapper.find('[data-testid="model-trigger"]').text()).toContain('global-model (Global)');

    // 2. Simulate moving to a group with a different model
    mockResolvedSettings.value = {
      modelId: 'new-group-model',
      sources: { modelId: 'chat_group' }
    };
    mockInheritedSettings.value = {
      modelId: 'new-group-model',
      sources: { modelId: 'chat_group' }
    };

    await nextTick();

    expect(wrapper.find('[data-testid="model-trigger"]').text()).toContain('new-group-model (Group)');
    expect(wrapper.find('[data-testid="model-trigger"]').text()).not.toContain('(Global)');
  });
});