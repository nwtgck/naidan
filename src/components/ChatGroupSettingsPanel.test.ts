import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ChatGroupSettingsPanel from './ChatGroupSettingsPanel.vue';
import { ref, nextTick, reactive, toRef } from 'vue';
import type { ChatGroup } from '@/models/types';

const mocks = vi.hoisted(() => ({
  addMountToChatGroup: vi.fn().mockResolvedValue(undefined),
  removeMountFromChatGroup: vi.fn().mockResolvedValue(undefined),
  updateChatGroupMount: vi.fn().mockResolvedValue(undefined),
  getVolumeDirectoryHandle: vi.fn(),
  openFileExplorer: vi.fn(),
}));

const mockGroup = reactive<ChatGroup>({
  id: 'g1',
  name: 'Test Group',
  items: [],
  updatedAt: 0,
  isCollapsed: false,
  endpoint: undefined,
  modelId: undefined,
  systemPrompt: undefined,
  lmParameters: undefined,
});

const mockSettings = reactive({
  endpointType: 'openai',
  endpointUrl: 'http://global-url',
  defaultModelId: 'global-model',
  providerProfiles: [],
});

const mockUpdateChatGroupMetadata = vi.fn().mockImplementation(({ id, updates }) => {
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
    addMountToChatGroup: mocks.addMountToChatGroup,
    removeMountFromChatGroup: mocks.removeMountFromChatGroup,
    updateChatGroupMount: mocks.updateChatGroupMount,
  }),
}));

vi.mock('../services/storage', () => ({
  storageService: {
    getVolumeDirectoryHandle: mocks.getVolumeDirectoryHandle,
  },
}));

vi.mock('../composables/useFileExplorerModal', () => ({
  useFileExplorerModal: () => ({
    openFileExplorer: mocks.openFileExplorer,
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: toRef(mockSettings),
  }),
}));

const globalStubs = {
  'lucide-vue-next': true,
  'LmParametersEditor': true,
  'TransformersJsUpsell': {
    name: 'TransformersJsUpsell',
    template: '<div data-testid="upsell-stub"></div>',
    props: ['show']
  },
  'ModelSelector': {
    name: 'ModelSelector',
    template: '<div data-testid="model-selector-mock"><button data-testid="refresh-btn" @click="$emit(\'refresh\')">Refresh</button></div>',
    props: ['modelValue', 'models']
  },
};

const mockSetActiveFocusArea = vi.fn();
const mockOpenSearch = vi.fn();

vi.mock('../composables/useLayout', () => ({
  useLayout: () => ({
    setActiveFocusArea: mockSetActiveFocusArea,
  }),
}));

vi.mock('../composables/useGlobalSearch', () => ({
  useGlobalSearch: () => ({
    openSearch: mockOpenSearch,
  }),
}));

describe('ChatGroupSettingsPanel.vue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockGroup, {
      id: 'g1',
      name: 'Test Group',
      endpoint: undefined,
      modelId: undefined,
      autoTitleEnabled: undefined,
      titleModelId: undefined,
      systemPrompt: undefined,
      lmParameters: { reasoning: { effort: undefined } },
      mounts: undefined,
    });
    // Default global settings
    mockSettings.endpointType = 'openai';
    mockSettings.endpointUrl = 'http://global-url';
  });

  it('shows detailed error message when refresh fails', async () => {
    const errorMessage = 'CORS error: OLLAMA_ORIGINS="*"';
    mockFetchAvailableModels.mockRejectedValueOnce(new Error(errorMessage));

    // Customize group to have an endpoint so URL input/error exists
    mockGroup.endpoint = { type: 'ollama', url: 'http://localhost:11434' };

    const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });

    await wrapper.find('[data-testid="refresh-btn"]').trigger('click');
    await nextTick();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(wrapper.text()).toContain(errorMessage);
  });

  it('renders the group name in the header', () => {
    const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
    expect(wrapper.find('h2').text()).toContain('Test Group Settings');
  });

  it('shows the "Active Overrides" badge only when overrides are present', async () => {
    const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
    await nextTick();
    expect(wrapper.text()).not.toContain('Active Overrides');

    mockGroup.modelId = 'some-model';
    await nextTick();
    expect(wrapper.text()).toContain('Active Overrides');
  });

  it('hides the "Active Overrides" badge when endpoint URL is cleared', async () => {
    // Explicitly set title overrides to undefined
    mockGroup.autoTitleEnabled = undefined;
    mockGroup.titleModelId = undefined;

    const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
    await flushPromises();

    // Set an endpoint with URL
    mockGroup.endpoint = { type: 'openai', url: 'http://example.com' };
    await flushPromises();
    expect(wrapper.text()).toContain('Active Overrides');

    // Clear the endpoint entirely to ensure no overrides
    mockGroup.endpoint = undefined;
    await flushPromises();

    // The badge should disappear because there are no longer any overrides
    expect(wrapper.text()).not.toContain('Active Overrides');
  });

  it('toggles endpoint customization via select', async () => {
    const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });

    // Initially showing global default (Inherit)
    // URL input should NOT exist because local endpoint is undefined and global is openai (but local still undefined)
    expect(wrapper.find('[data-testid="group-setting-url-input"]').exists()).toBe(false);

    // Change select to 'ollama'
    const select = wrapper.find('select');
    await select.setValue('ollama');
    await select.trigger('change');

    expect(mockUpdateChatGroupMetadata).toHaveBeenCalledWith({ id: 'g1', updates: expect.objectContaining({
      endpoint: expect.objectContaining({ type: 'ollama' })
    }) });

    await nextTick();
    // Now local endpoint is set, so URL input should exist
    expect(wrapper.find('[data-testid="group-setting-url-input"]').exists()).toBe(true);
  });

  it('hides endpoint URL when effective type is transformers_js', async () => {
    // 1. Local override is transformers_js
    mockGroup.endpoint = { type: 'transformers_js', url: '' };
    const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
    await nextTick();
    expect(wrapper.find('[data-testid="group-setting-url-input"]').exists()).toBe(false);

    // 2. Local is undefined (global inherit), and global is transformers_js
    mockGroup.endpoint = undefined;
    mockSettings.endpointType = 'transformers_js';
    const wrapper2 = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
    await nextTick();
    expect(wrapper2.find('[data-testid="group-setting-url-input"]').exists()).toBe(false);
  });

  it('shows upsell component when effective type is transformers_js', async () => {
    mockSettings.endpointType = 'openai'; // Start with openai
    const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
    await flushPromises();
    await vi.dynamicImportSettled();

    // Switch to transformers_js
    mockSettings.endpointType = 'transformers_js';
    await nextTick();
    await flushPromises();
    await vi.dynamicImportSettled();

    const upsell = wrapper.findComponent({ name: 'TransformersJsUpsell' });
    expect(upsell.props('show')).toBe(true);
  });

  it('updates system prompt behavior correctly', async () => {
    const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });

    // Click Append
    const appendBtn = wrapper.findAll('button').find(b => b.text() === 'Append');
    await appendBtn?.trigger('click');

    expect(mockUpdateChatGroupMetadata).toHaveBeenCalledWith({ id: 'g1', updates: expect.objectContaining({
      systemPrompt: expect.objectContaining({ behavior: 'append' })
    }) });

    // Click Override
    const overrideBtn = wrapper.findAll('button').find(b => b.text() === 'Override');
    await overrideBtn?.trigger('click');

    expect(mockUpdateChatGroupMetadata).toHaveBeenCalledWith({ id: 'g1', updates: expect.objectContaining({
      systemPrompt: expect.objectContaining({ behavior: 'override' })
    }) });
  });

  it('clears system prompt override when clicking Inherit button', async () => {
    mockGroup.systemPrompt = { content: 'group prompt', behavior: 'override' };
    const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
    await nextTick();

    // Ensure textarea exists initially
    expect(wrapper.find('[data-testid="group-setting-system-prompt-textarea"]').exists()).toBe(true);

    // Click Inherit in the System Prompt section
    const inheritBtns = wrapper.findAll('button').filter(b => b.text().includes('Inherit'));
    // The second one is for the system prompt
    const inheritBtn = inheritBtns[1] || inheritBtns[0];
    await inheritBtn?.trigger('click');
    await nextTick();

    expect(mockUpdateChatGroupMetadata).toHaveBeenCalledWith({ id: 'g1', updates: expect.objectContaining({
      systemPrompt: undefined
    }) });

    // Verify UI state
    expect(wrapper.find('[data-testid="group-setting-system-prompt-textarea"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Inherited Instructions');
  });

  it('displays correct resolution status for system prompt', async () => {
    const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
    await nextTick();
    const status = wrapper.find('[data-testid="resolution-status-system-prompt"]');

    expect(status.text()).toBe('Global Default');

    mockGroup.systemPrompt = { content: 'test', behavior: 'append' };
    await nextTick();
    expect(status.text()).toBe('Appending');

    mockGroup.systemPrompt = { content: 'test', behavior: 'override' };
    await nextTick();
    expect(status.text()).toBe('Overriding');
  });

  it('calls updateChatGroupMetadata when settings change', async () => {
    const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
    await nextTick();

    // First click Override to show the textarea
    const overrideBtn = wrapper.findAll('button').find(b => b.text() === 'Override');
    await overrideBtn?.trigger('click');
    await nextTick();

    // Set system prompt via textarea
    const textarea = wrapper.find('[data-testid="group-setting-system-prompt-textarea"]');
    await textarea.setValue('Custom prompt');
    await textarea.trigger('blur');

    expect(mockUpdateChatGroupMetadata).toHaveBeenCalledWith({ id: 'g1', updates: expect.objectContaining({
      systemPrompt: expect.objectContaining({ content: 'Custom prompt' })
    }) });
  });

  it('restores defaults when the button is clicked', async () => {
    mockGroup.modelId = 'overridden';
    mockGroup.systemPrompt = { content: 'prompt', behavior: 'override' };

    const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
    await wrapper.find('[data-testid="group-setting-restore-defaults"]').trigger('click');

    expect(mockUpdateChatGroupMetadata).toHaveBeenCalledWith({ id: 'g1', updates: expect.objectContaining({
      modelId: undefined,
      systemPrompt: undefined
    }) });
  });

  it('passes a naturally sorted list of models to ModelSelector', async () => {
    // We need to set groupModels in the component to trigger the computed property
    // But groupModels is local state populated by fetchModels.
    // Let's mock fetchAvailableModels to return unsorted models and trigger fetch.
    mockFetchAvailableModels.mockResolvedValue(['model-10', 'model-2', 'model-1']);
    mockGroup.endpoint = { type: 'ollama', url: 'http://localhost:11434' };

    const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });

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

    const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
    await flushPromises();

    // Mock fetchAvailableModels to return models NOT including 'old-model'
    mockFetchAvailableModels.mockResolvedValueOnce(['new-model-1', 'new-model-2']);

    const urlInput = wrapper.find('input[data-testid="group-setting-url-input"]');
    // Change URL slightly to trigger auto-fetch (if localhost)
    await urlInput.setValue('http://localhost:11434');
    await flushPromises();

    expect(mockUpdateChatGroupMetadata).toHaveBeenCalledWith({ id: 'g1', updates: expect.objectContaining({
      modelId: undefined
    }) });
  });

  it('sets active focus area to chat-group-settings on click or focus', async () => {
    const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });

    await wrapper.trigger('click');
    expect(mockSetActiveFocusArea).toHaveBeenCalledWith({ area: 'chat-group-settings' });

    mockSetActiveFocusArea.mockClear();
    await wrapper.trigger('focusin');
    expect(mockSetActiveFocusArea).toHaveBeenCalledWith({ area: 'chat-group-settings' });
  });

  it('triggers global search when clicking search button', async () => {
    const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
    await nextTick();

    const searchBtn = wrapper.findAll('button').find(b => b.text().includes('Search Group'));
    await searchBtn?.trigger('click');

    expect(mockOpenSearch).toHaveBeenCalledWith({ groupIds: [mockGroup.id] });
  });

  it('updates group name from model ID when the button is clicked', async () => {
    mockGroup.modelId = 'provider/my-model:latest';
    const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
    await flushPromises();

    const setNameBtn = wrapper.find('[data-testid="group-setting-set-name-from-model"]');
    expect(setNameBtn.exists()).toBe(true);

    await setNameBtn.trigger('click');

    expect(mockUpdateChatGroupMetadata).toHaveBeenCalledWith({ id: 'g1', updates: expect.objectContaining({
      name: 'my-model:latest'
    }) });
  });

  describe('Folders (chat group mounts)', () => {
    it('shows no mount badges when group has no mounts', () => {
      mockGroup.mounts = [];
      const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
      expect(wrapper.find('[data-testid="chat-group-mounts"]').exists()).toBe(false);
    });

    it('renders mount badges for each active mount', async () => {
      mockGroup.mounts = [
        { type: 'volume', volumeId: 'vol-1', mountPath: '/home/user/work', readOnly: false },
        { type: 'volume', volumeId: 'vol-2', mountPath: '/home/user/docs', readOnly: true },
      ];
      const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
      await nextTick();

      const badgeContainer = wrapper.find('[data-testid="chat-group-mounts"]');
      expect(badgeContainer.exists()).toBe(true);
      expect(badgeContainer.findAll('[data-testid="mount-badge"]')).toHaveLength(2);
    });

    it('trims /home/user/ prefix from displayed mount path', async () => {
      mockGroup.mounts = [
        { type: 'volume', volumeId: 'vol-1', mountPath: '/home/user/my-project', readOnly: false },
      ];
      const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
      await nextTick();

      expect(wrapper.find('[data-testid="chat-group-mounts"]').text()).toContain('my-project');
      expect(wrapper.find('[data-testid="chat-group-mounts"]').text()).not.toContain('/home/user/');
    });

    it('calls removeMountFromChatGroup when remove button is clicked', async () => {
      mockGroup.mounts = [
        { type: 'volume', volumeId: 'vol-1', mountPath: '/home/user/work', readOnly: false },
      ];
      const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
      await nextTick();

      await wrapper.find('[data-testid="mount-remove-btn"]').trigger('click');
      await flushPromises();

      expect(mocks.removeMountFromChatGroup).toHaveBeenCalledWith({ groupId: 'g1', volumeId: 'vol-1' });
    });

    it('calls updateChatGroupMount toggling readOnly when lock button is clicked', async () => {
      mockGroup.mounts = [
        { type: 'volume', volumeId: 'vol-1', mountPath: '/home/user/work', readOnly: false },
      ];
      const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
      await nextTick();

      await wrapper.find('[data-testid="mount-toggle-readonly"]').trigger('click');
      await flushPromises();

      expect(mocks.updateChatGroupMount).toHaveBeenCalledWith({
        groupId: 'g1',
        volumeId: 'vol-1',
        mountPath: '/home/user/work',
        readOnly: true,
      });
    });

    it('calls addMountToChatGroup when VolumeCreator emits created', async () => {
      mockGroup.mounts = [];
      const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
      await nextTick();

      const volumeCreator = wrapper.findComponent({ name: 'VolumeCreator' });
      await volumeCreator.vm.$emit('created', { volumeId: 'new-vol', mountPath: '/home/user/new', readOnly: false });
      await flushPromises();

      expect(mocks.addMountToChatGroup).toHaveBeenCalledWith({
        groupId: 'g1',
        mount: { type: 'volume', volumeId: 'new-vol', mountPath: '/home/user/new', readOnly: false },
      });
    });

    it('opens file explorer with group mounts when mount path is clicked', async () => {
      const handle = { kind: 'directory', name: 'work' } as unknown as FileSystemDirectoryHandle;
      mocks.getVolumeDirectoryHandle.mockResolvedValue(handle);
      mockGroup.mounts = [
        { type: 'volume', volumeId: 'vol-1', mountPath: '/home/user/work', readOnly: false },
      ];
      const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
      await nextTick();

      await wrapper.find('[data-testid="mount-open-explorer"]').trigger('click');
      await flushPromises();

      expect(mocks.getVolumeDirectoryHandle).toHaveBeenCalledWith({ volumeId: 'vol-1' });
      expect(mocks.openFileExplorer).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'wesh-mounts',
        rootName: 'Files',
        title: 'Folders',
        initialPath: ['home', 'user', 'work'],
      }));
    });

    it('opens explorer with correct initialPath derived from clicked mount', async () => {
      const handle = { kind: 'directory', name: 'docs' } as unknown as FileSystemDirectoryHandle;
      mocks.getVolumeDirectoryHandle.mockResolvedValue(handle);
      mockGroup.mounts = [
        { type: 'volume', volumeId: 'vol-A', mountPath: '/home/user/alpha', readOnly: true },
        { type: 'volume', volumeId: 'vol-B', mountPath: '/home/user/beta', readOnly: false },
      ];
      const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
      await nextTick();

      // Click the second badge's explorer button
      const explorerBtns = wrapper.findAll('[data-testid="mount-open-explorer"]');
      await explorerBtns[1]!.trigger('click');
      await flushPromises();

      expect(mocks.openFileExplorer).toHaveBeenCalledWith(expect.objectContaining({
        initialPath: ['home', 'user', 'beta'],
      }));
    });
  });
});
