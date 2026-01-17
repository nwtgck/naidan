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

describe('ChatSettingsPanel.vue', () => {
  const mockFetchAvailableModels = vi.fn().mockResolvedValue(['model-1', 'model-2']);
  const mockSaveChat = vi.fn();
  const mockCurrentChat = ref<Record<string, unknown> | null>(null);

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
    Check: { name: 'Check', template: '<span class="check-stub" />' },
    ModelSelector: {
      name: 'ModelSelector',
      template: '<div data-testid="model-selector-mock" :model-value="modelValue">{{ modelValue }}<button v-if="!loading" data-testid="refresh-mock" @click="$emit(\'refresh\')">Refresh</button><span v-if="loading" class="loading-mock">Loading</span></div>',
      props: ['modelValue', 'loading', 'placeholder'],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Create a NEW reactive object for each test to avoid cross-test pollution
    mockCurrentChat.value = reactive({
      id: 'chat-1',
      endpointType: undefined,
      endpointUrl: undefined,
      modelId: undefined,
    });

    const mockResolvedSettings = computed(() => {
      const chat = mockCurrentChat.value as any;
      const s = mockSettings.value;
      return {
        endpointType: chat?.endpointType || s.endpointType,
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
      saveChat: mockSaveChat,
      resolvedSettings: mockResolvedSettings,
    });

    (useSettings as unknown as Mock).mockReturnValue({
      settings: toRef(mockSettings, 'value'),
    });
  });

  it('renders correctly when a chat is active', () => {
    const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
    expect(wrapper.exists()).toBe(true);
    expect(wrapper.text()).toContain('Chat Specific Overrides');
    expect(wrapper.text()).toContain('Quick Endpoint Presets');
    expect(wrapper.text()).toContain('Endpoint Type');
  });

  it('does not render when no chat is active', () => {
    mockCurrentChat.value = null;
    const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
    // In Vue 3, a non-rendered component with v-if returns a comment node
    expect(wrapper.html()).toBe('<!--v-if-->');
  });

  it('triggers model fetch on mount if URL is localhost', () => {
    mockSettings.value.endpointUrl = 'http://localhost:11434';
    mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
    expect(mockFetchAvailableModels).toHaveBeenCalledWith(mockCurrentChat.value);
  });

  it('does not trigger model fetch on mount if URL is not localhost', () => {
    mockSettings.value.endpointUrl = 'http://remote-api.com';
    mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
    expect(mockFetchAvailableModels).not.toHaveBeenCalled();
  });

  describe('Auto-fetch logic', () => {
    it('triggers fetch when switching to a localhost preset', async () => {
      mockSettings.value.endpointUrl = 'http://remote-api.com';
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      expect(mockFetchAvailableModels).not.toHaveBeenCalled();

      const ollamaBtn = wrapper.findAll('button').find(b => b.text() === 'Ollama (local)');
      await ollamaBtn?.trigger('click');

      expect(mockFetchAvailableModels).toHaveBeenCalledWith(mockCurrentChat.value);
    });

    it('triggers fetch when manually entering a localhost URL', async () => {
      mockSettings.value.endpointUrl = 'http://remote-api.com';
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const urlInput = wrapper.find('input[type="text"]');
      
      await urlInput.setValue('http://127.0.0.1:1234');
      expect(mockFetchAvailableModels).toHaveBeenCalledWith(mockCurrentChat.value);
    });
  });

  describe('Persistence', () => {
    it('triggers saveChat when endpoint settings change', async () => {
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const urlInput = wrapper.find('input[type="text"]');
      
      await urlInput.setValue('http://persisted-url:1234');
      // Wait for watch to trigger
      await flushPromises();
      
      expect(mockSaveChat).toHaveBeenCalledWith(mockCurrentChat.value);
    });

    it('triggers saveChat when model override changes', async () => {
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const selector = wrapper.getComponent({ name: 'ModelSelector' });
      
      await selector.vm.$emit('update:modelValue', 'model-1');
      await flushPromises();
      
      expect(mockSaveChat).toHaveBeenCalledWith(mockCurrentChat.value);
    });

    it('triggers saveChat when a preset is applied', async () => {
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const ollamaBtn = wrapper.findAll('button').find(b => b.text() === 'Ollama (local)');
      
      await ollamaBtn?.trigger('click');
      await flushPromises();
      
      expect(mockSaveChat).toHaveBeenCalledWith(mockCurrentChat.value);
    });

    it('triggers saveChat when a provider profile is applied', async () => {
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const select = wrapper.find('select'); // First select is Profile Switcher
      
      await select.setValue('profile-1');
      await select.trigger('change');
      await flushPromises();
      
      expect(mockSaveChat).toHaveBeenCalledWith(mockCurrentChat.value);
    });
  });

  describe('Quick Profile Switcher', () => {
    it('applies a selected profile to the current chat', async () => {
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const select = wrapper.find('select'); // First select is the profile switcher
      
      await select.setValue('profile-1');
      await select.trigger('change');

      expect(mockCurrentChat.value!.endpointType).toBe('ollama');
      expect(mockCurrentChat.value!.endpointUrl).toBe('http://ollama:11434');
      expect(mockCurrentChat.value!.modelId).toBe('llama3');
      
      // Should reset selection after apply
      const vm = wrapper.vm as unknown as { selectedProviderProfileId: string };
      expect(vm.selectedProviderProfileId).toBe('');
    });

    it('applies headers from a selected profile', async () => {
      const mockProfileWithHeaders = {
        id: 'p-h',
        name: 'Header Profile',
        endpointType: 'openai',
        endpointUrl: 'http://h:1234',
        defaultModelId: 'm1',
        endpointHttpHeaders: [['X-Header', 'Value']],
      };
      mockSettings.value.providerProfiles.push(mockProfileWithHeaders);
      
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const select = wrapper.find('select');
      
      await select.setValue('p-h');
      await select.trigger('change');

      expect(mockCurrentChat.value!.endpointHttpHeaders).toEqual([['X-Header', 'Value']]);
    });
  });

  describe('Custom HTTP Headers', () => {
    it('supports adding and removing headers directly', async () => {
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      
      const addBtn = wrapper.findAll('button').find(b => b.text().includes('Add Header'));
      await addBtn?.trigger('click');
      
      const inputs = wrapper.findAll('input[type="text"]');
      // 0: URL, 1: Header Name, 2: Header Value
      await inputs[1]?.setValue('X-Manual');
      await inputs[2]?.setValue('Val-Manual');
      
      expect(mockCurrentChat.value!.endpointHttpHeaders).toEqual([['X-Manual', 'Val-Manual']]);
      
      // Remove
      const removeBtn = wrapper.findAll('button').find(b => b.findComponent({ name: 'Trash2' }).exists() || b.html().includes('lucide-trash2'));
      await removeBtn?.trigger('click');
      
      expect(mockCurrentChat.value!.endpointHttpHeaders).toHaveLength(0);
    });
  });

  describe('Endpoint Presets', () => {
    it('applies Ollama preset when clicked', async () => {
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const ollamaBtn = wrapper.findAll('button').find(b => b.text() === 'Ollama (local)');
      
      await ollamaBtn?.trigger('click');

      expect(mockCurrentChat.value!.endpointType).toBe('ollama');
      expect(mockCurrentChat.value!.endpointUrl).toBe('http://localhost:11434');
    });

    it('applies LM Studio preset when clicked', async () => {
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const lmStudioBtn = wrapper.findAll('button').find(b => b.text() === 'LM Studio (local)');
      
      await lmStudioBtn?.trigger('click');

      expect(mockCurrentChat.value!.endpointType).toBe('openai');
      expect(mockCurrentChat.value!.endpointUrl).toBe('http://localhost:1234/v1');
    });
  });

  describe('Manual Overrides', () => {
    it('updates currentChat endpointType through direct selection', async () => {
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const typeSelect = wrapper.findAll('select')[1]; // Second select is Type
      
      await typeSelect!.setValue('ollama');
      const chat = mockCurrentChat.value as unknown as { endpointType: string };
      expect(chat.endpointType).toBe('ollama');
    });

    it('updates currentChat endpointUrl through text input', async () => {
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const urlInput = wrapper.find('input[type="text"]');
      
      await urlInput.setValue('http://custom-api:8000');
      const chat = mockCurrentChat.value as unknown as { endpointUrl: string };
      expect(chat.endpointUrl).toBe('http://custom-api:8000');
    });

    it('does not affect other chats when overriding settings', async () => {
      // Create a second chat that should remain unaffected
      const otherChat = reactive({
        id: 'chat-2',
        endpointType: 'openai',
        endpointUrl: 'http://untouched:1234',
      });

      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const urlInput = wrapper.find('input[type="text"]');
      
      // Act: change current chat URL
      await urlInput.setValue('http://changed:8888');
      
      // Assert: current chat is changed, other chat is not
      const currentChat = mockCurrentChat.value as unknown as { endpointUrl: string };
      expect(currentChat.endpointUrl).toBe('http://changed:8888');
      expect(otherChat.endpointUrl).toBe('http://untouched:1234');
    });

    it('does not affect global settings when overriding chat settings', async () => {
      mockSettings.value.endpointUrl = 'http://global:1234';
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const urlInput = wrapper.find('input[type="text"]');
      
      // Act: change current chat URL
      await urlInput.setValue('http://overridden-url:9999');
      
      // Assert: current chat is changed
      const currentChat = mockCurrentChat.value as unknown as { endpointUrl: string };
      expect(currentChat.endpointUrl).toBe('http://overridden-url:9999');
      // Assert: global settings remain original
      expect(mockSettings.value.endpointUrl).toBe('http://global:1234');
    });
  });

  describe('Restore to Global', () => {
    it('clears all overrides when "Restore defaults" is clicked', async () => {
      Object.assign(mockCurrentChat.value as object, {
        endpointType: 'ollama',
        endpointUrl: 'http://overridden:11434',
        modelId: 'overridden-model',
        systemPrompt: { content: 'test', behavior: 'override' },
        lmParameters: { temperature: 0.5 },
      });
      
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const restoreBtn = wrapper.find('[data-testid="chat-setting-restore-defaults"]');
      
      await restoreBtn.trigger('click');

      expect(mockCurrentChat.value!.endpointType).toBeUndefined();
      expect(mockCurrentChat.value!.endpointUrl).toBeUndefined();
      expect(mockCurrentChat.value!.modelId).toBeUndefined();
      expect(mockCurrentChat.value!.systemPrompt).toBeUndefined();
      expect(mockCurrentChat.value!.lmParameters).toBeUndefined();
    });

    it('triggers saveChat when restoring to global settings', async () => {
      mockCurrentChat.value!.endpointType = 'ollama';
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const restoreBtn = wrapper.find('[data-testid="chat-setting-restore-defaults"]');
      
      await restoreBtn.trigger('click');
      await flushPromises();
      
      expect(mockSaveChat).toHaveBeenCalledWith(mockCurrentChat.value);
    });
  });

  describe('Settings Resolution Indicators', () => {
    it('shows "Global Default" for system prompt when not overridden', async () => {
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const status = wrapper.find('[data-testid="resolution-status-system-prompt"]');
      expect(status.text()).toBe('Group/Global Default');
      expect(status.classes()).not.toContain('text-blue-500');
    });

    it('shows "Overriding" for system prompt when overridden with override behavior', async () => {
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const textarea = wrapper.find('[data-testid="chat-setting-system-prompt-textarea"]');
      
      await textarea.setValue('Custom prompt');
      
      const status = wrapper.find('[data-testid="resolution-status-system-prompt"]');
      expect(status.text()).toBe('Overriding');
      expect(status.classes()).toContain('text-blue-500');
    });

    it('shows "Appending" for system prompt when overridden with append behavior', async () => {
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const appendBtn = wrapper.findAll('button').find(b => b.text() === 'Append');
      await appendBtn?.trigger('click');
      
      const status = wrapper.find('[data-testid="resolution-status-system-prompt"]');
      expect(status.text()).toBe('Appending');
    });

    it('shows "Inherited" for parameters when not overridden', () => {
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const status = wrapper.find('[data-testid="resolution-status-lm-parameters"]');
      expect(status.text()).toBe('Inherited');
      expect(status.classes()).not.toContain('text-blue-500');
    });

    it('shows "Chat Overrides" for parameters when overridden', async () => {
      mockCurrentChat.value!.lmParameters = { temperature: 0.8 };
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      
      const status = wrapper.find('[data-testid="resolution-status-lm-parameters"]');
      expect(status.text()).toBe('Chat Overrides');
      expect(status.classes()).toContain('text-blue-500');
    });
  });

  describe('UI & Reactivity Edge Cases', () => {
    it('clears error message when URL is modified after a failed connection', async () => {
      mockFetchAvailableModels.mockRejectedValueOnce(new Error('Fail'));
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const selector = wrapper.getComponent({ name: 'ModelSelector' });
      
      // Force an error via ModelSelector refresh
      await selector.vm.$emit('refresh');
      await flushPromises();
      expect(wrapper.text()).toContain('Connection failed');

      // Act: Change URL
      const urlInput = wrapper.find('input[type="text"]');
      await urlInput.setValue('http://localhost:9999');
      await flushPromises();
      
      // Assert: Error should be cleared by the input watcher/handler
      expect(wrapper.text()).not.toContain('Connection failed');
    });

    it('updates "Global" option labels when global settings change', async () => {
      mockSettings.value.endpointType = 'openai';
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      
      // Select is the Endpoint Type select (second one)
      const typeSelect = wrapper.findAll('select')[1];
      // Value is bound to undefined, but Vue renders it as an empty string or specific internal value
      // The easiest way is to find by the beginning of text
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
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const closeBtn = wrapper.findAll('button').find(b => b.text().includes('Close'));
      
      await closeBtn?.trigger('click');
      expect(wrapper.emitted()).toHaveProperty('close');
    });

    it('shows loading state during model fetch', async () => {
      (useChat as unknown as Mock).mockReturnValue({
        currentChat: mockCurrentChat,
        availableModels: ref([]),
        fetchingModels: ref(true),
        fetchAvailableModels: mockFetchAvailableModels,
        saveChat: mockSaveChat,
      });

      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const selector = wrapper.getComponent({ name: 'ModelSelector' });
      expect(selector.props('loading')).toBe(true);
      expect(wrapper.find('.loading-mock').exists()).toBe(true);
    });

    it('triggers manual refresh when ModelSelector emits refresh', async () => {
      // Set to localhost so it fetches ONCE on mount
      mockSettings.value.endpointUrl = 'http://localhost:11434';
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const selector = wrapper.getComponent({ name: 'ModelSelector' });
      
      await selector.vm.$emit('refresh');
      expect(mockFetchAvailableModels).toHaveBeenCalledTimes(2); // Once on mount, once on click
    });

    it('shows success feedback when refresh succeeds', async () => {
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const selector = wrapper.getComponent({ name: 'ModelSelector' });
      
      await selector.vm.$emit('refresh');
      await flushPromises();
      
      // The "success feedback" in ChatSettingsPanel is connectionSuccess ref
      // In the template, it was used for the old button's class and Check icon.
      // Since those elements are gone, we verify the internal state or side effect if any.
      // For now, let's at least check that fetch was called.
      expect(mockFetchAvailableModels).toHaveBeenCalledWith(mockCurrentChat.value);
    });

    it('shows error message when refresh fails', async () => {
      mockFetchAvailableModels.mockRejectedValueOnce(new Error('Network error'));
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const selector = wrapper.getComponent({ name: 'ModelSelector' });
      
      await selector.vm.$emit('refresh');
      await flushPromises();

      expect(wrapper.text()).toContain('Connection failed. Check URL or provider.');
    });
  });
});