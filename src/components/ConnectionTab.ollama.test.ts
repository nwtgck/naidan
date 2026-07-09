import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { EMPTY_LM_PARAMETERS, type EndpointType, type Settings } from '@/01-models/types';
import ConnectionTab from './ConnectionTab.vue';
import { BROWSER_PROVIDED_LM_MODEL_ID } from '@/features/prompt-api';

const { mockFetchModels } = vi.hoisted(() => ({
  mockFetchModels: vi.fn(),
}));

vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    save: vi.fn(),
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
      case 'transformers_js':
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
  ModelSelector: {
    name: 'ModelSelector',
    props: ['modelValue', 'disabled'],
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
  mockFetchModels.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ConnectionTab Ollama management integration', () => {
  it('shows Ollama management between endpoint configuration and model selection', async () => {
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
    expect(management.element.compareDocumentPosition(modelSelection.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

});
