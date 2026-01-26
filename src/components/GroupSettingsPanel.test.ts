import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import GroupSettingsPanel from './GroupSettingsPanel.vue';
import { ref, nextTick, reactive } from 'vue';
import type { ChatGroup } from '../models/types';

const mockGroup = reactive<ChatGroup>({
  id: 'g1',
  name: 'Test Group',
  items: [],
  updatedAt: 0,
  isCollapsed: false,
  endpoint: undefined,
  modelId: undefined,
  systemPrompt: undefined,
  lmParameters: {},
});

const mockSettings = {
  endpointType: 'openai',
  endpointUrl: 'http://global-url',
  defaultModelId: 'global-model',
  providerProfiles: [],
};

const mockUpdateChatGroupMetadata = vi.fn().mockImplementation((id, updates) => {
  if (mockGroup.id === id) {
    Object.assign(mockGroup, updates);
  }
});
const mockFetchAvailableModels = vi.fn().mockResolvedValue(['model-a', 'model-b']);

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChatGroup: ref(mockGroup),
    fetchingModels: ref(false),
    updateChatGroupMetadata: mockUpdateChatGroupMetadata,
    fetchAvailableModels: mockFetchAvailableModels,
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref(mockSettings),
  }),
}));

const globalStubs = {
  'lucide-vue-next': true,
  'LmParametersEditor': true,
  'ModelSelector': {
    name: 'ModelSelector',
    template: '<div data-testid="model-selector-mock"><button data-testid="refresh-btn" @click="$emit(\'refresh\')">Refresh</button></div>',
    props: ['modelValue', 'models']
  },
};

describe('GroupSettingsPanel.vue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockGroup, {
      id: 'g1',
      name: 'Test Group',
      endpoint: undefined,
      modelId: undefined,
      systemPrompt: undefined,
      lmParameters: {},
    });
  });

  it('shows detailed error message when refresh fails', async () => {
    const errorMessage = 'CORS error: OLLAMA_ORIGINS="*"';
    mockFetchAvailableModels.mockRejectedValueOnce(new Error(errorMessage));
    
    // Customize group to have an endpoint so URL input/error exists
    mockGroup.endpoint = { type: 'ollama', url: 'http://localhost:11434' };
    
    const wrapper = mount(GroupSettingsPanel, { global: { stubs: globalStubs } });
    
    await wrapper.find('[data-testid="refresh-btn"]').trigger('click');
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 0)); 
    
    expect(wrapper.text()).toContain(errorMessage);
  });

  it('renders the group name in the header', () => {
    const wrapper = mount(GroupSettingsPanel, { global: { stubs: globalStubs } });
    expect(wrapper.find('h2').text()).toContain('Test Group Settings');
  });

  it('shows the "Active Overrides" badge only when overrides are present', async () => {
    const wrapper = mount(GroupSettingsPanel, { global: { stubs: globalStubs } });
    await nextTick();
    expect(wrapper.text()).not.toContain('Active Overrides');

    mockGroup.modelId = 'some-model';
    await nextTick();
    expect(wrapper.text()).toContain('Active Overrides');
  });

  it('toggles endpoint customization', async () => {
    const wrapper = mount(GroupSettingsPanel, { global: { stubs: globalStubs } });
    
    // Initially showing global default
    expect(wrapper.find('[data-testid="group-setting-url-input"]').exists()).toBe(false);
    
    // Click customize
    await wrapper.find('button.text-blue-600').trigger('click');
    
    expect(mockUpdateChatGroupMetadata).toHaveBeenCalledWith('g1', expect.objectContaining({
      endpoint: expect.objectContaining({ type: 'openai' })
    }));
    
    await nextTick();
    expect(wrapper.find('[data-testid="group-setting-url-input"]').exists()).toBe(true);
  });

  it('updates system prompt behavior correctly', async () => {
    const wrapper = mount(GroupSettingsPanel, { global: { stubs: globalStubs } });
    
    // Click Append
    const appendBtn = wrapper.findAll('button').find(b => b.text() === 'Append');
    await appendBtn?.trigger('click');
    
    expect(mockUpdateChatGroupMetadata).toHaveBeenCalledWith('g1', expect.objectContaining({
      systemPrompt: expect.objectContaining({ behavior: 'append' })
    }));
    
    // Click Override
    const overrideBtn = wrapper.findAll('button').find(b => b.text() === 'Override');
    await overrideBtn?.trigger('click');
    
    expect(mockUpdateChatGroupMetadata).toHaveBeenCalledWith('g1', expect.objectContaining({
      systemPrompt: expect.objectContaining({ behavior: 'override' })
    }));
  });

  it('displays correct resolution status for system prompt', async () => {
    const wrapper = mount(GroupSettingsPanel, { global: { stubs: globalStubs } });
    await nextTick();
    const status = wrapper.find('[data-testid="resolution-status-system-prompt"]');
    
    expect(status.text()).toBe('Global Default');
    
    mockGroup.systemPrompt = { content: 'test', behavior: 'append' };
    await nextTick();
    expect(status.text()).toBe('Appending');
    
    mockGroup.systemPrompt.behavior = 'override';
    await nextTick();
    expect(status.text()).toBe('Overriding');
  });

  it('calls updateChatGroupMetadata when settings change', async () => {
    const wrapper = mount(GroupSettingsPanel, { global: { stubs: globalStubs } });
    
    // Set system prompt via textarea
    const textarea = wrapper.find('[data-testid="group-setting-system-prompt-textarea"]');
    await textarea.setValue('Custom prompt');
    await textarea.trigger('blur');
    
    expect(mockUpdateChatGroupMetadata).toHaveBeenCalledWith('g1', expect.objectContaining({
      systemPrompt: expect.objectContaining({ content: 'Custom prompt' })
    }));
  });

  it('restores defaults when the button is clicked', async () => {
    mockGroup.modelId = 'overridden';
    mockGroup.systemPrompt = { content: 'prompt', behavior: 'override' };
    
    const wrapper = mount(GroupSettingsPanel, { global: { stubs: globalStubs } });
    await wrapper.find('[data-testid="group-setting-restore-defaults"]').trigger('click');
    
    expect(mockUpdateChatGroupMetadata).toHaveBeenCalledWith('g1', expect.objectContaining({
      modelId: undefined,
      systemPrompt: undefined
    }));
  });

  it('passes a naturally sorted list of models to ModelSelector', async () => {
    // We need to set groupModels in the component to trigger the computed property
    // But groupModels is local state populated by fetchModels.
    // Let's mock fetchAvailableModels to return unsorted models and trigger fetch.
    mockFetchAvailableModels.mockResolvedValue(['model-10', 'model-2', 'model-1']);
    mockGroup.endpoint = { type: 'ollama', url: 'http://localhost:11434' };
    
    const wrapper = mount(GroupSettingsPanel, { global: { stubs: globalStubs } });
    
    // Trigger fetch via refresh button
    await wrapper.find('[data-testid="refresh-btn"]').trigger('click');
    await flushPromises();
    await nextTick();

    const selector = wrapper.getComponent({ name: 'ModelSelector' });
    expect(selector.props('models')).toEqual(['model-1', 'model-2', 'model-10']);
  });

  it('clears modelId override if it is not available in newly fetched models', async () => {
    mockGroup.modelId = 'old-model';
    mockGroup.endpoint = { type: 'openai', url: 'http://localhost:1234' };
    
    const wrapper = mount(GroupSettingsPanel, { global: { stubs: globalStubs } });
    await flushPromises();

    // Mock fetchAvailableModels to return models NOT including 'old-model'
    mockFetchAvailableModels.mockResolvedValueOnce(['new-model-1', 'new-model-2']);

    const urlInput = wrapper.find('input[data-testid="group-setting-url-input"]');
    // Change URL slightly to trigger auto-fetch (if localhost)
    await urlInput.setValue('http://localhost:11434');
    await flushPromises();

    expect(mockUpdateChatGroupMetadata).toHaveBeenCalledWith('g1', expect.objectContaining({
      modelId: undefined
    }));
  });
});
