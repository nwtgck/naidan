import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
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

const mockSaveChatGroup = vi.fn();
const mockFetchAvailableModels = vi.fn().mockResolvedValue(['model-a', 'model-b']);

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChatGroup: ref(mockGroup),
    fetchingModels: ref(false),
    saveChatGroup: mockSaveChatGroup,
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
    template: '<div data-testid="model-selector-mock"></div>',
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

  it('renders the group name in the header', () => {
    const wrapper = mount(GroupSettingsPanel, { global: { stubs: globalStubs } });
    expect(wrapper.find('h2').text()).toContain('Test Group Settings');
  });

  it('shows the "Active Overrides" badge only when overrides are present', async () => {
    const wrapper = mount(GroupSettingsPanel, { global: { stubs: globalStubs } });
    expect(wrapper.find('.animate-pulse').exists()).toBe(false);

    mockGroup.modelId = 'some-model';
    await nextTick();
    expect(wrapper.find('.animate-pulse').exists()).toBe(true);
  });

  it('toggles endpoint customization', async () => {
    const wrapper = mount(GroupSettingsPanel, { global: { stubs: globalStubs } });
    
    // Initially showing global default
    expect(wrapper.find('[data-testid="group-setting-url-input"]').exists()).toBe(false);
    
    // Click customize
    await wrapper.find('button.text-blue-600').trigger('click');
    expect(mockGroup.endpoint).toBeDefined();
    expect(mockGroup.endpoint?.type).toBe('openai');
    
    await nextTick();
    expect(wrapper.find('[data-testid="group-setting-url-input"]').exists()).toBe(true);
  });

  it('updates system prompt behavior correctly', async () => {
    const wrapper = mount(GroupSettingsPanel, { global: { stubs: globalStubs } });
    
    // Click Append
    const appendBtn = wrapper.findAll('button').find(b => b.text() === 'Append');
    await appendBtn?.trigger('click');
    
    expect(mockGroup.systemPrompt?.behavior).toBe('append');
    
    // Click Override
    const overrideBtn = wrapper.findAll('button').find(b => b.text() === 'Override');
    await overrideBtn?.trigger('click');
    
    expect(mockGroup.systemPrompt?.behavior).toBe('override');
  });

  it('displays correct resolution status for system prompt', async () => {
    const wrapper = mount(GroupSettingsPanel, { global: { stubs: globalStubs } });
    const status = wrapper.find('[data-testid="resolution-status-system-prompt"]');
    
    expect(status.text()).toBe('Global Default');
    
    mockGroup.systemPrompt = { content: 'test', behavior: 'append' };
    await nextTick();
    expect(status.text()).toBe('Appending');
    
    mockGroup.systemPrompt.behavior = 'override';
    await nextTick();
    expect(status.text()).toBe('Overriding');
  });

  it('calls saveChatGroup when settings change', async () => {
    mount(GroupSettingsPanel, { global: { stubs: globalStubs } });
    
    mockGroup.modelId = 'new-model';
    await nextTick();
    // Watcher is deep, so it triggers
    expect(mockSaveChatGroup).toHaveBeenCalled();
  });

  it('restores defaults when the button is clicked', async () => {
    mockGroup.modelId = 'overridden';
    mockGroup.systemPrompt = { content: 'prompt', behavior: 'override' };
    
    const wrapper = mount(GroupSettingsPanel, { global: { stubs: globalStubs } });
    await wrapper.find('[data-testid="group-setting-restore-defaults"]').trigger('click');
    
    expect(mockGroup.modelId).toBeUndefined();
    expect(mockGroup.systemPrompt).toBeUndefined();
  });
});