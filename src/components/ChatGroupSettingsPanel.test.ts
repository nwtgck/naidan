import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ChatGroupSettingsPanel from './ChatGroupSettingsPanel.vue';
import { computed, nextTick, reactive, ref, toRef } from 'vue';
import type { ChatGroup, Settings } from '@/01-models/types';
import { useChatGroupMounts } from '@/composables/chat/useChatGroupMounts';
import { useChatGroups } from '@/composables/chat/useChatGroups';
import { useChatModels } from '@/composables/chat/useChatModels';
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';
import { useSettings } from '@/composables/useSettings';
import { idToRaw, toChatGroupId, toProviderProfileId, toVolumeId } from '@/01-models/ids';
import { applyScopedSettingChangesToChatGroup } from '@/logic/scoped-setting-changes';
import { ensureAllStringsForTest } from '@/strings/test-utils';

const mocks = vi.hoisted(() => ({
  addMountToChatGroup: vi.fn().mockResolvedValue(undefined),
  removeMountFromChatGroup: vi.fn().mockResolvedValue(undefined),
  updateChatGroupMount: vi.fn().mockResolvedValue(undefined),
  getVolumeDirectoryHandle: vi.fn(),
  updateChatGroup: vi.fn(),
  openFileExplorer: vi.fn(),
  fetchingModels: { value: false },
  setActiveFocusArea: vi.fn(),
  openSearch: vi.fn(),
}));

const mockGroup = reactive<ChatGroup>({
  id: toChatGroupId({ raw: 'g1' }),
  name: 'Test Group',
  items: [],
  updatedAt: 0,
  isCollapsed: false,
  endpoint: undefined,
  modelId: undefined,
  systemPrompt: undefined,
  lmParameters: undefined,
});

const mockCurrentGroup = ref<ChatGroup>(mockGroup);

const mockSettings = reactive<Settings>({
  endpoint: { type: 'openai', url: 'http://global-url' },
  defaultModelId: 'global-model',
  autoTitleEnabled: true,
  storageType: 'opfs',
  providerProfiles: [],
  mounts: [],
});

const mockUpdateChatGroupMetadata = vi.fn().mockImplementation(({ id, updates }) => {
  if (mockGroup.id === id) {
    Object.assign(mockGroup, updates);
  }
});
const mockFetchAvailableModels = vi.fn().mockResolvedValue(['model-a', 'model-b']);

function expectLatestGroupUpdate({
  partial,
}: {
  partial: Partial<ChatGroup>,
}) {
  const calls = mockUpdateChatGroupMetadata.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const latest = calls.at(-1)?.[0];
  const { id, ...updates } = partial;
  if (latest && typeof latest === 'object' && 'updates' in latest) {
    expect(latest).toEqual(expect.objectContaining({
      ...(id !== undefined && { id }),
      updates: expect.objectContaining(updates),
    }));
    return;
  }

  expect(latest).toEqual(expect.objectContaining(partial));
}

vi.mock('../00-storage/service', () => ({
  storageService: {
    getVolumeDirectoryHandle: mocks.getVolumeDirectoryHandle,
    updateChatGroup: mocks.updateChatGroup,
  },
}));

vi.mock('../composables/chat/useChatModels', () => ({
  useChatModels: vi.fn(),
}));

vi.mock('../composables/chat/useChatGroups', () => ({
  useChatGroups: vi.fn(),
}));

vi.mock('../composables/chat/useChatGroupMounts', () => ({
  useChatGroupMounts: vi.fn(),
}));

vi.mock('../composables/chat/ui/useCurrentChatState', () => ({
  useCurrentChatState: vi.fn(),
}));

vi.mock('../features/file-explorer/composables/useFileExplorerModal', () => ({
  useFileExplorerModal: () => ({
    openFileExplorer: mocks.openFileExplorer,
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: vi.fn(),
}));

const globalStubs = {
  'lucide-vue-next': true,
  'LmParametersEditor': {
    name: 'LmParametersEditor',
    template: '<div data-testid="lm-parameters-editor-mock"></div>',
    props: ['modelValue'],
  },
  'TransformersJsUpsell': {
    name: 'TransformersJsUpsell',
    template: '<div data-testid="upsell-stub"></div>',
    props: ['show'],
  },
  'ModelSelector': {
    name: 'ModelSelector',
    template: '<div data-testid="model-selector-mock"><button data-testid="refresh-btn" @click="$emit(\'refresh\')">Refresh</button></div>',
    props: ['modelValue', 'models'],
  },
  'ChatGroupToolsSettings': {
    name: 'ChatGroupToolsSettings',
    template: '<div data-testid="chat-group-tools-settings-mock"></div>',
  },
};

vi.mock('../composables/useLayout', () => ({
  useLayout: () => ({
    setActiveFocusArea: mocks.setActiveFocusArea,
  }),
}));

vi.mock('../features/global-search/composables/useGlobalSearch', () => ({
  useGlobalSearch: () => ({
    openSearch: mocks.openSearch,
  }),
}));

describe('ChatGroupSettingsPanel.vue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateChatGroup.mockImplementation(async ({ id, updater }: { id: string, updater: ({ current }: { current: ChatGroup | null }) => ChatGroup }) => {
      if (idToRaw({ id: mockGroup.id }) === id) {
        const next = updater({ current: mockGroup });
        mockUpdateChatGroupMetadata({ id, updates: next });
        Object.assign(mockGroup, next);
      }
    });
    vi.mocked(useCurrentChatState).mockReturnValue({
      currentChatId: computed(() => undefined),
      currentChat: computed(() => null),
      currentChatGroup: computed(() => mockCurrentGroup.value),
      activeMessages: computed(() => []),
      allMessages: computed(() => []),
      resolvedSettings: computed(() => null),
      inheritedSettings: computed(() => null),
      chatGroups: computed(() => []),
      sidebarItems: computed(() => []),
      TEST_ONLY: {},
    } as ReturnType<typeof useCurrentChatState>);
    vi.mocked(useSettings).mockReturnValue({
      settings: toRef(mockSettings),
    } as unknown as ReturnType<typeof useSettings>);
    vi.mocked(useChatGroupMounts).mockReturnValue({
      addMount: vi.fn().mockImplementation(async ({ chatGroupId, mount }) => {
        await mocks.addMountToChatGroup({ groupId: chatGroupId, mount });
      }),
      removeMount: vi.fn().mockImplementation(async ({ chatGroupId, volumeId }) => {
        await mocks.removeMountFromChatGroup({ groupId: chatGroupId, volumeId });
      }),
      updateMount: vi.fn().mockImplementation(async ({ chatGroupId, volumeId, mountPath, readOnly }) => {
        await mocks.updateChatGroupMount({ groupId: chatGroupId, volumeId, mountPath, readOnly });
      }),
      TEST_ONLY: {},
    } as unknown as ReturnType<typeof useChatGroupMounts>);
    vi.mocked(useChatModels).mockReturnValue({
      availableModels: ref([]),
      fetchingModels: computed(() => mocks.fetchingModels.value),
      fetchForChat: vi.fn(),
      fetchForGlobalEndpoint: vi.fn(),
      fetchForEndpoint: async ({ endpoint }) => {
        return await mockFetchAvailableModels({ endpoint });
      },
      TEST_ONLY: {},
    });
    vi.mocked(useChatGroups).mockReturnValue({
      updateChatGroupMetadata: async ({ chatGroupId, updates }) => {
        await mockUpdateChatGroupMetadata({ id: chatGroupId, updates });
      },
      updateScopedSettings: async ({ chatGroupId, changes }) => {
        const current = mockCurrentGroup.value.id === chatGroupId
          ? mockCurrentGroup.value
          : { id: chatGroupId } as ChatGroup;
        const updated = applyScopedSettingChangesToChatGroup({
          current,
          changes,
          updatedAt: Date.now(),
        });
        const updates: Partial<ChatGroup> = {};
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
        mockUpdateChatGroupMetadata({ id: chatGroupId, updates });
      },
      updateToolConfigs: async ({ chatGroupId, updater }) => {
        const toolConfigs = updater({ toolConfigs: mockCurrentGroup.value.toolConfigs });
        mockUpdateChatGroupMetadata({
          id: chatGroupId,
          updates: { toolConfigs },
        });
      },
      updateScopedSettingsAndToolConfigs: async ({ chatGroupId, changes, updater }) => {
        const current = mockCurrentGroup.value.id === chatGroupId
          ? mockCurrentGroup.value
          : { id: chatGroupId } as ChatGroup;
        const updated = applyScopedSettingChangesToChatGroup({
          current,
          changes,
          updatedAt: Date.now(),
        });
        mockUpdateChatGroupMetadata({
          id: chatGroupId,
          updates: {
            ...updated,
            toolConfigs: updater({ toolConfigs: current.toolConfigs }),
          },
        });
      },
      moveChatToGroup: vi.fn(),
      TEST_ONLY: {},
    });
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
    mockCurrentGroup.value = mockGroup;
    // Default global settings
    mockSettings.endpoint = { type: 'openai', url: 'http://global-url' };
    mockSettings.providerProfiles = [];
    mockSettings.experimental = { toolConfigPersistence: 'enabled' };
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

  it('uses localized display names in the inherited endpoint option', async () => {
    await ensureAllStringsForTest({ locale: 'en' });
    mockGroup.endpoint = undefined;
    const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
    const select = wrapper.get('[data-testid="group-setting-endpoint-type-select"]');
    const inheritedOption = () => select.find('option[value="global"]');

    mockSettings.endpoint = { type: 'openai', url: 'http://global-url' };
    await nextTick();
    expect(inheritedOption().text()).toBe('Global (OpenAI)');

    mockSettings.endpoint = { type: 'ollama', url: 'http://global-url' };
    await nextTick();
    expect(inheritedOption().text()).toBe('Global (Ollama)');

    mockSettings.endpoint = { type: 'transformers_js' };
    await nextTick();
    expect(inheritedOption().text()).toBe('Global (Transformers.js)');
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

    expectLatestGroupUpdate({
      partial: {
        id: toChatGroupId({ raw: 'g1' }),
        endpoint: expect.objectContaining({ type: 'ollama' }) as ChatGroup['endpoint'],
      },
    });

    await nextTick();
    // Now local endpoint is set, so URL input should exist
    expect(wrapper.find('[data-testid="group-setting-url-input"]').exists()).toBe(true);
  });

  it('uses the global HTTP endpoint when switching from transformers_js to HTTP', async () => {
    mockSettings.endpoint = {
      type: 'openai',
      url: 'http://global-url/v1',
      httpHeaders: [['X-Global', 'value']],
    };
    mockGroup.endpoint = { type: 'transformers_js' };

    const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
    await nextTick();

    await wrapper.get('[data-testid="group-setting-endpoint-type-select"]').setValue('ollama');
    await flushPromises();

    expectLatestGroupUpdate({
      partial: {
        id: toChatGroupId({ raw: 'g1' }),
        endpoint: {
          type: 'ollama',
          url: 'http://global-url/v1',
          httpHeaders: [['X-Global', 'value']],
        },
      },
    });
  });

  it('removes_HTTP_fields_when_applying_a_transformers_js_profile', async () => {
    mockSettings.providerProfiles = [{
      id: toProviderProfileId({ raw: 'p-transformers' }),
      name: 'Transformers.js Profile',
      endpoint: { type: 'transformers_js' },
    }];
    mockGroup.endpoint = {
      type: 'openai',
      url: 'http://old.test/v1',
      httpHeaders: [['X-Old', 'value']],
    };

    const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
    await nextTick();

    const profileSelect = wrapper.find('select');
    await profileSelect.setValue('p-transformers');
    await profileSelect.trigger('change');
    await flushPromises();

    expectLatestGroupUpdate({
      partial: {
        id: toChatGroupId({ raw: 'g1' }),
        endpoint: { type: 'transformers_js' },
      },
    });
  });

  it('removes_the_atomic_endpoint_override_when_switching_to_global', async () => {
    mockGroup.endpoint = {
      type: 'openai',
      url: 'http://example.test/v1',
      httpHeaders: [['Authorization', 'Bearer token']],
    };
    const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });

    await wrapper.get('[data-testid="group-setting-endpoint-type-select"]').setValue('global');
    await flushPromises();

    expectLatestGroupUpdate({
      partial: {
        id: toChatGroupId({ raw: 'g1' }),
        endpoint: undefined,
      },
    });
  });

  it('hides endpoint URL when effective type is transformers_js', async () => {
    // 1. Local override is transformers_js
    mockGroup.endpoint = { type: 'transformers_js' };
    const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
    await nextTick();
    expect(wrapper.find('[data-testid="group-setting-url-input"]').exists()).toBe(false);

    // 2. Local is undefined (global inherit), and global is transformers_js
    mockGroup.endpoint = undefined;
    mockSettings.endpoint = { type: 'transformers_js' };
    const wrapper2 = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
    await nextTick();
    expect(wrapper2.find('[data-testid="group-setting-url-input"]').exists()).toBe(false);
  });

  it('shows upsell component when effective type is transformers_js', async () => {
    mockSettings.endpoint = { type: 'openai', url: 'http://global-url' }; // Start with openai
    const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
    await flushPromises();
    await vi.dynamicImportSettled();

    // Switch to transformers_js
    mockSettings.endpoint = { type: 'transformers_js' };
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

    expectLatestGroupUpdate({
      partial: {
        id: toChatGroupId({ raw: 'g1' }),
        systemPrompt: expect.objectContaining({ behavior: 'append' }) as ChatGroup['systemPrompt'],
      },
    });

    // Click Override
    const overrideBtn = wrapper.findAll('button').find(b => b.text() === 'Override');
    await overrideBtn?.trigger('click');

    expectLatestGroupUpdate({
      partial: {
        id: toChatGroupId({ raw: 'g1' }),
        systemPrompt: expect.objectContaining({ behavior: 'override' }) as ChatGroup['systemPrompt'],
      },
    });
  });

  it('saves pending settings to the previous group when the current group changes', async () => {
    mockGroup.endpoint = {
      type: 'openai',
      url: 'http://group-a',
    };
    const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
    await nextTick();
    mockUpdateChatGroupMetadata.mockClear();

    const urlInput = wrapper.get('[data-testid="group-setting-url-input"]');
    await urlInput.setValue('http://group-a-edited');

    mockCurrentGroup.value = reactive<ChatGroup>({
      id: toChatGroupId({ raw: 'g2' }),
      name: 'Second Group',
      items: [],
      updatedAt: 0,
      isCollapsed: false,
      endpoint: {
        type: 'openai',
        url: 'http://group-b',
      },
      modelId: undefined,
      autoTitleEnabled: undefined,
      titleModelId: undefined,
      systemPrompt: undefined,
      lmParameters: undefined,
    });
    await nextTick();
    await flushPromises();

    expectLatestGroupUpdate({
      partial: {
        id: toChatGroupId({ raw: 'g1' }),
        endpoint: expect.objectContaining({
          url: 'http://group-a-edited',
        }) as ChatGroup['endpoint'],
      },
    });
  });

  it('preserves a dirty LM parameter while synchronizing another parameter externally', async () => {
    let resolveSave: (() => void) | undefined;
    const pendingSave = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    vi.mocked(useChatGroups).mockReturnValue({
      updateChatGroupMetadata: vi.fn(),
      updateScopedSettings: vi.fn(async () => await pendingSave),
      updateToolConfigs: vi.fn(),
      updateScopedSettingsAndToolConfigs: vi.fn(async () => await pendingSave),
      moveChatToGroup: vi.fn(),
      TEST_ONLY: {},
    });

    const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
    await nextTick();

    const editor = wrapper.getComponent({ name: 'LmParametersEditor' });
    editor.vm.$emit('update:modelValue', {
      temperature: 0.8,
      reasoning: { effort: undefined },
    });
    await nextTick();
    expect(editor.props('modelValue')).toEqual(expect.objectContaining({
      temperature: 0.8,
    }));

    mockGroup.lmParameters = {
      temperature: undefined,
      topP: undefined,
      maxCompletionTokens: undefined,
      presencePenalty: undefined,
      frequencyPenalty: undefined,
      stop: undefined,
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

    expectLatestGroupUpdate({
      partial: {
        id: toChatGroupId({ raw: 'g1' }),
        systemPrompt: undefined,
      },
    });

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

    expectLatestGroupUpdate({
      partial: {
        id: toChatGroupId({ raw: 'g1' }),
        systemPrompt: expect.objectContaining({ content: 'Custom prompt' }) as ChatGroup['systemPrompt'],
      },
    });
  });

  it('restores defaults when the button is clicked', async () => {
    mockGroup.modelId = 'overridden';
    mockGroup.systemPrompt = { content: 'prompt', behavior: 'override' };
    mockGroup.toolConfigs = [{ key: 'builtin.calculator', status: 'enabled' }];

    const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
    await wrapper.find('[data-testid="group-setting-restore-defaults"]').trigger('click');

    await flushPromises();
    expect(mockGroup.modelId).toBeUndefined();
    expect(mockGroup.systemPrompt).toBeUndefined();
    expect(mockGroup.toolConfigs).toBeUndefined();
  });

  it('preserves saved tool configs when persistence is disabled during Restore defaults', async () => {
    mockSettings.experimental = { toolConfigPersistence: 'disabled' };
    mockGroup.modelId = 'overridden';
    mockGroup.toolConfigs = [{ key: 'builtin.calculator', status: 'enabled' }];

    const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
    await wrapper.find('[data-testid="group-setting-restore-defaults"]').trigger('click');

    await flushPromises();
    expect(mockGroup.modelId).toBeUndefined();
    expect(mockGroup.toolConfigs).toEqual([{
      key: 'builtin.calculator',
      status: 'enabled',
    }]);
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

    expectLatestGroupUpdate({
      partial: {
        id: toChatGroupId({ raw: 'g1' }),
        modelId: undefined,
      },
    });
  });

  it('sets active focus area to chat-group-settings on click or focus', async () => {
    const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });

    await wrapper.trigger('click');
    expect(mocks.setActiveFocusArea).toHaveBeenCalledWith({ area: 'chat-group-settings' });

    mocks.setActiveFocusArea.mockClear();
    await wrapper.trigger('focusin');
    expect(mocks.setActiveFocusArea).toHaveBeenCalledWith({ area: 'chat-group-settings' });
  });

  it('triggers global search when clicking search button', async () => {
    const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
    await nextTick();

    const searchBtn = wrapper.findAll('button').find(b => b.text().includes('Search Group'));
    await searchBtn?.trigger('click');

    expect(mocks.openSearch).toHaveBeenCalledWith({ groupIds: [mockGroup.id] });
  });

  it('updates group name from model ID when the button is clicked', async () => {
    mockGroup.modelId = 'provider/my-model:latest';
    const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
    await flushPromises();

    const setNameBtn = wrapper.find('[data-testid="group-setting-set-name-from-model"]');
    expect(setNameBtn.exists()).toBe(true);

    await setNameBtn.trigger('click');

    expectLatestGroupUpdate({
      partial: {
        id: toChatGroupId({ raw: 'g1' }),
        name: 'my-model:latest',
      },
    });
  });

  describe('Folders (chat group mounts)', () => {
    it('shows no mount badges when group has no mounts', () => {
      mockGroup.mounts = [];
      const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
      expect(wrapper.find('[data-testid="chat-group-mounts"]').exists()).toBe(false);
    });

    it('renders mount badges for each active mount', async () => {
      mockGroup.mounts = [
        { type: 'volume', volumeId: toVolumeId({ raw: 'vol-1' }), mountPath: '/home/user/work', readOnly: false },
        { type: 'volume', volumeId: toVolumeId({ raw: 'vol-2' }), mountPath: '/home/user/docs', readOnly: true },
      ];
      const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
      await nextTick();

      const badgeContainer = wrapper.find('[data-testid="chat-group-mounts"]');
      expect(badgeContainer.exists()).toBe(true);
      expect(badgeContainer.findAll('[data-testid="mount-badge"]')).toHaveLength(2);
    });

    it('trims /home/user/ prefix from displayed mount path', async () => {
      mockGroup.mounts = [
        { type: 'volume', volumeId: toVolumeId({ raw: 'vol-1' }), mountPath: '/home/user/my-project', readOnly: false },
      ];
      const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
      await nextTick();

      expect(wrapper.find('[data-testid="chat-group-mounts"]').text()).toContain('my-project');
      expect(wrapper.find('[data-testid="chat-group-mounts"]').text()).not.toContain('/home/user/');
    });

    it('calls removeMountFromChatGroup when remove button is clicked', async () => {
      mockGroup.mounts = [
        { type: 'volume', volumeId: toVolumeId({ raw: 'vol-1' }), mountPath: '/home/user/work', readOnly: false },
      ];
      const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
      await nextTick();

      await wrapper.find('[data-testid="mount-remove-btn"]').trigger('click');
      await flushPromises();

      expect(mocks.removeMountFromChatGroup).toHaveBeenCalledWith({ groupId: 'g1', volumeId: 'vol-1' });
    });

    it('calls updateChatGroupMount toggling readOnly when lock button is clicked', async () => {
      mockGroup.mounts = [
        { type: 'volume', volumeId: toVolumeId({ raw: 'vol-1' }), mountPath: '/home/user/work', readOnly: false },
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
        { type: 'volume', volumeId: toVolumeId({ raw: 'vol-1' }), mountPath: '/home/user/work', readOnly: false },
      ];
      const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
      await nextTick();

      await wrapper.find('[data-testid="mount-open-explorer"]').trigger('click');
      await flushPromises();

      expect(mocks.getVolumeDirectoryHandle).toHaveBeenCalledWith({ volumeId: 'vol-1' });
      expect(mocks.openFileExplorer).toHaveBeenCalledWith({ options: expect.objectContaining({
        kind: 'wesh-mounts',
        rootName: 'Files',
        title: 'Folders',
        initialPath: ['home', 'user', 'work'],
      }) });
    });

    it('opens explorer with correct initialPath derived from clicked mount', async () => {
      const handle = { kind: 'directory', name: 'docs' } as unknown as FileSystemDirectoryHandle;
      mocks.getVolumeDirectoryHandle.mockResolvedValue(handle);
      mockGroup.mounts = [
        { type: 'volume', volumeId: toVolumeId({ raw: 'vol-A' }), mountPath: '/home/user/alpha', readOnly: true },
        { type: 'volume', volumeId: toVolumeId({ raw: 'vol-B' }), mountPath: '/home/user/beta', readOnly: false },
      ];
      const wrapper = mount(ChatGroupSettingsPanel, { global: { stubs: globalStubs } });
      await nextTick();

      // Click the second badge's explorer button
      const explorerBtns = wrapper.findAll('[data-testid="mount-open-explorer"]');
      await explorerBtns[1]!.trigger('click');
      await flushPromises();

      expect(mocks.openFileExplorer).toHaveBeenCalledWith({ options: expect.objectContaining({
        initialPath: ['home', 'user', 'beta'],
      }) });
    });
  });
});
