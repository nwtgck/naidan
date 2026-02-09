import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref, reactive, toRef, nextTick, computed } from 'vue';
import ChatSettingsPanel from './ChatSettingsPanel.vue';
import { useChat } from '../composables/useChat';
import { useSettings } from '../composables/useSettings';

// --- Mocks ---

vi.mock('../composables/useChat', () => ({
  useChat: vi.fn(),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: vi.fn(),
}));

const mockSetActiveFocusArea = vi.fn();

vi.mock('../composables/useLayout', () => ({
  useLayout: () => ({
    setActiveFocusArea: mockSetActiveFocusArea,
  }),
}));

describe('ChatSettingsPanel.vue', () => {
  const mockFetchAvailableModels = vi.fn().mockResolvedValue(['model-1', 'model-2']);
  const mockUpdateChatSettings = vi.fn().mockImplementation((id, updates) => {
    if (mockCurrentChat.value?.id === id) {
      Object.assign(mockCurrentChat.value, updates);
    }
  });
  const mockCurrentChat = ref<any>(null);

  const mockSettings = reactive({
    value: {
      endpointType: 'openai',
      endpointUrl: 'http://global:1234',
      defaultModelId: 'global-model',
      providerProfiles: [
        {
          id: 'profile-1',
          name: 'My Ollama',
          endpointType: 'ollama',
          endpointUrl: 'http://ollama:11434',
          defaultModelId: 'llama3',
        },
      ],
    },
  });

  const globalStubs = {
    X: true,
    RefreshCw: true,
    Globe: true,
    Loader2: true,
    Settings2: true,
    AlertCircle: true,
    TransformersJsUpsell: {
      name: 'TransformersJsUpsell',
      template: '<div data-testid="upsell-stub"></div>',
      props: ['show']
    },
    Check: { name: 'Check', template: '<span class="check-stub" />' },
    ModelSelector: {
      name: 'ModelSelector',
      template: '<div data-testid="model-selector-mock" :model-value="modelValue">{{ modelValue }}<button v-if="!loading" data-testid="refresh-mock" @click="$emit(\'refresh\')">Refresh</button><span v-if="loading" class="loading-mock">Loading</span></div>',
      props: ['modelValue', 'loading', 'placeholder', 'models'],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Reset global settings to a predictable state
    mockSettings.value = {
      endpointType: 'openai',
      endpointUrl: 'http://global:1234',
      defaultModelId: 'global-model',
      providerProfiles: [
        {
          id: 'profile-1',
          name: 'My Ollama',
          endpointType: 'ollama',
          endpointUrl: 'http://ollama:11434',
          defaultModelId: 'llama3',
        },
      ],
    };

    // Create a NEW reactive object for each test to avoid cross-test pollution
    mockCurrentChat.value = reactive({
      id: 'chat-1',
      endpointType: undefined,
      endpointUrl: undefined,
      modelId: undefined,
      endpointHttpHeaders: undefined,
      systemPrompt: undefined,
      lmParameters: undefined,
    });

    const mockResolvedSettings = computed(() => {
      const chat = mockCurrentChat.value as any;
      const s = mockSettings.value;
      const endpointType = chat?.endpointType || s.endpointType;
      return {
        endpointType,
        endpointUrl: chat?.endpointUrl || s.endpointUrl,
        modelId: chat?.modelId || s.defaultModelId,
        sources: {
          endpointType: chat?.endpointType ? 'chat' : 'global',
          endpointUrl: chat?.endpointUrl ? 'chat' : 'global',
          modelId: chat?.modelId ? 'chat' : 'global',
        }
      };
    });

    (useChat as unknown as Mock).mockReturnValue({
      currentChat: mockCurrentChat,
      availableModels: ref(['model-1', 'model-2']),
      fetchingModels: ref(false),
      fetchAvailableModels: mockFetchAvailableModels,
      updateChatSettings: mockUpdateChatSettings,
      resolvedSettings: mockResolvedSettings,
    });

    (useSettings as unknown as Mock).mockReturnValue({
      settings: toRef(mockSettings, 'value'),
    });
  });

  it('hides endpoint URL when effective type is transformers_js', async () => {
    // 1. Local override is transformers_js
    mockCurrentChat.value.endpointType = 'transformers_js';
    const wrapper = mount(ChatSettingsPanel, { 
      props: { show: true },
      global: { stubs: globalStubs } 
    });
    await nextTick();
    expect(wrapper.find('[data-testid="chat-setting-url-input"]').exists()).toBe(false);

    // 2. Local is undefined (inherit), and global is transformers_js
    mockCurrentChat.value = reactive({ id: 'chat-2', endpointType: undefined });
    mockSettings.value.endpointType = 'transformers_js';
    const wrapper2 = mount(ChatSettingsPanel, { 
      props: { show: true },
      global: { stubs: globalStubs } 
    });
    await nextTick();
    expect(wrapper2.find('[data-testid="chat-setting-url-input"]').exists()).toBe(false);
  });

  it('shows upsell component when effective type is transformers_js', async () => {
    mockSettings.value.endpointType = 'openai';
    const wrapper = mount(ChatSettingsPanel, { 
      props: { show: true },
      global: { stubs: globalStubs } 
    });
    await flushPromises();
    await vi.dynamicImportSettled();

    mockSettings.value.endpointType = 'transformers_js';
    await nextTick();
    await flushPromises();
    await vi.dynamicImportSettled();
    
    const upsell = wrapper.findComponent({ name: 'TransformersJsUpsell' });
    expect(upsell.props('show')).toBe(true);
  });

  it('renders correctly when a chat is active', async () => {
    const wrapper = mount(ChatSettingsPanel, { 
      props: { show: true },
      global: { stubs: globalStubs } 
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
      global: { stubs: globalStubs } 
    });
    
    const modalContent = wrapper.find('.modal-content-zoom');
    expect(modalContent.exists()).toBe(true);
  });

  it('does not render when show prop is false', () => {
    const wrapper = mount(ChatSettingsPanel, { 
      props: { show: false },
      global: { stubs: globalStubs } 
    });
    // Look for the overlay which should be missing
    expect(wrapper.find('.fixed.inset-0').exists()).toBe(false);
  });

  it('triggers model fetch on mount if URL is localhost', async () => {
    mockCurrentChat.value.endpointUrl = 'http://localhost:11434';
    mount(ChatSettingsPanel, { 
      props: { show: true },
      global: { stubs: globalStubs } 
    });
    await nextTick();
    expect(mockFetchAvailableModels).toHaveBeenCalled();
  });

  it('does not trigger model fetch on mount if URL is not localhost', async () => {
    mockCurrentChat.value.endpointUrl = 'http://remote-api.com';
    mount(ChatSettingsPanel, { 
      props: { show: true },
      global: { stubs: globalStubs } 
    });
    await nextTick();
    expect(mockFetchAvailableModels).not.toHaveBeenCalled();
  });

  describe('Auto-fetch logic', () => {
    it('triggers fetch when switching to a localhost preset', async () => {
      const wrapper = mount(ChatSettingsPanel, { 
        props: { show: true },
        global: { stubs: globalStubs } 
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
        global: { stubs: globalStubs } 
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
        global: { stubs: globalStubs } 
      });
      await nextTick();
      const urlInput = wrapper.find('input[data-testid="chat-setting-url-input"]');
      
      await urlInput.setValue('http://persisted-url:1234');
      await urlInput.trigger('blur');
      
      expect(mockUpdateChatSettings).toHaveBeenCalledWith('chat-1', expect.objectContaining({
        endpointUrl: 'http://persisted-url:1234'
      }));
    });

    it('triggers updateChatSettings when model override changes', async () => {
      const wrapper = mount(ChatSettingsPanel, { 
        props: { show: true },
        global: { stubs: globalStubs } 
      });
      await nextTick();
      const selector = wrapper.getComponent({ name: 'ModelSelector' });
      
      await selector.vm.$emit('update:modelValue', 'model-1');
      
      expect(mockUpdateChatSettings).toHaveBeenCalledWith('chat-1', expect.objectContaining({
        modelId: 'model-1'
      }));
    });

    it('triggers updateChatSettings when a preset is applied', async () => {
      const wrapper = mount(ChatSettingsPanel, { 
        props: { show: true },
        global: { stubs: globalStubs } 
      });
      await nextTick();
      const ollamaBtn = wrapper.findAll('button').find(b => b.text() === 'Ollama (local)');
      
      await ollamaBtn?.trigger('click');
      
      expect(mockUpdateChatSettings).toHaveBeenCalledWith('chat-1', expect.objectContaining({
        endpointType: 'ollama',
        endpointUrl: 'http://localhost:11434'
      }));
    });

    it('triggers updateChatSettings when a provider profile is applied', async () => {
      const wrapper = mount(ChatSettingsPanel, { 
        props: { show: true },
        global: { stubs: globalStubs } 
      });
      await nextTick();
      const select = wrapper.find('select'); // First select is Profile Switcher
      
      await select.setValue('profile-1');
      await select.trigger('change');
      
      expect(mockUpdateChatSettings).toHaveBeenCalledWith('chat-1', expect.objectContaining({
        endpointType: 'ollama',
        endpointUrl: 'http://ollama:11434'
      }));
    });
  });

  describe('Quick Profile Switcher', () => {
    it('applies a selected profile to the current chat', async () => {
      const wrapper = mount(ChatSettingsPanel, { 
        props: { show: true },
        global: { stubs: globalStubs } 
      });
      await nextTick();
      const select = wrapper.find('select'); // First select is the profile switcher
      
      await select.setValue('profile-1');
      await select.trigger('change');
      await nextTick();

      expect(mockCurrentChat.value!.endpointType).toBe('ollama');
      expect(mockCurrentChat.value!.endpointUrl).toBe('http://ollama:11434');
      
      // Should reset selection after apply
      const vm = wrapper.vm as any;
      expect(vm.selectedProviderProfileId).toBe('');
    });

    it('applies headers from a selected profile', async () => {
      const mockProfileWithHeaders = {
        id: 'p-h',
        name: 'Header Profile',
        endpointType: 'openai',
        endpointUrl: 'http://h:1234',
        defaultModelId: 'm1',
        endpointHttpHeaders: [['X-Header', 'Value']] as [string, string][],
      };
      mockSettings.value.providerProfiles.push(mockProfileWithHeaders);
      
      const wrapper = mount(ChatSettingsPanel, { 
        props: { show: true },
        global: { stubs: globalStubs } 
      });
      await nextTick();
      const select = wrapper.find('select');
      
      await select.setValue('p-h');
      await select.trigger('change');

      expect(mockUpdateChatSettings).toHaveBeenCalledWith('chat-1', expect.objectContaining({
        endpointHttpHeaders: [['X-Header', 'Value']]
      }));
    });
  });

  describe('Custom HTTP Headers', () => {
    it('supports adding and removing headers directly', async () => {
      const wrapper = mount(ChatSettingsPanel, { 
        props: { show: true },
        global: { stubs: globalStubs } 
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
      
      expect(mockUpdateChatSettings).toHaveBeenCalledWith('chat-1', expect.objectContaining({
        endpointHttpHeaders: expect.arrayContaining([['X-Manual', 'Val-Manual']])
      }));
      
      // Remove
      const removeBtn = wrapper.findAll('button').find(b => b.html().includes('lucide-trash2') || b.findComponent({ name: 'Trash2' }).exists());
      await removeBtn?.trigger('click');
      
      expect(mockUpdateChatSettings).toHaveBeenCalledWith('chat-1', expect.objectContaining({
        endpointHttpHeaders: []
      }));
    });
  });

  describe('Endpoint Presets', () => {
    it('applies Ollama preset when clicked', async () => {
      const wrapper = mount(ChatSettingsPanel, { 
        props: { show: true },
        global: { stubs: globalStubs } 
      });
      await nextTick();
      const ollamaBtn = wrapper.findAll('button').find(b => b.text() === 'Ollama (local)');
      
      await ollamaBtn?.trigger('click');

      expect(mockUpdateChatSettings).toHaveBeenCalledWith('chat-1', expect.objectContaining({
        endpointType: 'ollama',
        endpointUrl: 'http://localhost:11434'
      }));
    });

    it('applies LM Studio preset when clicked', async () => {
      const wrapper = mount(ChatSettingsPanel, { 
        props: { show: true },
        global: { stubs: globalStubs } 
      });
      await nextTick();
      const lmStudioBtn = wrapper.findAll('button').find(b => b.text() === 'LM Studio (local)');
      
      await lmStudioBtn?.trigger('click');

      expect(mockUpdateChatSettings).toHaveBeenCalledWith('chat-1', expect.objectContaining({
        endpointType: 'openai',
        endpointUrl: 'http://localhost:1234/v1'
      }));
    });
  });

  describe('Manual Overrides', () => {
    it('updates currentChat endpointType through direct selection', async () => {
      const wrapper = mount(ChatSettingsPanel, { 
        props: { show: true },
        global: { stubs: globalStubs } 
      });
      await nextTick();
      const typeSelect = wrapper.findAll('select')[1]; // Second select is Type
      
      await typeSelect!.setValue('ollama');
      await typeSelect!.trigger('change');
      expect(mockUpdateChatSettings).toHaveBeenCalledWith('chat-1', expect.objectContaining({
        endpointType: 'ollama'
      }));
    });

    it('updates currentChat endpointUrl through text input', async () => {
      const wrapper = mount(ChatSettingsPanel, { 
        props: { show: true },
        global: { stubs: globalStubs } 
      });
      await nextTick();
      const urlInput = wrapper.find('input[data-testid="chat-setting-url-input"]');
      
      await urlInput.setValue('http://custom-api:8000');
      await urlInput.trigger('blur');
      expect(mockUpdateChatSettings).toHaveBeenCalledWith('chat-1', expect.objectContaining({
        endpointUrl: 'http://custom-api:8000'
      }));
    });

    it('does not affect other chats when overriding settings', async () => {
      const wrapper = mount(ChatSettingsPanel, { 
        props: { show: true },
        global: { stubs: globalStubs } 
      });
      await nextTick();
      const urlInput = wrapper.find('input[data-testid="chat-setting-url-input"]');
      
      // Act: change current chat URL
      await urlInput.setValue('http://changed:8888');
      await urlInput.trigger('blur');
      
      expect(mockUpdateChatSettings).toHaveBeenCalledWith('chat-1', expect.objectContaining({
        endpointUrl: 'http://changed:8888'
      }));
    });

    it('does not affect global settings when overriding chat settings', async () => {
      mockSettings.value.endpointUrl = 'http://global:1234';
      const wrapper = mount(ChatSettingsPanel, { 
        props: { show: true },
        global: { stubs: globalStubs } 
      });
      await nextTick();
      const urlInput = wrapper.find('input[data-testid="chat-setting-url-input"]');
      
      // Act: change current chat URL
      await urlInput.setValue('http://overridden-url:9999');
      await urlInput.trigger('blur');
      
      // Assert: global settings remain original
      expect(mockSettings.value.endpointUrl).toBe('http://global:1234');
    });
  });

  describe('Restore to Global', () => {
    it('clears all overrides when "Restore defaults" is clicked', async () => {
      Object.assign(mockCurrentChat.value, {
        endpointType: 'ollama',
        endpointUrl: 'http://overridden:11434',
        modelId: 'overridden-model',
        systemPrompt: { content: 'test', behavior: 'override' },
        lmParameters: { temperature: 0.5 },
      });
      
      const wrapper = mount(ChatSettingsPanel, { 
        props: { show: true },
        global: { stubs: globalStubs } 
      });
      await nextTick();
      const restoreBtn = wrapper.find('[data-testid="chat-setting-restore-defaults"]');
      
      await restoreBtn.trigger('click');

      expect(mockUpdateChatSettings).toHaveBeenCalledWith('chat-1', expect.objectContaining({
        endpointType: undefined,
        endpointUrl: undefined
      }));
    });

    it('triggers updateChatSettings when restoring to global settings', async () => {
      mockCurrentChat.value!.endpointType = 'ollama';
      const wrapper = mount(ChatSettingsPanel, { 
        props: { show: true },
        global: { stubs: globalStubs } 
      });
      await nextTick();
      const restoreBtn = wrapper.find('[data-testid="chat-setting-restore-defaults"]');
      
      await restoreBtn.trigger('click');
      
      expect(mockUpdateChatSettings).toHaveBeenCalledWith('chat-1', expect.objectContaining({
        endpointType: undefined
      }));
    });
  });

  describe('Settings Resolution Indicators', () => {
    it('shows "Group/Global Default" for system prompt when not overridden', async () => {
      const wrapper = mount(ChatSettingsPanel, { 
        props: { show: true },
        global: { stubs: globalStubs } 
      });
      await nextTick();
      const status = wrapper.find('[data-testid="resolution-status-system-prompt"]');
      expect(status.text()).toBe('Group/Global Default');
    });

    it('shows "Overriding" for system prompt when overridden with override behavior', async () => {
      const wrapper = mount(ChatSettingsPanel, { 
        props: { show: true },
        global: { stubs: globalStubs } 
      });
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
        global: { stubs: globalStubs } 
      });
      await nextTick();
      const appendBtn = wrapper.findAll('button').find(b => b.text() === 'Append');
      await appendBtn?.trigger('click');
      
      const status = wrapper.find('[data-testid="resolution-status-system-prompt"]');
      expect(status.text()).toBe('Appending');
    });

    it('shows "Inherited" for parameters when not overridden', async () => {
      const wrapper = mount(ChatSettingsPanel, { 
        props: { show: true },
        global: { stubs: globalStubs } 
      });
      await nextTick();
      const status = wrapper.find('[data-testid="resolution-status-lm-parameters"]');
      expect(status.text()).toBe('Inherited');
    });

    it('shows "Chat Overrides" for parameters when overridden', async () => {
      mockCurrentChat.value!.lmParameters = { temperature: 0.8 };
      const wrapper = mount(ChatSettingsPanel, { 
        props: { show: true },
        global: { stubs: globalStubs } 
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
        global: { stubs: globalStubs } 
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
      mockSettings.value.endpointType = 'openai';
      const wrapper = mount(ChatSettingsPanel, { 
        props: { show: true },
        global: { stubs: globalStubs } 
      });
      await nextTick();
      
      const typeSelect = wrapper.findAll('select')[1];
      const globalOption = typeSelect!.findAll('option').find(opt => opt.text().includes('(Global)'));
      expect(globalOption!.text()).toContain('openai (Global)');

      // Update global setting
      mockSettings.value.endpointType = 'ollama';
      await nextTick();
      
      expect(globalOption!.text()).toContain('ollama (Global)');
    });
  });

  describe('UI State & Actions', () => {
    it('emits close event when close button is clicked', async () => {
      const wrapper = mount(ChatSettingsPanel, { 
        props: { show: true },
        global: { stubs: globalStubs } 
      });
      await nextTick();
      const closeBtn = wrapper.find('[data-testid="close-button"]');
      
      await closeBtn.trigger('click');
      expect(wrapper.emitted()).toHaveProperty('close');
    });

    it('shows loading state during model fetch', async () => {
      (useChat as unknown as Mock).mockReturnValue({
        currentChat: mockCurrentChat,
        availableModels: ref([]),
        fetchingModels: ref(true),
        fetchAvailableModels: mockFetchAvailableModels,
        updateChatSettings: mockUpdateChatSettings,
        resolvedSettings: ref({ sources: {} }),
      });

      const wrapper = mount(ChatSettingsPanel, { 
        props: { show: true },
        global: { stubs: globalStubs } 
      });
      await nextTick();
      const selector = wrapper.getComponent({ name: 'ModelSelector' });
      expect(selector.props('loading')).toBe(true);
      expect(wrapper.find('.loading-mock').exists()).toBe(true);
    });

    it('triggers manual refresh when ModelSelector emits refresh', async () => {
      mockCurrentChat.value.endpointUrl = 'http://localhost:11434';
      const wrapper = mount(ChatSettingsPanel, { 
        props: { show: true },
        global: { stubs: globalStubs } 
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
        global: { stubs: globalStubs } 
      });
      await nextTick();
      const selector = wrapper.getComponent({ name: 'ModelSelector' });
      
      await selector.vm.$emit('refresh');
      await flushPromises();

      expect(wrapper.text()).toContain(errorMessage);
    });

    it('passes a naturally sorted list of models to ModelSelector', async () => {
      (useChat as unknown as Mock).mockReturnValue({
        currentChat: mockCurrentChat,
        availableModels: ref(['model-10', 'model-2', 'model-1']),
        fetchingModels: ref(false),
        fetchAvailableModels: mockFetchAvailableModels,
        updateChatSettings: mockUpdateChatSettings,
        resolvedSettings: ref({ sources: {} }),
      });

      const wrapper = mount(ChatSettingsPanel, { 
        props: { show: true },
        global: { stubs: globalStubs } 
      });
      await nextTick();
      const selector = wrapper.getComponent({ name: 'ModelSelector' });
      expect(selector.props('models')).toEqual(['model-1', 'model-2', 'model-10']);
    });

    it('clears modelId override if it is not available in newly fetched models', async () => {
      mockCurrentChat.value.modelId = 'old-model';
      const wrapper = mount(ChatSettingsPanel, { 
        props: { show: true },
        global: { stubs: globalStubs } 
      });
      await nextTick();
      await flushPromises();

      mockFetchAvailableModels.mockResolvedValueOnce(['new-model-1', 'new-model-2']);

      const urlInput = wrapper.find('input[data-testid="chat-setting-url-input"]');
      await urlInput.setValue('http://localhost:11434');
      await flushPromises();

      expect(mockUpdateChatSettings).toHaveBeenCalledWith('chat-1', expect.objectContaining({
        modelId: undefined
      }));
    });
  });

  describe('Focus Management', () => {
    it('sets focus area to chat-settings when show is true, and restores to chat when false', async () => {
      const wrapper = mount(ChatSettingsPanel, { 
        props: { show: false },
        global: { stubs: globalStubs } 
      });
      await nextTick();
      
      await wrapper.setProps({ show: true });
      expect(mockSetActiveFocusArea).toHaveBeenCalledWith('chat-settings');
      
      await wrapper.setProps({ show: false });
      expect(mockSetActiveFocusArea).toHaveBeenCalledWith('chat');
    });
  });
});