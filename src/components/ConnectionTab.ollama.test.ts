import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { EndpointType, Settings } from '@/01-models/types';
import ConnectionTab from './ConnectionTab.vue';

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
      case 'prompt_api':
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
    titleModelId: '',
    autoTitleEnabled: true,
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

  it('shows the browser-managed model without overwriting the saved model', async () => {
    vi.stubGlobal('LanguageModel', Object.assign(function LanguageModel() {}, {
      availability: vi.fn().mockResolvedValue('available'),
      create: vi.fn(),
    }));
    mockFetchModels.mockResolvedValue(['browser-provided-language-model']);
    const settings = createSettings({ endpointType: 'prompt_api' });
    settings.defaultModelId = 'saved-provider-model';

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
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    wrapper.unmount();
  });

});
