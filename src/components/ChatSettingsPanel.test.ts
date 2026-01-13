import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref, reactive, toRef, nextTick } from 'vue';
import ChatSettingsPanel from './ChatSettingsPanel.vue';
import { useChat } from '../composables/useChat';
import { useSettings } from '../composables/useSettings';
import { Loader2, RefreshCw } from 'lucide-vue-next';

// --- Mocks ---

vi.mock('../composables/useChat', () => ({
  useChat: vi.fn(),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: vi.fn(),
}));

describe('ChatSettingsPanel.vue', () => {
  const mockFetchAvailableModels = vi.fn();
  const mockSaveCurrentChat = vi.fn();
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
  };

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Create a NEW reactive object for each test to avoid cross-test pollution
    mockCurrentChat.value = reactive({
      id: 'chat-1',
      endpointType: undefined,
      endpointUrl: undefined,
      overrideModelId: undefined,
    });

    (useChat as unknown as Mock).mockReturnValue({
      currentChat: mockCurrentChat,
      availableModels: ref(['model-1', 'model-2']),
      fetchingModels: ref(false),
      fetchAvailableModels: mockFetchAvailableModels,
      saveCurrentChat: mockSaveCurrentChat,
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
    expect(mockFetchAvailableModels).toHaveBeenCalled();
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

      expect(mockFetchAvailableModels).toHaveBeenCalled();
    });

    it('triggers fetch when manually entering a localhost URL', async () => {
      mockSettings.value.endpointUrl = 'http://remote-api.com';
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const urlInput = wrapper.find('input[type="text"]');
      
      await urlInput.setValue('http://127.0.0.1:1234');
      expect(mockFetchAvailableModels).toHaveBeenCalled();
    });
  });

  describe('Persistence', () => {
    it('triggers saveCurrentChat when endpoint settings change', async () => {
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const urlInput = wrapper.find('input[type="text"]');
      
      await urlInput.setValue('http://persisted-url:1234');
      // Wait for watch to trigger
      await flushPromises();
      
      expect(mockSaveCurrentChat).toHaveBeenCalled();
    });

    it('triggers saveCurrentChat when model override changes', async () => {
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const modelSelect = wrapper.find('[data-testid="chat-setting-model-select"]');
      
      await modelSelect.setValue('model-1');
      await flushPromises();
      
      expect(mockSaveCurrentChat).toHaveBeenCalled();
    });

    it('triggers saveCurrentChat when a preset is applied', async () => {
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const ollamaBtn = wrapper.findAll('button').find(b => b.text() === 'Ollama (local)');
      
      await ollamaBtn?.trigger('click');
      await flushPromises();
      
      expect(mockSaveCurrentChat).toHaveBeenCalled();
    });

    it('triggers saveCurrentChat when a provider profile is applied', async () => {
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const select = wrapper.find('select'); // First select is Profile Switcher
      
      await select.setValue('profile-1');
      await select.trigger('change');
      await flushPromises();
      
      expect(mockSaveCurrentChat).toHaveBeenCalled();
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
      expect(mockCurrentChat.value!.overrideModelId).toBe('llama3');
      
      // Should reset selection after apply
      const vm = wrapper.vm as unknown as { selectedProviderProfileId: string };
      expect(vm.selectedProviderProfileId).toBe('');
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
        overrideModelId: 'overridden-model',
        systemPrompt: { content: 'test', behavior: 'override' },
        lmParameters: { temperature: 0.5 },
      });
      
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const restoreBtn = wrapper.find('[data-testid="chat-setting-restore-defaults"]');
      
      await restoreBtn.trigger('click');

      expect(mockCurrentChat.value!.endpointType).toBeUndefined();
      expect(mockCurrentChat.value!.endpointUrl).toBeUndefined();
      expect(mockCurrentChat.value!.overrideModelId).toBeUndefined();
      expect(mockCurrentChat.value!.systemPrompt).toBeUndefined();
      expect(mockCurrentChat.value!.lmParameters).toBeUndefined();
    });

    it('triggers saveCurrentChat when restoring to global settings', async () => {
      mockCurrentChat.value!.endpointType = 'ollama';
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const restoreBtn = wrapper.find('[data-testid="chat-setting-restore-defaults"]');
      
      await restoreBtn.trigger('click');
      await flushPromises();
      
      expect(mockSaveCurrentChat).toHaveBeenCalled();
    });
  });

  describe('Settings Resolution Indicators', () => {
    it('shows "Global Default" for system prompt when not overridden', () => {
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const status = wrapper.find('[data-testid="resolution-status-system-prompt"]');
      expect(status.text()).toBe('Global Default');
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
      const refreshBtn = wrapper.find('[data-testid="chat-setting-refresh-models"]');
      
      // Force an error
      await refreshBtn.trigger('click');
      await flushPromises();
      expect(wrapper.text()).toContain('Connection failed');

      // Act: Change URL
      const urlInput = wrapper.find('input[type="text"]');
      await urlInput.setValue('http://localhost:9999');
      
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
      const globalOption = typeSelect!.findAll('option').find(opt => opt.text().includes('Global'));
      expect(globalOption!.text()).toContain('Global (openai)');

      // Update global setting
      mockSettings.value.endpointType = 'ollama';
      await nextTick();
      
      expect(globalOption!.text()).toContain('Global (ollama)');
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
        saveCurrentChat: mockSaveCurrentChat,
      });

      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      expect(wrapper.findComponent(Loader2).exists()).toBe(true);
      expect(wrapper.findComponent(RefreshCw).exists()).toBe(false);
    });

    it('triggers manual refresh when refresh button is clicked', async () => {
      // Set to localhost so it fetches ONCE on mount
      mockSettings.value.endpointUrl = 'http://localhost:11434';
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const refreshBtn = wrapper.find('[data-testid="chat-setting-refresh-models"]');
      
      await refreshBtn.trigger('click');
      expect(mockFetchAvailableModels).toHaveBeenCalledTimes(2); // Once on mount, once on click
    });

    it('shows success feedback when refresh succeeds', async () => {
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const refreshBtn = wrapper.find('[data-testid="chat-setting-refresh-models"]');
      
      await refreshBtn.trigger('click');
      await flushPromises();
      
      expect(refreshBtn.classes()).toContain('bg-green-50');
      expect(wrapper.find('[data-testid="chat-setting-refresh-success-icon"]').exists()).toBe(true);
    });

    it('shows error message when refresh fails', async () => {
      mockFetchAvailableModels.mockRejectedValueOnce(new Error('Network error'));
      const wrapper = mount(ChatSettingsPanel, { global: { stubs: globalStubs } });
      const refreshBtn = wrapper.find('[data-testid="chat-setting-refresh-models"]');
      
      await refreshBtn.trigger('click');
      await flushPromises();

      expect(wrapper.text()).toContain('Connection failed. Check URL or provider.');
    });
  });
});