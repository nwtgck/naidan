import { SettingsSelectStub } from './settings-select.test-support';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { flushPromises, mount } from '@vue/test-utils';
import { EMPTY_LM_PARAMETERS, type EndpointType, type Settings } from '@/01-models/types';
import ConnectionTab from './ConnectionTab.vue';
import SettingsSelect from './SettingsSelect.vue';
import ModelSelector from './ModelSelector.vue';
import HttpHeadersEditor from './HttpHeadersEditor.vue';
import ReasoningSettings from './ReasoningSettings.vue';
import { toProviderProfileId, toNaidanRpcRegistrationId } from '@/01-models/ids';
import { BROWSER_PROVIDED_LM_MODEL_ID } from '@/features/prompt-api';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

const { mockFetchModels, mockSave } = vi.hoisted(() => ({
  mockFetchModels: vi.fn(),
  mockSave: vi.fn(),
}));

vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    save: mockSave,
    fetchModels: mockFetchModels,
    updateProviderProfiles: vi.fn(),
  }),
}));

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));

vi.mock('@/composables/useConfirm', () => ({
  useConfirm: () => ({ showConfirm: vi.fn() }),
}));

vi.mock('@/composables/usePrompt', () => ({
  usePrompt: () => ({ showPrompt: vi.fn() }),
}));

function createSettings({ endpointType }: {
  endpointType: EndpointType,
}): Settings {
  return {
    endpoint: (() => {
      switch (endpointType) {
      case 'naidan_rpc':
        return { type: endpointType, registrationId: undefined };
      case 'transformers_js':
      case 'llama_cpp_browser':
      case 'browser_provided_lm':
        return { type: endpointType };
      case 'openai':
      case 'ollama':
        return {
          type: endpointType,
          url: 'https://ollama.example',
          httpHeaders: [['X-Test', 'value']],
        };
      default: {
        const _ex: never = endpointType;
        throw new Error(`Unhandled endpoint type: ${_ex}`);
      }
      }
    })(),
    defaultModelId: '',
    titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: { temperature: undefined, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } } },
    storageType: 'memory',
    providerProfiles: [],
    mounts: [],
    experimental: { fakeLm: 'enabled' },
  };
}

const globalStubs = {
  SettingsSelect: SettingsSelectStub,
  RouterLink: true,
  RpcRegistrationSelect: true,
  ModelSelector: {
    name: 'ModelSelector',
    props: ['modelValue', 'disabled', 'models', 'loading', 'allowClear', 'clearLabel', 'inheritedModel'],
    template: '<div data-testid="model-selector-stub" />',
  },
  LmParametersEditor: { template: '<div />' },
  ProviderProfilePreview: { template: '<div />' },
  TransformersJsUpsell: { template: '<div />' },
  OllamaManagementView: {
    name: 'OllamaManagementView',
    props: ['endpointUrl', 'endpointHttpHeaders', 'fakeLmDebugModeStatus'],
    template: '<div data-testid="ollama-management-stub">Ollama management</div>',
  },
};

beforeEach(() => {
  mockFetchModels.mockReset();
  mockSave.mockReset();
  mockSave.mockResolvedValue(undefined);
  mockFetchModels.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ConnectionTab Ollama management integration', () => {
  it('shows Ollama management alongside the endpoint and model controls', async () => {
    const wrapper = mount(ConnectionTab, {
      props: {
        modelValue: createSettings({ endpointType: 'ollama' }),
        availableModels: [],
        isFetchingModels: false,
        hasUnsavedChanges: false,
      },
      global: { stubs: globalStubs },
    });
    await flushPromises();

    const management = wrapper.find('[data-testid="ollama-management-stub"]');
    expect(management.exists()).toBe(true);
    expect(wrapper.find('[data-testid="ollama-management-transition"]').exists()).toBe(true);
    const modelSelection = wrapper.get('[data-testid="connection-model-selection"]');
    expect(modelSelection.element).toBeInstanceOf(HTMLElement);
    expect(wrapper.findComponent({ name: 'OllamaManagementView' }).props('endpointUrl')).toBe('https://ollama.example');
  });

  it('does not show Ollama management for other providers', async () => {
    const wrapper = mount(ConnectionTab, {
      props: {
        modelValue: createSettings({ endpointType: 'openai' }),
        availableModels: [],
        isFetchingModels: false,
        hasUnsavedChanges: false,
      },
      global: { stubs: globalStubs },
    });
    await flushPromises();

    expect(wrapper.find('[data-testid="ollama-management-stub"]').exists()).toBe(false);
  });

  it('keeps the browser-provided endpoint option enabled when the API is unavailable', () => {
    vi.stubGlobal('LanguageModel', undefined);
    const wrapper = mount(ConnectionTab, {
      props: {
        modelValue: createSettings({ endpointType: 'openai' }),
        availableModels: [],
        isFetchingModels: false,
        hasUnsavedChanges: false,
      },
      global: { stubs: globalStubs },
    });

    const option = wrapper.get('option[value="browser_provided_lm"]');
    expect((option.element as HTMLOptionElement).disabled).toBe(false);

    wrapper.unmount();
    vi.unstubAllGlobals();
  });

  it('persists the browser-provided chat model and same-scope title setting when the endpoint is selected', async () => {
    vi.stubGlobal('LanguageModel', Object.assign(function LanguageModel() {}, {
      availability: vi.fn().mockResolvedValue('available'),
      create: vi.fn(),
    }));
    mockFetchModels.mockResolvedValue([BROWSER_PROVIDED_LM_MODEL_ID]);
    const settings = createSettings({ endpointType: 'openai' });

    const wrapper = mount(ConnectionTab, {
      props: {
        modelValue: settings,
        availableModels: [BROWSER_PROVIDED_LM_MODEL_ID],
        isFetchingModels: false,
        hasUnsavedChanges: false,
      },
      global: { stubs: globalStubs },
    });

    await wrapper.get('[data-testid="setting-provider-select"]').setValue('browser_provided_lm');
    await flushPromises();

    expect(settings.endpoint).toEqual({ type: 'browser_provided_lm' });
    expect(settings.defaultModelId).toBe(BROWSER_PROVIDED_LM_MODEL_ID);
    expect(settings.titleGeneration).toMatchObject({ endpoint: 'same_scope', model: 'same_scope' });
    wrapper.unmount();
  });

  it('does not clear the browser-provided chat model when an earlier endpoint fetch finishes late', async () => {
    vi.stubGlobal('LanguageModel', Object.assign(function LanguageModel() {}, {
      availability: vi.fn().mockResolvedValue('available'),
      create: vi.fn(),
    }));
    let resolveOldModels: ((models: string[]) => void) | undefined;
    mockFetchModels
      .mockReturnValueOnce(new Promise<string[]>((resolve) => {
        resolveOldModels = resolve;
      }))
      .mockResolvedValue([BROWSER_PROVIDED_LM_MODEL_ID]);
    const settings = createSettings({ endpointType: 'openai' });

    const wrapper = mount(ConnectionTab, {
      props: {
        modelValue: settings,
        availableModels: [],
        isFetchingModels: false,
        hasUnsavedChanges: false,
      },
      global: { stubs: globalStubs },
    });

    await wrapper.get('[data-testid="setting-check-connection"]').trigger('click');
    await wrapper.get('[data-testid="setting-provider-select"]').setValue('browser_provided_lm');
    await flushPromises();

    resolveOldModels?.(['old-http-model']);
    await flushPromises();

    expect(settings.endpoint).toEqual({ type: 'browser_provided_lm' });
    expect(settings.defaultModelId).toBe(BROWSER_PROVIDED_LM_MODEL_ID);
    expect(settings.titleGeneration).toMatchObject({ endpoint: 'same_scope', model: 'same_scope' });
    wrapper.unmount();
  });

  it('clears browser-provided model IDs when switching to an HTTP endpoint', async () => {
    vi.stubGlobal('LanguageModel', Object.assign(function LanguageModel() {}, {
      availability: vi.fn().mockResolvedValue('available'),
      create: vi.fn(),
    }));
    const settings = createSettings({ endpointType: 'browser_provided_lm' });
    settings.defaultModelId = BROWSER_PROVIDED_LM_MODEL_ID;
    settings.titleGeneration = { endpoint: 'same_scope', model: { id: BROWSER_PROVIDED_LM_MODEL_ID }, lmParameters: { temperature: undefined, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } } };

    const wrapper = mount(ConnectionTab, {
      props: {
        modelValue: settings,
        availableModels: [BROWSER_PROVIDED_LM_MODEL_ID],
        isFetchingModels: false,
        hasUnsavedChanges: false,
      },
      global: { stubs: globalStubs },
    });

    await wrapper.get('[data-testid="setting-provider-select"]').setValue('ollama');
    await flushPromises();

    expect(settings.endpoint).toEqual({ type: 'ollama', url: '' });
    expect(settings.defaultModelId).toBe('');
    expect(settings.titleGeneration).toMatchObject({ endpoint: 'same_scope', model: 'same_scope' });
    wrapper.unmount();
  });

  it('shows the persisted browser-provided model IDs', async () => {
    vi.stubGlobal('LanguageModel', Object.assign(function LanguageModel() {}, {
      availability: vi.fn().mockResolvedValue('available'),
      create: vi.fn(),
    }));
    mockFetchModels.mockResolvedValue(['browser-provided-language-model']);
    const settings = createSettings({ endpointType: 'browser_provided_lm' });
    settings.defaultModelId = 'browser-provided-language-model';
    settings.titleGeneration = { endpoint: 'same_scope', model: { id: 'browser-provided-language-model' }, lmParameters: { temperature: undefined, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } } };

    const wrapper = mount(ConnectionTab, {
      props: {
        modelValue: settings,
        availableModels: ['browser-provided-language-model'],
        isFetchingModels: false,
        hasUnsavedChanges: false,
      },
      global: { stubs: globalStubs },
    });
    await flushPromises();

    const selectors = wrapper.findAllComponents({ name: 'ModelSelector' });
    expect(selectors[0]?.props('modelValue')).toBe('browser-provided-language-model');
    expect(selectors[0]?.props('disabled')).toBe(true);
    expect(selectors[1]?.props('modelValue')).toBe('browser-provided-language-model');
    expect(selectors[1]?.props('disabled')).toBe(true);
    wrapper.unmount();
  });

  it('edits HTTP headers on an explicit title endpoint', async () => {
    const settings = createSettings({ endpointType: 'openai' });
    settings.titleGeneration = {
      endpoint: {
        type: 'openai',
        url: 'https://title.example/v1',
        httpHeaders: [['X-Title', 'old']],
      },
      model: { id: 'title-model' },
      lmParameters: { ...EMPTY_LM_PARAMETERS, reasoning: { ...EMPTY_LM_PARAMETERS.reasoning } },
    };

    const wrapper = mount(ConnectionTab, {
      props: {
        modelValue: settings,
        availableModels: [],
        isFetchingModels: false,
        hasUnsavedChanges: false,
      },
      global: { stubs: globalStubs },
    });
    await flushPromises();

    await wrapper.get('[data-testid="setting-title-http-header-name-input"]').setValue('X-Title-Next');
    await wrapper.get('[data-testid="setting-title-http-header-value-input"]').setValue('next');

    expect(settings.titleGeneration).toMatchObject({
      endpoint: {
        type: 'openai',
        url: 'https://title.example/v1',
        httpHeaders: [['X-Title-Next', 'next']],
      },
      model: { id: 'title-model' },
    });

    await wrapper.get('[data-testid="setting-title-http-header-remove-button"]').trigger('click');

    expect(settings.titleGeneration).toMatchObject({
      endpoint: {
        type: 'openai',
        url: 'https://title.example/v1',
        httpHeaders: [],
      },
      model: { id: 'title-model' },
    });
    wrapper.unmount();
  });

  it.each([false, true])('propagates standalone=%s to both chat and title endpoint choices without hiding features', async standalone => {
    vi.stubGlobal('__BUILD_MODE_IS_STANDALONE__', standalone);
    const wrapper = mount(ConnectionTab, { props: { modelValue: createSettings({ endpointType: 'ollama' }), availableModels: [], isFetchingModels: false, hasUnsavedChanges: false }, global: { stubs: globalStubs } });
    using _cleanupResource = {
      [Symbol.dispose]() {
        wrapper.unmount();
        vi.unstubAllGlobals();
      },
    };
    await flushPromises();
    const mainOptions = wrapper.findAllComponents(SettingsSelect).find(select => select.attributes('data-testid') === 'setting-provider-select')!.props('options');
    expect(mainOptions.find(option => option.value === 'transformers_js')?.detail).toContain(standalone ? 'Worker' : 'ONNX');
    const transformers = wrapper.findAll('select option[value="transformers_js"]');
    const llama = wrapper.findAll('select option[value="llama_cpp_browser"]');
    expect(transformers).toHaveLength(2);
    expect(llama).toHaveLength(2);
    for (const option of transformers) {
      expect(option.element).toBeInstanceOf(HTMLOptionElement);
      expect(option.attributes('disabled') !== undefined).toBe(standalone);
      expect(option.text()).toContain('Transformers.js');
    }
    for (const option of llama) {
      expect(option.attributes('disabled')).toBeUndefined();
      expect(option.text()).toContain('llama.cpp');
    }
  });
});

describe('Naidan RPC endpoint availability', () => {
  it('offers RPC for global chat and title only while the feature is enabled', async () => {
    const settings = createSettings({ endpointType: 'ollama' });
    const wrapper = mount(ConnectionTab, { props: { modelValue: settings, availableModels: [], isFetchingModels: false, hasUnsavedChanges: false }, global: { stubs: globalStubs } });
    using _cleanupResource = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await flushPromises();
    for (const name of ['setting-provider-select', 'setting-title-endpoint-type-select']) {
      expect(wrapper.get(`[data-testid="${name}"]`).find('option[value="naidan_rpc"]').exists()).toBe(false);
    }
    await wrapper.setProps({ modelValue: { ...settings, experimental: { ...settings.experimental, naidanRpc: 'enabled' } } });
    for (const name of ['setting-provider-select', 'setting-title-endpoint-type-select']) {
      expect(wrapper.get(`[data-testid="${name}"]`).get('option[value="naidan_rpc"]').element).toHaveProperty('disabled', false);
    }
  });

  it('preserves disabled saved RPC endpoints instead of silently selecting another provider', async () => {
    const settings = createSettings({ endpointType: 'naidan_rpc' });
    if (typeof settings.titleGeneration !== 'object') {
      throw new Error('Expected title settings');
    }
    settings.titleGeneration.endpoint = { type: 'naidan_rpc', registrationId: undefined };
    const wrapper = mount(ConnectionTab, { props: { modelValue: settings, availableModels: [], isFetchingModels: false, hasUnsavedChanges: false }, global: { stubs: globalStubs } });
    using _cleanupResource = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await flushPromises();
    for (const name of ['setting-provider-select', 'setting-title-endpoint-type-select']) {
      const select = wrapper.get(`[data-testid="${name}"]`);
      expect(select.element).toHaveProperty('value', 'naidan_rpc');
      expect(select.get('option[value="naidan_rpc"]').element).toHaveProperty('disabled', true);
    }
    expect(settings.endpoint.type).toBe('naidan_rpc');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });
});

describe('ConnectionTab controlled settings contracts', () => {
  it('keeps headers and disclosures in the draft until the explicit global save action', async () => {
    const settings = createSettings({ endpointType: 'openai' });
    const wrapper = mount(ConnectionTab, { props: { modelValue: settings, availableModels: [], isFetchingModels: false, hasUnsavedChanges: true }, global: { stubs: globalStubs } });
    using _cleanupResource = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await flushPromises();
    const titleModel = wrapper.findAllComponents(ModelSelector)[1]!;
    const titleElement = titleModel.element;
    await wrapper.get('[data-testid="setting-title-disclosure"]').trigger('click');
    await wrapper.get('[data-testid="setting-title-disclosure"]').trigger('click');
    await wrapper.get('[data-testid="setting-parameters-disclosure"]').trigger('click');
    expect(wrapper.findAllComponents(ModelSelector)[1]!.element).toBe(titleElement);
    const headers = wrapper.findAllComponents(HttpHeadersEditor)[0]!;
    headers.vm.$emit('update:modelValue', [['X-API-Key', 'draft-secret']]);
    headers.vm.$emit('save');
    await flushPromises();
    expect(settings.endpoint).toMatchObject({ httpHeaders: [['X-API-Key', 'draft-secret']] });
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockFetchModels).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="setting-save-button"]').trigger('click');
    await flushPromises();
    expect(mockSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ patch: expect.objectContaining({ endpoint: settings.endpoint }), modelRefresh: 'await' }));
    expect(wrapper.emitted('save')).toHaveLength(1);
  });

  it('uses a dynamic conversation reference for title defaults and keeps explicit same-valued choices distinct', async () => {
    const settings = createSettings({ endpointType: 'llama_cpp_browser' });
    settings.defaultModelId = 'owner/global-draft-model';
    const wrapper = mount(ConnectionTab, { props: { modelValue: settings, availableModels: [], isFetchingModels: false, hasUnsavedChanges: false }, global: { stubs: globalStubs } });
    using _cleanupResource = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    const titleSelect = wrapper.findAllComponents(SettingsSelect).find(select => select.attributes('data-testid') === 'setting-title-endpoint-type-select')!;
    const choices = titleSelect.props('options');
    expect(choices[0]).toMatchObject({ value: 'same_scope', label: 'Conversation connection', source: { label: 'Conversation' } });
    expect(choices.find(option => option.value === 'llama_cpp_browser')).toMatchObject({ label: expect.stringContaining('llama.cpp') });
    expect(choices.find(option => option.value === 'llama_cpp_browser')?.source).toBeUndefined();
    const titleModel = wrapper.findAllComponents(ModelSelector)[1]!;
    expect(titleModel.props()).toMatchObject({ models: [], allowClear: true, clearLabel: 'Conversation model', inheritedModel: { id: undefined, source: { label: 'Conversation' } } });
    expect(JSON.stringify(titleModel.props('inheritedModel'))).not.toContain('global-draft-model');
    titleSelect.vm.$emit('update:modelValue', 'openai');
    await flushPromises();
    expect(wrapper.findAllComponents(ModelSelector)[1]!.props('allowClear')).toBe(false);
    expect(wrapper.findAllComponents(ModelSelector)[1]!.props('inheritedModel')).toBeUndefined();
    expect(wrapper.findAllComponents(ReasoningSettings).find(control => control.attributes('data-testid') === 'setting-title-reasoning-select')!.props('leadingOptions')?.[0]?.label).toBeUndefined();
    expect(mockFetchModels).not.toHaveBeenCalled();
  });

  it('disables title controls while off and re-enables with the existing same-scope defaults', async () => {
    const settings = createSettings({ endpointType: 'openai' });
    settings.titleGeneration = { endpoint: { type: 'openai', url: 'https://title.example' }, model: { id: 'title-model' }, lmParameters: { ...EMPTY_LM_PARAMETERS, reasoning: { effort: 'high' } } };
    const wrapper = mount(ConnectionTab, { props: { modelValue: settings, availableModels: [], isFetchingModels: false, hasUnsavedChanges: false }, global: { stubs: globalStubs } });
    using _cleanupResource = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await wrapper.get('[data-testid="setting-auto-title-checkbox"]').setValue(false);
    expect(settings.titleGeneration).toBe('disabled');
    expect(wrapper.findAllComponents(ModelSelector)[1]!.props('disabled')).toBe(true);
    expect(wrapper.findAllComponents(ReasoningSettings).find(control => control.attributes('data-testid') === 'setting-title-reasoning-select')!.props('disabled')).toBe(true);
    const titleSelect = wrapper.findAllComponents(SettingsSelect).find(select => select.attributes('data-testid') === 'setting-title-endpoint-type-select')!;
    expect(titleSelect.props('disabled')).toBe(true);
    await wrapper.get('[data-testid="setting-auto-title-checkbox"]').setValue(true);
    expect(settings.titleGeneration).toEqual({ endpoint: 'same_scope', model: 'same_scope', lmParameters: EMPTY_LM_PARAMETERS });
    expect(mockSave).not.toHaveBeenCalled();
  });

  it.each(['enabled', 'disabled'] as const)('loads profile snapshots without saving and preserves title parameters when title is %s', async status => {
    const settings = createSettings({ endpointType: 'openai' });
    const titleParameters = { ...EMPTY_LM_PARAMETERS, reasoning: { effort: 'high' as const }, temperature: 0.2 };
    settings.titleGeneration = status === 'disabled' ? 'disabled' : { endpoint: 'same_scope', model: 'same_scope', lmParameters: titleParameters };
    settings.providerProfiles = [{ id: toProviderProfileId({ raw: 'saved-profile' }), name: 'Saved snapshot', endpoint: { type: 'openai', url: 'https://profile.example', httpHeaders: [['X-Profile', 'secret']] }, defaultModelId: 'profile-model', titleModelId: 'profile-title', systemPrompt: 'Profile prompt', lmParameters: { ...EMPTY_LM_PARAMETERS, reasoning: { effort: 'low' } } }];
    const wrapper = mount(ConnectionTab, { props: { modelValue: settings, availableModels: [], isFetchingModels: false, hasUnsavedChanges: false }, global: { stubs: { ...globalStubs, SettingsSelect: false } } });
    using _cleanupResource = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await wrapper.get('[data-testid="setting-quick-provider-profile-select"]').trigger('click');
    document.querySelector<HTMLButtonElement>('[role="listbox"][data-open="true"] [role="option"]:not(:disabled)')!.click();
    await flushPromises();
    expect(settings).toMatchObject({ endpoint: settings.providerProfiles[0]!.endpoint, defaultModelId: 'profile-model', systemPrompt: 'Profile prompt', lmParameters: JSON.parse(JSON.stringify(settings.providerProfiles[0]!.lmParameters)), titleGeneration: { endpoint: 'same_scope', model: { id: 'profile-title' }, lmParameters: status === 'disabled' ? EMPTY_LM_PARAMETERS : titleParameters } });
    expect(wrapper.get('[data-testid="setting-quick-provider-profile-select"]').text()).toBe('Load from saved profiles...');
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockFetchModels).not.toHaveBeenCalled();
  });

  it.each(['', 'https://remote.example'])('shows the HTTP auto-check hint for URL %s without starting a request', async url => {
    const settings = createSettings({ endpointType: 'openai' });
    settings.endpoint = { type: 'openai', url, httpHeaders: [] };
    const wrapper = mount(ConnectionTab, { props: { modelValue: settings, availableModels: [], isFetchingModels: false, hasUnsavedChanges: false }, global: { stubs: globalStubs } });
    using _cleanupResource = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await flushPromises();
    expect(wrapper.get('[data-testid="setting-auto-check-hint"]').text()).toContain('localhost');
    expect(mockFetchModels).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="setting-quick-provider-profile-select"]').exists()).toBe(false);
  });
});

it('closes real title popups on OFF and disclosure collapse without fetching or saving', async () => {
  const settings = createSettings({ endpointType: 'openai' });
  const wrapper = mount(ConnectionTab, { props: { modelValue: settings, availableModels: ['owner/model'], isFetchingModels: false, hasUnsavedChanges: false }, global: { stubs: { ...globalStubs, SettingsSelect: false, ModelSelector: false } } });
  using _cleanupResource = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await flushPromises();
  await wrapper.get('[data-testid="setting-title-disclosure"]').trigger('click');
  const endpointTrigger = wrapper.get('[data-testid="setting-title-endpoint-type-select"]');
  expect(endpointTrigger.text()).toContain('Conversation connection');
  expect(endpointTrigger.text()).toContain('Conversation');
  await endpointTrigger.trigger('click');
  expect(endpointTrigger.attributes('aria-expanded')).toBe('true');
  await wrapper.get('[data-testid="setting-auto-title-checkbox"]').setValue(false);
  expect(endpointTrigger.attributes('aria-expanded')).toBe('false');
  await wrapper.get('[data-testid="setting-auto-title-checkbox"]').setValue(true);
  const modelTrigger = wrapper.get('[data-testid="setting-title-model-select"] [data-testid="model-selector-trigger"]');
  expect(modelTrigger.text()).toContain('Conversation model');
  expect(modelTrigger.text()).toContain('Conversation');
  await modelTrigger.trigger('click');
  expect(modelTrigger.attributes('aria-expanded')).toBe('true');
  await wrapper.get('[data-testid="setting-title-disclosure"]').trigger('click');
  expect(modelTrigger.attributes('aria-expanded')).toBe('false');
  expect(mockSave).not.toHaveBeenCalled();
  expect(mockFetchModels).not.toHaveBeenCalled();
});

it('preserves RPC registrations and independent title drafts when reselecting the current endpoint choice', async () => {
  const settings = createSettings({ endpointType: 'naidan_rpc' });
  settings.experimental = { naidanRpc: 'enabled' };
  settings.endpoint = { type: 'naidan_rpc', registrationId: toNaidanRpcRegistrationId({ raw: 'main-rpc' }) };
  settings.titleGeneration = { endpoint: { type: 'naidan_rpc', registrationId: toNaidanRpcRegistrationId({ raw: 'title-rpc' }) }, model: { id: 'title-model' }, lmParameters: EMPTY_LM_PARAMETERS };
  const original = JSON.stringify(settings);
  const wrapper = mount(ConnectionTab, { props: { modelValue: settings, availableModels: [], isFetchingModels: false, hasUnsavedChanges: false }, global: { stubs: { ...globalStubs, SettingsSelect: false } } });
  using _cleanupResource = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await wrapper.get('[data-testid="setting-provider-select"]').trigger('click');
  document.querySelector<HTMLButtonElement>('[role="listbox"][data-open="true"] [role="option"][aria-selected="true"]')!.click();
  await wrapper.get('[data-testid="setting-title-disclosure"]').trigger('click');
  await wrapper.get('[data-testid="setting-title-endpoint-type-select"]').trigger('click');
  document.querySelector<HTMLButtonElement>('[role="listbox"][data-open="true"] [role="option"][aria-selected="true"]')!.click();
  await flushPromises();
  expect(JSON.stringify(settings)).toBe(original);
  expect(mockFetchModels).not.toHaveBeenCalled();
  mockFetchModels.mockResolvedValue([BROWSER_PROVIDED_LM_MODEL_ID]);
  await wrapper.setProps({ modelValue: { ...settings, endpoint: { type: 'browser_provided_lm' } } });
  await flushPromises();
  const fetchCount = mockFetchModels.mock.calls.length;
  await wrapper.get('[data-testid="setting-provider-select"]').trigger('click');
  document.querySelector<HTMLButtonElement>('[role="listbox"][data-open="true"] [role="option"][aria-selected="true"]')!.click();
  await flushPromises();
  expect(wrapper.props('modelValue').titleGeneration).toEqual(settings.titleGeneration);
  expect(mockSave).not.toHaveBeenCalled();
  expect(mockFetchModels).toHaveBeenCalledTimes(fetchCount);
});

it('edits main reasoning in the parent draft while preserving other parameters and saving only explicitly', async () => {
  const settings = createSettings({ endpointType: 'openai' });
  settings.lmParameters = { ...EMPTY_LM_PARAMETERS, temperature: 0.6, topP: 0.8, stop: ['END'], reasoning: { effort: 'low' } };
  settings.titleGeneration = { endpoint: 'same_scope', model: 'same_scope', lmParameters: { ...EMPTY_LM_PARAMETERS, temperature: 0.2, reasoning: { effort: 'medium' } } };
  const titleBefore = structuredClone(settings.titleGeneration);
  const wrapper = mount(ConnectionTab, { props: { modelValue: settings, availableModels: [], isFetchingModels: false, hasUnsavedChanges: true }, global: { stubs: globalStubs } });
  using _cleanupResource = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await wrapper.get('[data-testid="setting-main-reasoning-select"] [data-testid="reasoning-effort-high"]').trigger('click');
  expect(settings.lmParameters).toEqual({ ...EMPTY_LM_PARAMETERS, temperature: 0.6, topP: 0.8, stop: ['END'], reasoning: { effort: 'high' } });
  expect(settings.titleGeneration).toEqual(titleBefore);
  expect(mockSave).not.toHaveBeenCalled();
  expect(mockFetchModels).not.toHaveBeenCalled();
  await wrapper.get('[data-testid="setting-save-button"]').trigger('click');
  await flushPromises();
  expect(mockSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ patch: expect.objectContaining({ lmParameters: settings.lmParameters, titleGeneration: titleBefore }) }));
});

it('shows and disables main reasoning for a browser-provided model', async () => {
  const settings = createSettings({ endpointType: 'browser_provided_lm' });
  settings.lmParameters = { ...EMPTY_LM_PARAMETERS, reasoning: { effort: 'low' } };
  const wrapper = mount(ConnectionTab, { props: { modelValue: settings, availableModels: [BROWSER_PROVIDED_LM_MODEL_ID], isFetchingModels: false, hasUnsavedChanges: false }, global: { stubs: globalStubs } });
  using _cleanupResource = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  const control = wrapper.get('[data-testid="setting-main-reasoning-select"] [data-testid="reasoning-effort-high"]');
  expect(control.attributes('disabled')).toBeDefined();
  await control.trigger('click');
  expect(settings.lmParameters.reasoning.effort).toBe('low');
  expect(mockSave).not.toHaveBeenCalled();
  expect(mockFetchModels).not.toHaveBeenCalled();
});

it('keeps unspecified main parameters untouched when the selected default effort is reselected', async () => {
  const settings = createSettings({ endpointType: 'openai' });
  const wrapper = mount(ConnectionTab, { props: { modelValue: settings, availableModels: [], isFetchingModels: false, hasUnsavedChanges: false }, global: { stubs: globalStubs } });
  using _cleanupResource = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  await wrapper.get('[data-testid="setting-main-reasoning-select"] [data-testid="reasoning-effort-default"]').trigger('click');
  expect(settings.lmParameters).toBeUndefined();
  expect(mockSave).not.toHaveBeenCalled();
  expect(mockFetchModels).not.toHaveBeenCalled();
});

it.each([
  ['openai', 'http://localhost:1234/v1'],
  ['ollama', 'http://localhost:11434'],
] as const)('shows %s URL examples without replacing draft URLs', async (endpointType, placeholder) => {
  const settings = createSettings({ endpointType });
  settings.endpoint = { type: endpointType, url: 'https://main.example' };
  settings.titleGeneration = { endpoint: { type: endpointType, url: 'https://title.example' }, model: { id: 'title-model' }, lmParameters: EMPTY_LM_PARAMETERS };
  const wrapper = mount(ConnectionTab, { props: { modelValue: settings, availableModels: [], isFetchingModels: false, hasUnsavedChanges: false }, global: { stubs: globalStubs } });
  using _cleanupResource = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  expect(wrapper.get('[data-testid="setting-url-input"]').attributes('placeholder')).toBe(placeholder);
  expect(wrapper.get('[data-testid="setting-title-endpoint-url-input"]').attributes('placeholder')).toBe(placeholder);
  expect(settings.endpoint).toMatchObject({ url: 'https://main.example' });
  expect(settings.titleGeneration).toMatchObject({ endpoint: { url: 'https://title.example' } });
  expect(mockSave).not.toHaveBeenCalled();
  expect(mockFetchModels).not.toHaveBeenCalled();
});

it('keeps helpful provider details and existing availability reasons in the main and title choices', async () => {
  const settings = createSettings({ endpointType: 'openai' });
  settings.experimental = { naidanRpc: 'enabled' };
  const wrapper = mount(ConnectionTab, { props: { modelValue: settings, availableModels: [], isFetchingModels: false, hasUnsavedChanges: false }, global: { stubs: globalStubs } });
  using _cleanupResource = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  const selectors = wrapper.findAllComponents(SettingsSelect);
  for (const testId of ['setting-provider-select', 'setting-title-endpoint-type-select']) {
    const options = selectors.find(select => select.attributes('data-testid') === testId)!.props('options');
    expect(options.find(option => option.value === 'openai')?.detail).toBe('Connect to an OpenAI-compatible API');
    expect(options.find(option => option.value === 'ollama')?.detail).toBe('Connect to an Ollama server');
    expect(options.find(option => option.value === 'naidan_rpc')?.detail).toBe('Use models from a registered connection');
    expect(options.find(option => option.value === 'llama_cpp_browser')?.detail).toBe('Run GGUF models in this browser');
    expect(options.find(option => option.value === 'transformers_js')?.detail).toBe('Run ONNX models in this browser');
    expect(options.find(option => option.value === 'browser_provided_lm')?.detail).toBeTruthy();
  }
});
