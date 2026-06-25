import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { Settings } from '@/models/types';
import ConnectionTab from './ConnectionTab.vue';

vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    save: vi.fn(),
    fetchModels: vi.fn().mockResolvedValue([]),
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
  endpointType: Settings['endpointType'],
}): Settings {
  return {
    endpointType,
    endpointUrl: 'https://ollama.example',
    endpointHttpHeaders: [['X-Test', 'value']],
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
  ModelSelector: { template: '<div data-testid="model-selector-stub" />' },
  LmParametersEditor: { template: '<div />' },
  ProviderProfilePreview: { template: '<div />' },
  TransformersJsUpsell: { template: '<div />' },
  OllamaManagementView: {
    name: 'OllamaManagementView',
    props: ['endpointUrl', 'endpointHttpHeaders', 'fakeLmDebugModeStatus'],
    template: '<div data-testid="ollama-management-stub">Ollama management</div>',
  },
};

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
    expect(wrapper.text().indexOf('Ollama management')).toBeLessThan(wrapper.text().indexOf('Model Selection'));
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
});
