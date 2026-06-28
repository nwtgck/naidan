import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref, computed } from 'vue';
import ChatSettingsPanel from './ChatSettingsPanel.vue';
import ModelSelector from './ModelSelector.vue';
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';
import { useSettings } from '@/composables/useSettings';
import { useChatModels } from '@/composables/chat/useChatModels';
import { ensureAllStringsForTest } from '@/strings/test-utils';
const { mockAvailableModelsRef, mockFetchingModelsRef } = vi.hoisted(() => ({
  mockAvailableModelsRef: { value: [] as string[] },
  mockFetchingModelsRef: { value: false },
}));

vi.mock('../composables/chat/ui/useCurrentChatState', () => ({
  useCurrentChatState: vi.fn(),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: vi.fn(),
}));

vi.mock('../composables/chat/useChatModels', () => ({
  useChatModels: vi.fn(),
}));

vi.mock('../composables/chat/useChatMetadata', () => ({
  useChatMetadata: () => ({
    rename: vi.fn(),
    toggleDebug: vi.fn(),
    updateModel: vi.fn(),
    updateSettings: vi.fn(),
    reasoningEffort: vi.fn(),
    updateReasoningEffort: vi.fn(),
    TEST_ONLY: {},
  }),
}));

describe('ChatSettingsPanel Inheritance UI', () => {
  const mockCurrentChat = ref<any>(null);
  const mockSettings = ref<any>({
    endpointType: 'openai',
    endpointUrl: 'http://global-url',
    defaultModelId: 'global-model',
  });

  const globalStubs = {
    XIcon: true,
    RefreshCwIcon: true,
    GlobeIcon: true,
    Loader2Icon: true,
    Settings2Icon: true,
    AlertCircleIcon: true,
    Layers: true,
    MessageSquareQuote: true,
    LmParametersEditor: true,
    ModelSelector: true,
    'router-link': true,
  };

  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
    vi.clearAllMocks();
    mockCurrentChat.value = {
      id: 'chat-1',
      endpointUrl: undefined,
      modelId: undefined,
    };

    const mockResolvedSettings = computed(() => {
      // Logic simplified for test
      const chat = mockCurrentChat.value;
      const isGroup = chat.groupId === 'group-1';
      return {
        endpointType: isGroup ? 'ollama' : 'openai',
        endpointUrl: isGroup ? 'http://group-url' : 'http://global-url',
        modelId: isGroup ? 'group-model' : 'global-model',
        sources: {
          endpointType: isGroup ? 'chat_group' : 'global',
          endpointUrl: isGroup ? 'chat_group' : 'global',
          modelId: isGroup ? 'chat_group' : 'global',
        },
      };
    });

    const mockInheritedSettings = mockResolvedSettings; // In these tests they are same because chat has no overrides

    (useCurrentChatState as unknown as Mock).mockReturnValue({
      currentChatId: computed(() => mockCurrentChat.value?.id),
      currentChat: computed(() => mockCurrentChat.value),
      currentChatGroup: computed(() => null),
      activeMessages: computed(() => []),
      allMessages: computed(() => []),
      resolvedSettings: mockResolvedSettings,
      inheritedSettings: mockInheritedSettings,
      chatGroups: computed(() => []),
      sidebarItems: computed(() => []),
      TEST_ONLY: {},
    });
    mockFetchingModelsRef.value = false;
    mockAvailableModelsRef.value = [];
    vi.mocked(useChatModels).mockReturnValue({
      availableModels: computed(() => mockAvailableModelsRef.value) as unknown as ReturnType<typeof useChatModels>['availableModels'],
      fetchingModels: computed(() => mockFetchingModelsRef.value),
      fetchForChat: vi.fn(),
      fetchForGlobalEndpoint: vi.fn(),
      fetchForEndpoint: vi.fn(),
      TEST_ONLY: {},
    });

    (useSettings as unknown as Mock).mockReturnValue({
      settings: mockSettings,
    });
  });

  it('shows Global placeholders when not in a group', () => {
    mockCurrentChat.value.groupId = null;
    const wrapper = mount(ChatSettingsPanel, {
      props: { show: true },
      global: { stubs: globalStubs },
    });

    const urlInput = wrapper.find('[data-testid="chat-setting-url-input"]');
    expect(urlInput.attributes('placeholder')).toBe('http://global-url (Global)');

    const modelSelector = wrapper.findComponent(ModelSelector);
    expect(modelSelector.props('placeholder')).toBe('global-model (Global)');

    const typeSelect = wrapper.find('select');
    expect(typeSelect.find('option').text()).toBe('OpenAI (Global)');
  });

  it('shows Group placeholders when chat belongs to a group with overrides', () => {
    mockCurrentChat.value.groupId = 'group-1';
    const wrapper = mount(ChatSettingsPanel, {
      props: { show: true },
      global: { stubs: globalStubs },
    });

    const urlInput = wrapper.find('[data-testid="chat-setting-url-input"]');
    expect(urlInput.attributes('placeholder')).toBe('http://group-url (Group)');

    const modelSelector = wrapper.findComponent(ModelSelector);
    expect(modelSelector.props('placeholder')).toBe('group-model (Group)');

    const typeSelect = wrapper.find('select');
    expect(typeSelect.find('option').text()).toBe('Ollama (Group)');
  });
});
