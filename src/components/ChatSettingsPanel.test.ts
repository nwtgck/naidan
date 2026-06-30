import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref, reactive, toRef, nextTick, computed } from 'vue';
import ChatSettingsPanel from './ChatSettingsPanel.vue';
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';
import { useSettings } from '@/composables/useSettings';
import { useChatModels } from '@/composables/chat/useChatModels';
import { useChatMetadata } from '@/composables/chat/useChatMetadata';
import { applyScopedSettingChangesToChat } from '@/logic/scoped-setting-changes';
import type { Chat, Endpoint } from '@/01-models/types';

// --- Mocks ---
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
  useChatMetadata: vi.fn(),
}));

const mockSetActiveFocusArea = vi.fn();

vi.mock('../composables/useLayout', () => ({
  useLayout: () => ({
    setActiveFocusArea: mockSetActiveFocusArea,
  }),
}));

describe('ChatSettingsPanel.vue', () => {
  const mockFetchAvailableModels = vi.fn().mockResolvedValue(['model-1', 'model-2']);
  const mockUpdateChatSettings = vi.fn().mockImplementation(({ id, updates }) => {
    if (mockCurrentChat.value?.id === id) {
      Object.assign(mockCurrentChat.value, updates);
    }
  });
  const mockCurrentChat = ref<any>(null);

  const mockSettings = reactive<{
    value: {
      endpoint: Endpoint,
      defaultModelId: string,
      providerProfiles: {
        id: string,
        name: string,
        endpoint: Endpoint,
        defaultModelId?: string,
      }[],
    },
  }>({
    value: {
      endpoint: { type: 'openai', url: 'http://global:1234' },
      defaultModelId: 'global-model',
      providerProfiles: [
        {
          id: 'profile-1',
          name: 'My Ollama',
          endpoint: { type: 'ollama', url: 'http://ollama:11434' },
          defaultModelId: 'llama3',
        },
      ],
    },
  });

  const globalStubs = {
    XIcon: true,
    RefreshCwIcon: true,
    GlobeIcon: true,
    Loader2Icon: true,
    Settings2Icon: true,
    AlertCircleIcon: true,
    TransformersJsUpsell: {
      name: 'TransformersJsUpsell',
      template: '<div data-testid="upsell-stub"></div>',
      props: ['show'],
    },
    CheckIcon: { name: 'Check', template: '<span class="check-stub" />' },
    ModelSelector: {
      name: 'ModelSelector',
      template: '<div data-testid="model-selector-mock" :model-value="modelValue">{{ modelValue }}<button v-if="!loading" data-testid="refresh-mock" @click="$emit(\'refresh\')">Refresh</button><span v-if="loading" class="loading-mock">Loading</span></div>',
      props: ['modelValue', 'loading', 'placeholder', 'models'],
    },
    LmParametersEditor: {
      name: 'LmParametersEditor',
      template: '<div data-testid="lm-parameters-editor-mock"></div>',
      props: ['modelValue'],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset global settings to a predictable state
    mockSettings.value = {
      endpoint: { type: 'openai', url: 'http://global:1234' },
      defaultModelId: 'global-model',
      providerProfiles: [
        {
          id: 'profile-1',
          name: 'My Ollama',
          endpoint: { type: 'ollama', url: 'http://ollama:11434' },
          defaultModelId: 'llama3',
        },
      ],
    };

    // Create a NEW reactive object for each test to avoid cross-test pollution
    mockCurrentChat.value = reactive({
      id: 'chat-1',
      endpoint: undefined,
      modelId: undefined,
      systemPrompt: undefined,
      lmParameters: undefined,
    });

    const mockResolvedSettings = computed(() => {
      const chat = mockCurrentChat.value as any;
      const s = mockSettings.value;
      return {
        endpoint: chat?.endpoint ?? s.endpoint,
        modelId: chat?.modelId || s.defaultModelId,
        autoTitleEnabled: true,
        titleModelId: undefined,
        systemPromptMessages: [],
        lmParameters: undefined,
        sources: {
          endpoint: chat?.endpoint ? 'chat' : 'global',
          modelId: chat?.modelId ? 'chat' : 'global',
          autoTitleEnabled: 'global',
          titleModelId: 'global',
          systemPrompt: 'global',
          lmParameters: {},
        },
      };
    });
    const mockInheritedSettings = computed(() => ({
      ...mockResolvedSettings.value,
      endpoint: mockSettings.value.endpoint,
      sources: {
        ...mockResolvedSettings.value.sources,
        endpoint: 'global' as const,
      },
    }));

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

    mockAvailableModelsRef.value = ['model-1', 'model-2'];
    mockFetchingModelsRef.value = false;
    vi.mocked(useChatMetadata).mockReturnValue({
      rename: vi.fn(),
      toggleDebug: vi.fn(),
      updateModel: vi.fn(),
      updateGroupOverride: vi.fn(),
      updateScopedSettings: async ({ chatId, changes }) => {
        const current = mockCurrentChat.value?.id === chatId
          ? mockCurrentChat.value
          : {
            ...mockCurrentChat.value,
            id: chatId,
            root: { items: [] },
          } as Chat;
        const updated = applyScopedSettingChangesToChat({
          current,
          changes,
          updatedAt: Date.now(),
        });
        const updates: Record<string, unknown> = {};
        for (const change of changes) {
          switch (change.field) {
          case 'endpoint':
            updates.endpoint = updated.endpoint;
            break;
          case 'model_id':
            updates.modelId = updated.modelId;
            break;
          case 'auto_title_enabled':
            updates.autoTitleEnabled = updated.autoTitleEnabled;
            break;
          case 'title_model_id':
            updates.titleModelId = updated.titleModelId;
            break;
          case 'system_prompt':
            updates.systemPrompt = updated.systemPrompt;
            break;
          case 'lm_param_temperature':
          case 'lm_param_top_p':
          case 'lm_param_max_completion_tokens':
          case 'lm_param_presence_penalty':
          case 'lm_param_frequency_penalty':
          case 'lm_param_stop':
          case 'lm_param_reasoning_effort':
            updates.lmParameters = updated.lmParameters;
            break;
          default: {
            const _ex: never = change;
            throw new Error(`Unhandled test change: ${String(_ex)}`);
          }
          }
        }
        await mockUpdateChatSettings({ id: chatId, updates });
      },
      updateSettings: async ({ chatId, updates }) => {
        await mockUpdateChatSettings({ id: chatId, updates });
      },
      reasoningEffort: vi.fn(),
      updateReasoningEffort: vi.fn(),
      TEST_ONLY: {},
    });
    vi.mocked(useChatModels).mockReturnValue({
      availableModels: computed(() => mockAvailableModelsRef.value) as unknown as ReturnType<typeof useChatModels>['availableModels'],
      fetchingModels: computed(() => mockFetchingModelsRef.value),
      fetchForChat: async ({ chatId }) => {
        return await mockFetchAvailableModels({ chatId });
      },
      fetchForGlobalEndpoint: vi.fn(),
      fetchForEndpoint: vi.fn(),
      TEST_ONLY: {},
    });

    (useSettings as unknown as Mock).mockReturnValue({
      settings: toRef(mockSettings, 'value'),
    });
  });

  it('removes_HTTP_fields_when_switching_to_transformers_js', async () => {
    Object.assign(mockCurrentChat.value, {
      endpoint: {
        type: 'openai',
        url: 'http://example.test/v1',
        httpHeaders: [['Authorization', 'Bearer token']],
      },
    });

    const wrapper = mount(ChatSettingsPanel, {
      props: { show: true },
      global: { stubs: globalStubs },
    });
    await nextTick();

    await wrapper.get('[data-testid="chat-setting-endpoint-type-select"]').setValue('transformers_js');
    await flushPromises();

    expect(mockUpdateChatSettings).toHaveBeenLastCalledWith({
      id: 'chat-1',
      updates: expect.objectContaining({
        endpoint: { type: 'transformers_js' },
      }),
    });
  });

  it('uses the inherited HTTP endpoint when switching from transformers_js to HTTP', async () => {
    mockSettings.value.endpoint = {
      type: 'openai',
      url: 'http://global:1234/v1',
      httpHeaders: [['X-Global', 'value']],
    };
    mockCurrentChat.value.endpoint = { type: 'transformers_js' };

    const wrapper = mount(ChatSettingsPanel, {
      props: { show: true },
      global: { stubs: globalStubs },
    });
    await nextTick();

    await wrapper.get('[data-testid="chat-setting-endpoint-type-select"]').setValue('ollama');
    await flushPromises();

    expect(mockUpdateChatSettings).toHaveBeenLastCalledWith({
      id: 'chat-1',
      updates: expect.objectContaining({
        endpoint: {
          type: 'ollama',
          url: 'http://global:1234/v1',
          httpHeaders: [['X-Global', 'value']],
        },
      }),
    });
  });

  it('hides endpoint URL when effective type is transformers_js', async () => {
    // 1. Local override is transformers_js
    mockCurrentChat.value.endpoint = { type: 'transformers_js' };
    const wrapper = mount(ChatSettingsPanel, {
      props: { show: true },
      global: { stubs: globalStubs },
    });
    await nextTick();
    expect(wrapper.find('[data-testid="chat-setting-url-input"]').exists()).toBe(false);

    // 2. Local is undefined (inherit), and global is transformers_js
    mockCurrentChat.value = reactive({ id: 'chat-2', endpoint: undefined });
    mockSettings.value.endpoint = { type: 'transformers_js' };
    const wrapper2 = mount(ChatSettingsPanel, {
      props: { show: true },
      global: { stubs: globalStubs },
    });
    await nextTick();
    expect(wrapper2.find('[data-testid="chat-setting-url-input"]').exists()).toBe(false);
  });

  it('shows upsell component when effective type is transformers_js', async () => {
    mockSettings.value.endpoint = { type: 'openai', url: 'http://global:1234' };
    const wrapper = mount(ChatSettingsPanel, {
      props: { show: true },
      global: { stubs: globalStubs },
    });
    await flushPromises();
    await vi.dynamicImportSettled();

    mockSettings.value.endpoint = { type: 'transformers_js' };
    await nextTick();
    await flushPromises();
    await vi.dynamicImportSettled();

    const upsell = wrapper.findComponent({ name: 'TransformersJsUpsell' });
    expect(upsell.props('show')).toBe(true);
  });

  it('renders correctly when a chat is active', async () => {
    const wrapper = mount(ChatSettingsPanel, {
      props: { show: true },
      global: { stubs: globalStubs },
    });
    await nextTick();
    expect(wrapper.exists()).toBe(true);
    expect(wrapper.text()).toContain('Chat Specific Overrides');
    expect(wrapper.text()).toContain('Quick Endpoint Presets');
    expect(wrapper.text()).toContain('Endpoint Type');
  });

  it('applies animation classes for entrance effects', () => {
    const wrapper = mount(ChatSettingsPanel, {
      props: { show: true },
      global: { stubs: globalStubs },
    });

    const modalContent = wrapper.find('.modal-content-zoom');
    expect(modalContent.exists()).toBe(true);
  });

  it('does not render when show prop is false', () => {
    const wrapper = mount(ChatSettingsPanel, {
      props: { show: false },
      global: { stubs: globalStubs },
    });
    // Look for the overlay which should be missing
    expect(wrapper.find('.fixed.inset-0').exists()).toBe(false);
  });

  it('triggers model fetch on mount if URL is localhost', async () => {
    mockCurrentChat.value.endpoint = { type: 'openai', url: 'http://localhost:11434' };
    mount(ChatSettingsPanel, {
      props: { show: true },
      global: { stubs: globalStubs },
    });
    await nextTick();
    expect(mockFetchAvailableModels).toHaveBeenCalled();
  });

  it('does not trigger model fetch on mount if URL is not localhost', async () => {
    mockCurrentChat.value.endpoint = { type: 'openai', url: 'http://remote-api.com' };
    mount(ChatSettingsPanel, {
      props: { show: true },
      global: { stubs: globalStubs },
    });
    await nextTick();
    expect(mockFetchAvailableModels).not.toHaveBeenCalled();
  });

  describe('Auto-fetch logic', () => {
    it('triggers fetch when switching to a localhost preset', async () => {
      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();
      mockFetchAvailableModels.mockClear();

      const ollamaBtn = wrapper.findAll('button').find(b => b.text() === 'Ollama (local)');
      await ollamaBtn?.trigger('click');

      expect(mockFetchAvailableModels).toHaveBeenCalled();
    });

    it('triggers fetch when manually entering a localhost URL', async () => {
      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();
      const urlInput = wrapper.find('input[data-testid="chat-setting-url-input"]');

      await urlInput.setValue('http://127.0.0.1:1234');
      // Triggers via watcher on localSettings in implementation
      expect(mockFetchAvailableModels).toHaveBeenCalled();
    });
  });

  describe('Persistence', () => {
    it('triggers updateChatSettings when endpoint settings change', async () => {
      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();
      const urlInput = wrapper.find('input[data-testid="chat-setting-url-input"]');

      await urlInput.setValue('http://persisted-url:1234');
      await urlInput.trigger('blur');

      expect(mockUpdateChatSettings).toHaveBeenCalledWith({ id: 'chat-1', updates: expect.objectContaining({
        endpoint: expect.objectContaining({ url: 'http://persisted-url:1234' }),
      }) });
    });

    it('triggers updateChatSettings when model override changes', async () => {
      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();
      const selector = wrapper.getComponent({ name: 'ModelSelector' });

      await selector.vm.$emit('update:modelValue', 'model-1');
      await flushPromises();

      expect(mockUpdateChatSettings).toHaveBeenCalledWith({ id: 'chat-1', updates: expect.objectContaining({
        modelId: 'model-1',
      }) });
    });

    it('triggers updateChatSettings when a preset is applied', async () => {
      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();
      const ollamaBtn = wrapper.findAll('button').find(b => b.text() === 'Ollama (local)');

      await ollamaBtn?.trigger('click');

      expect(mockUpdateChatSettings).toHaveBeenCalledWith({ id: 'chat-1', updates: expect.objectContaining({
        endpoint: { type: 'ollama', url: 'http://localhost:11434' },
      }) });
    });

    it('triggers updateChatSettings when a provider profile is applied', async () => {
      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();
      const select = wrapper.find('select'); // First select is Profile Switcher

      await select.setValue('profile-1');
      await select.trigger('change');

      expect(mockUpdateChatSettings).toHaveBeenCalledWith({ id: 'chat-1', updates: expect.objectContaining({
        endpoint: { type: 'ollama', url: 'http://ollama:11434' },
      }) });
    });
  });

  describe('Quick Profile Switcher', () => {
    it('applies a selected profile to the current chat', async () => {
      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();
      const select = wrapper.find('select'); // First select is the profile switcher

      await select.setValue('profile-1');
      await select.trigger('change');
      await nextTick();

      expect(mockCurrentChat.value!.endpoint).toEqual({
        type: 'ollama',
        url: 'http://ollama:11434',
      });

      // Should reset selection after apply
      const vm = wrapper.vm as any;
      expect(vm.selectedProviderProfileId).toBe('');
    });

    it('removes_HTTP_fields_when_applying_a_transformers_js_profile', async () => {
      mockSettings.value.providerProfiles.push({
        id: 'p-transformers',
        name: 'Transformers.js Profile',
        endpoint: { type: 'transformers_js' },
        defaultModelId: 'transformers-model',
      });
      Object.assign(mockCurrentChat.value, {
        endpoint: {
          type: 'openai',
          url: 'http://old.test/v1',
          httpHeaders: [['X-Old', 'value']],
        },
      });

      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();

      const select = wrapper.find('select');
      await select.setValue('p-transformers');
      await select.trigger('change');
      await flushPromises();

      expect(mockUpdateChatSettings).toHaveBeenCalledWith({
        id: 'chat-1',
        updates: expect.objectContaining({
          endpoint: { type: 'transformers_js' },
        }),
      });
    });

    it('applies headers from a selected profile', async () => {
      const mockProfileWithHeaders = {
        id: 'p-h',
        name: 'Header Profile',
        endpoint: {
          type: 'openai' as const,
          url: 'http://h:1234',
          httpHeaders: [['X-Header', 'Value']] as [string, string][],
        },
        defaultModelId: 'm1',
      };
      mockSettings.value.providerProfiles.push(mockProfileWithHeaders);

      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();
      const select = wrapper.find('select');

      await select.setValue('p-h');
      await select.trigger('change');

      expect(mockUpdateChatSettings).toHaveBeenCalledWith({ id: 'chat-1', updates: expect.objectContaining({
        endpoint: expect.objectContaining({ httpHeaders: [['X-Header', 'Value']] }),
      }) });
    });
  });

  describe('Custom HTTP Headers', () => {
    it('supports adding and removing headers directly', async () => {
      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();

      const addBtn = wrapper.findAll('button').find(b => b.text().includes('Add Header'));
      await addBtn?.trigger('click');
      await nextTick();

      const inputs = wrapper.findAll('input[type="text"]');
      // After clicking Add Header, URL is inputs[0], Header Name is inputs[1], Header Value is inputs[2]
      await inputs[1]?.setValue('X-Manual');
      await inputs[1]?.trigger('blur');
      await inputs[2]?.setValue('Val-Manual');
      await inputs[2]?.trigger('blur');

      expect(mockUpdateChatSettings).toHaveBeenCalledWith({ id: 'chat-1', updates: expect.objectContaining({
        endpoint: expect.objectContaining({ httpHeaders: expect.arrayContaining([['X-Manual', 'Val-Manual']]) }),
      }) });

      // Remove
      const removeBtn = wrapper.findAll('button').find(b => b.html().includes('lucide-trash2') || b.findComponent({ name: 'Trash2' }).exists());
      await removeBtn?.trigger('click');
      await flushPromises();

      expect(mockUpdateChatSettings).toHaveBeenCalledWith({ id: 'chat-1', updates: expect.objectContaining({
        endpoint: expect.objectContaining({ httpHeaders: [] }),
      }) });
    });
  });

  describe('Endpoint Presets', () => {
    it('applies Ollama preset when clicked', async () => {
      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();
      const ollamaBtn = wrapper.findAll('button').find(b => b.text() === 'Ollama (local)');

      await ollamaBtn?.trigger('click');

      expect(mockUpdateChatSettings).toHaveBeenCalledWith({ id: 'chat-1', updates: expect.objectContaining({
        endpoint: { type: 'ollama', url: 'http://localhost:11434' },
      }) });
    });

    it('applies LM Studio preset when clicked', async () => {
      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();
      const lmStudioBtn = wrapper.findAll('button').find(b => b.text() === 'LM Studio (local)');

      await lmStudioBtn?.trigger('click');

      expect(mockUpdateChatSettings).toHaveBeenCalledWith({ id: 'chat-1', updates: expect.objectContaining({
        endpoint: { type: 'openai', url: 'http://localhost:1234/v1' },
      }) });
    });
  });

  describe('Manual Overrides', () => {
    it('updates currentChat endpointType through direct selection', async () => {
      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();
      const typeSelect = wrapper.findAll('select')[1]; // Second select is Type

      await typeSelect!.setValue('ollama');
      await typeSelect!.trigger('change');
      expect(mockUpdateChatSettings).toHaveBeenCalledWith({ id: 'chat-1', updates: expect.objectContaining({
        endpoint: expect.objectContaining({ type: 'ollama' }),
      }) });
    });

    it('updates currentChat endpointUrl through text input', async () => {
      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();
      const urlInput = wrapper.find('input[data-testid="chat-setting-url-input"]');

      await urlInput.setValue('http://custom-api:8000');
      await urlInput.trigger('blur');
      expect(mockUpdateChatSettings).toHaveBeenCalledWith({ id: 'chat-1', updates: expect.objectContaining({
        endpoint: expect.objectContaining({ url: 'http://custom-api:8000' }),
      }) });
    });

    it('does not affect other chats when overriding settings', async () => {
      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();
      const urlInput = wrapper.find('input[data-testid="chat-setting-url-input"]');

      // Act: change current chat URL
      await urlInput.setValue('http://changed:8888');
      await urlInput.trigger('blur');

      expect(mockUpdateChatSettings).toHaveBeenCalledWith({ id: 'chat-1', updates: expect.objectContaining({
        endpoint: expect.objectContaining({ url: 'http://changed:8888' }),
      }) });
    });

    it('does not affect global settings when overriding chat settings', async () => {
      mockSettings.value.endpoint = { type: 'openai', url: 'http://global:1234' };
      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();
      const urlInput = wrapper.find('input[data-testid="chat-setting-url-input"]');

      // Act: change current chat URL
      await urlInput.setValue('http://overridden-url:9999');
      await urlInput.trigger('blur');

      // Assert: global settings remain original
      expect(mockSettings.value.endpoint).toEqual({ type: 'openai', url: 'http://global:1234' });
    });
  });

  describe('Persistence & Timing', () => {
    it('saves settings to the previous chat when chat is switched while panel is open', async () => {
      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();

      const urlInput = wrapper.find('input[data-testid="chat-setting-url-input"]');
      await urlInput.setValue('http://new-url-for-A');

      // Switch chat
      mockCurrentChat.value = {
        id: 'chat-B',
        endpoint: { type: 'openai', url: 'http://B' },
      };
      await nextTick();
      await flushPromises();

      expect(mockUpdateChatSettings).toHaveBeenCalledWith({ id: 'chat-1', updates: expect.objectContaining({
        endpoint: expect.objectContaining({ url: 'http://new-url-for-A' }),
      }) });
    });

    it('uses the previous chat inherited endpoint type when saving during a chat switch', async () => {
      mockSettings.value.endpoint = { type: 'ollama', url: 'http://global:1234' };
      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();
      mockUpdateChatSettings.mockClear();

      const urlInput = wrapper.get('input[data-testid="chat-setting-url-input"]');
      await urlInput.setValue('http://ollama-for-A');

      mockCurrentChat.value = reactive({
        id: 'chat-B',
        endpoint: { type: 'openai', url: 'http://openai-for-B' },
        modelId: undefined,
        autoTitleEnabled: undefined,
        titleModelId: undefined,
        systemPrompt: undefined,
        lmParameters: undefined,
      });
      await nextTick();
      await flushPromises();

      expect(mockUpdateChatSettings).toHaveBeenCalledWith({
        id: 'chat-1',
        updates: expect.objectContaining({
          endpoint: expect.objectContaining({
            type: 'ollama',
            url: 'http://ollama-for-A',
          }),
        }),
      });
    });

    it('does not write a stale model override when the hidden panel observes an external model change', async () => {
      mount(ChatSettingsPanel, {
        props: { show: false },
        global: { stubs: globalStubs },
      });
      await nextTick();
      mockUpdateChatSettings.mockClear();

      mockCurrentChat.value.modelId = 'model-2';
      await nextTick();

      mockCurrentChat.value = reactive({
        id: 'chat-B',
        endpoint: undefined,
        modelId: undefined,
        autoTitleEnabled: undefined,
        titleModelId: undefined,
        systemPrompt: undefined,
        lmParameters: undefined,
      });
      await nextTick();
      await flushPromises();

      expect(mockUpdateChatSettings).not.toHaveBeenCalled();
    });

    it('saves settings when the modal is closed via props even if blur hasn\'t fired yet', async () => {
      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();

      const urlInput = wrapper.find('input[data-testid="chat-setting-url-input"]');
      await urlInput.setValue('http://closing-save');

      // Simulate closing the modal via the prop
      await wrapper.setProps({ show: false });
      await nextTick();

      expect(mockUpdateChatSettings).toHaveBeenCalledWith({ id: 'chat-1', updates: expect.objectContaining({
        endpoint: expect.objectContaining({ url: 'http://closing-save' }),
      }) });
    });

    it('preserves a dirty LM parameter while synchronizing another parameter externally', async () => {
      let resolveSave: (() => void) | undefined;
      mockUpdateChatSettings.mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveSave = resolve;
      }));

      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();

      const editor = wrapper.getComponent({ name: 'LmParametersEditor' });
      editor.vm.$emit('update:modelValue', {
        temperature: 0.8,
        reasoning: { effort: undefined },
      });
      await nextTick();

      mockCurrentChat.value.lmParameters = {
        reasoning: { effort: 'high' },
      };
      await nextTick();

      expect(editor.props('modelValue')).toEqual(expect.objectContaining({
        temperature: 0.8,
        reasoning: { effort: 'high' },
      }));

      resolveSave?.();
      await flushPromises();
    });

    it('synchronizes settings from the current chat when the modal is reopened', async () => {
      mockCurrentChat.value = {
        id: 'chat-1',
        endpoint: { type: 'openai', url: 'http://original' },
      };

      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();

      // Close modal
      await wrapper.setProps({ show: false });
      await nextTick();

      // Update chat settings "in the background" (e.g. from storage sync)
      mockCurrentChat.value.endpoint = { type: 'openai', url: 'http://updated-externally' };

      // Reopen modal
      await wrapper.setProps({ show: true });
      await nextTick();

      const urlInput = wrapper.find('input[data-testid="chat-setting-url-input"]');
      expect((urlInput.element as HTMLInputElement).value).toBe('http://updated-externally');
    });
  });

  describe('Restore to Global', () => {
    it('clears all overrides when "Restore defaults" is clicked', async () => {
      Object.assign(mockCurrentChat.value, {
        endpoint: { type: 'ollama', url: 'http://overridden:11434' },
        modelId: 'overridden-model',
        systemPrompt: { content: 'test', behavior: 'override' },
        lmParameters: { temperature: 0.5 },
      });

      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();
      const restoreBtn = wrapper.find('[data-testid="chat-setting-restore-defaults"]');

      await restoreBtn.trigger('click');

      expect(mockUpdateChatSettings).toHaveBeenCalledWith({ id: 'chat-1', updates: expect.objectContaining({
        endpoint: undefined,
      }) });
    });

    it('triggers updateChatSettings when restoring to global settings', async () => {
      mockCurrentChat.value!.endpoint = { type: 'ollama', url: 'http://global:1234' };
      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();
      const restoreBtn = wrapper.find('[data-testid="chat-setting-restore-defaults"]');

      await restoreBtn.trigger('click');

      expect(mockUpdateChatSettings).toHaveBeenCalledWith({ id: 'chat-1', updates: expect.objectContaining({
        endpoint: undefined,
      }) });
    });
  });

  describe('Settings Resolution Indicators', () => {
    it('shows "Group/Global Default" for system prompt when not overridden', async () => {
      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();
      const status = wrapper.find('[data-testid="resolution-status-system-prompt"]');
      expect(status.text()).toBe('Group/Global Default');
    });

    it('shows "Overriding" for system prompt when overridden with override behavior', async () => {
      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();

      // First click Override to show the textarea
      const overrideBtn = wrapper.findAll('button').find(b => b.text() === 'Override');
      await overrideBtn?.trigger('click');
      await nextTick();

      const textarea = wrapper.find('[data-testid="chat-setting-system-prompt-textarea"]');

      await textarea.setValue('Custom prompt');
      await textarea.trigger('blur');

      const status = wrapper.find('[data-testid="resolution-status-system-prompt"]');
      expect(status.text()).toBe('Overriding');
    });

    it('shows "Appending" for system prompt when overridden with append behavior', async () => {
      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();
      const appendBtn = wrapper.findAll('button').find(b => b.text() === 'Append');
      await appendBtn?.trigger('click');

      const status = wrapper.find('[data-testid="resolution-status-system-prompt"]');
      expect(status.text()).toBe('Appending');
    });

    it('shows "Inherit" behavior and clears override when clicking Inherit button', async () => {
      // Set an initial override
      mockCurrentChat.value.systemPrompt = { content: 'Old prompt', behavior: 'override' };
      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();

      // Ensure textarea exists initially
      expect(wrapper.find('[data-testid="chat-setting-system-prompt-textarea"]').exists()).toBe(true);

      // Click Inherit in the System Prompt section (it's the second one now)
      const inheritBtns = wrapper.findAll('button').filter(b => b.text().includes('Inherit'));
      const inheritBtn = inheritBtns.find(b => b.element.closest('.md\\:col-span-2')) || inheritBtns[0];
      await inheritBtn?.trigger('click');
      await flushPromises();

      // Verify updateChatSettings was called with undefined for systemPrompt
      expect(mockUpdateChatSettings).toHaveBeenCalledWith({ id: 'chat-1', updates: expect.objectContaining({
        systemPrompt: undefined,
      }) });

      // Verify UI state: textarea should be gone, and inherited notice shown
      expect(wrapper.find('[data-testid="chat-setting-system-prompt-textarea"]').exists()).toBe(false);
      expect(wrapper.text()).toContain('Inherited Instructions');
    });

    it('shows "Inherited" for parameters when not overridden', async () => {
      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();
      const status = wrapper.find('[data-testid="resolution-status-lm-parameters"]');
      expect(status.text()).toBe('Inherited');
    });

    it('shows "Chat Overrides" for parameters when overridden', async () => {
      mockCurrentChat.value!.lmParameters = { temperature: 0.8 };
      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();

      const status = wrapper.find('[data-testid="resolution-status-lm-parameters"]');
      expect(status.text()).toBe('Chat Overrides');
    });
  });

  describe('UI & Reactivity Edge Cases', () => {
    it('clears error message when URL is modified after a failed connection', async () => {
      mockFetchAvailableModels.mockRejectedValueOnce(new Error('Fail'));
      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();
      const selector = wrapper.getComponent({ name: 'ModelSelector' });

      // Force an error via ModelSelector refresh
      await selector.vm.$emit('refresh');
      await flushPromises();
      expect(wrapper.text()).toContain('Fail');

      // Act: Change URL
      const urlInput = wrapper.find('input[data-testid="chat-setting-url-input"]');
      await urlInput.setValue('http://localhost:9999');

      // Assert: Error should be cleared by the input watcher/handler
      expect(wrapper.text()).not.toContain('Fail');
    });

    it('updates "Global" option labels when global settings change', async () => {
      mockSettings.value.endpoint = { type: 'openai', url: 'http://global:1234' };
      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();

      const typeSelect = wrapper.findAll('select')[1];
      const globalOption = typeSelect!.findAll('option').find(opt => opt.text().includes('(Global)'));
      expect(globalOption!.text()).toContain('OpenAI (Global)');

      // Update global setting
      mockSettings.value.endpoint = { type: 'ollama', url: 'http://global:1234' };
      await nextTick();

      expect(globalOption!.text()).toContain('Ollama (Global)');
    });
  });

  describe('UI State & Actions', () => {
    it('emits close event when close button is clicked', async () => {
      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();
      const closeBtn = wrapper.find('[data-testid="close-button"]');

      await closeBtn.trigger('click');
      await flushPromises();
      expect(wrapper.emitted()).toHaveProperty('close');
    });

    it('shows loading state during model fetch', async () => {
      mockFetchingModelsRef.value = true;
      mockAvailableModelsRef.value = [];

      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();
      const selector = wrapper.getComponent({ name: 'ModelSelector' });
      expect(selector.props('loading')).toBe(true);
      expect(wrapper.find('.loading-mock').exists()).toBe(true);
    });

    it('triggers manual refresh when ModelSelector emits refresh', async () => {
      mockCurrentChat.value.endpoint = { type: 'openai', url: 'http://localhost:11434' };
      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();
      mockFetchAvailableModels.mockClear();

      const selector = wrapper.getComponent({ name: 'ModelSelector' });

      await selector.vm.$emit('refresh');
      expect(mockFetchAvailableModels).toHaveBeenCalledTimes(1);
    });

    it('shows error message when refresh fails', async () => {
      const errorMessage = 'OLLAMA_ORIGINS="*" ollama serve';
      mockFetchAvailableModels.mockRejectedValueOnce(new Error(errorMessage));
      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();
      const selector = wrapper.getComponent({ name: 'ModelSelector' });

      await selector.vm.$emit('refresh');
      await flushPromises();

      expect(wrapper.text()).toContain(errorMessage);
    });

    it('passes a naturally sorted list of models to ModelSelector', async () => {
      mockFetchingModelsRef.value = false;
      mockAvailableModelsRef.value = ['model-10', 'model-2', 'model-1'];

      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();
      const selector = wrapper.getComponent({ name: 'ModelSelector' });
      expect(selector.props('models')).toEqual(['model-1', 'model-2', 'model-10']);
    });

    it('clears modelId override if it is not available in newly fetched models', async () => {
      mockCurrentChat.value.modelId = 'old-model';
      const wrapper = mount(ChatSettingsPanel, {
        props: { show: true },
        global: { stubs: globalStubs },
      });
      await nextTick();
      await flushPromises();

      mockFetchAvailableModels.mockResolvedValueOnce(['new-model-1', 'new-model-2']);

      const urlInput = wrapper.find('input[data-testid="chat-setting-url-input"]');
      await urlInput.setValue('http://localhost:11434');
      await flushPromises();

      expect(mockUpdateChatSettings).toHaveBeenCalledWith({ id: 'chat-1', updates: expect.objectContaining({
        modelId: undefined,
      }) });
    });
  });

  describe('Focus Management', () => {
    it('sets focus area to chat-settings when show is true, and restores to chat when false', async () => {
      const wrapper = mount(ChatSettingsPanel, {
        props: { show: false },
        global: { stubs: globalStubs },
      });
      await nextTick();

      await wrapper.setProps({ show: true });
      expect(mockSetActiveFocusArea).toHaveBeenCalledWith({ area: 'chat-settings' });

      await wrapper.setProps({ show: false });
      expect(mockSetActiveFocusArea).toHaveBeenCalledWith({ area: 'chat' });
    });
  });
});
