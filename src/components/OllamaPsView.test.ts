import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { OllamaProvider, OllamaRunningModel } from '@/features/lm/ollama';
import OllamaPsView from './OllamaPsView.vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';

const mockAddToast = vi.fn();

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ addToast: mockAddToast }),
}));

vi.mock('@/components/csp/CspMessageHint.vue', () => ({
  default: {
    props: ['target', 'presentation', 'activityForDisplayOnly'],
    template: '<div v-if="target" data-testid="csp-hint" :data-presentation="presentation" :data-activity="activityForDisplayOnly" :data-endpoint="target.endpoint" :data-api-path="target.apiPath" />',
  },
}));

const runningModel: OllamaRunningModel = {
  name: 'qwen3:8b',
  model: 'qwen3:8b',
  size: 6_442_450_944,
  digest: '500a1f067a9f',
  expiresAt: '9999-12-31T23:59:59Z',
  sizeVram: 5_905_580_032,
  contextLength: 8192,
  details: {
    parentModel: undefined,
    format: 'gguf',
    family: 'qwen3',
    families: ['qwen3'],
    parameterSize: '8.2B',
    quantizationLevel: 'Q4_K_M',
  },
};

function createProvider({
  listRunningModels,
  unloadModel,
}: {
  listRunningModels: ReturnType<typeof vi.fn>,
  unloadModel: ReturnType<typeof vi.fn>,
}): OllamaProvider {
  return {
    listRunningModels,
    unloadModel,
  } as unknown as OllamaProvider;
}

describe('OllamaPsView', () => {
  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
  });

  beforeEach(() => {
    mockAddToast.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays collapsed and avoids requests until opened', async () => {
    const listRunningModels = vi.fn().mockResolvedValue([runningModel]);
    const provider = createProvider({
      listRunningModels,
      unloadModel: vi.fn(),
    });
    const wrapper = mount(OllamaPsView, {
      props: {
        fakeLmDebugModeStatus: undefined,
        provider,
        endpointUrl: 'http://localhost:11434',
      },
    });

    const toggle = wrapper.find('[data-testid="ollama-ps-toggle"]');
    const content = wrapper.find('[data-testid="ollama-ps-content"]');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    expect(content.classes()).toContain('grid-rows-[0fr]');
    expect(content.attributes('inert')).toBe('true');
    expect(listRunningModels).not.toHaveBeenCalled();

    await toggle.trigger('click');
    await flushPromises();

    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(content.classes()).toContain('grid-rows-[1fr]');
    expect(content.attributes('inert')).toBeUndefined();
    expect(listRunningModels).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
    expect(wrapper.text()).toContain('qwen3:8b');
    expect(wrapper.text()).toContain('8.2B');
    expect(wrapper.text()).toContain('Q4_K_M');
    expect(wrapper.text()).toContain('Kept indefinitely');
  });

  it('keeps the settings presentation to one disclosure with the same lazy requests and refresh', async () => {
    const listRunningModels = vi.fn().mockResolvedValue([runningModel]);
    const wrapper = mount(OllamaPsView, { props: { fakeLmDebugModeStatus: undefined, provider: createProvider({ listRunningModels, unloadModel: vi.fn() }), endpointUrl: 'http://localhost:11434', presentation: 'settings' } });
    using _cleanupResource = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    expect(wrapper.get('[data-testid="ollama-ps-toggle"]').text()).toContain('Loaded models');
    expect(wrapper.text()).not.toContain('Models currently using system or video memory');
    expect(listRunningModels).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="ollama-ps-toggle"]').trigger('click');
    await flushPromises();
    expect(listRunningModels).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('qwen3:8b');
    expect(wrapper.find('[data-testid="ollama-model-0-unload"]').exists()).toBe(true);
    listRunningModels.mockResolvedValueOnce([]);
    await wrapper.get('[data-testid="ollama-ps-refresh"]').trigger('click');
    await flushPromises();
    expect(listRunningModels).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-testid="ollama-ps-empty"]').exists()).toBe(true);
  });

  it('shows endpoint guidance without making a request', async () => {
    const listRunningModels = vi.fn();
    const wrapper = mount(OllamaPsView, {
      props: {
        fakeLmDebugModeStatus: undefined,
        provider: createProvider({ listRunningModels, unloadModel: vi.fn() }),
        endpointUrl: undefined,
      },
    });

    await wrapper.find('[data-testid="ollama-ps-toggle"]').trigger('click');

    expect(wrapper.find('[data-testid="ollama-ps-no-endpoint"]').exists()).toBe(true);
    expect(listRunningModels).not.toHaveBeenCalled();
  });

  it('keeps a failed list request tied to its original endpoint while preserving retry', async () => {
    const pending = Promise.withResolvers<readonly OllamaRunningModel[]>();
    const listRunningModels = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue([]);
    const wrapper = mount(OllamaPsView, { props: { fakeLmDebugModeStatus: undefined, provider: createProvider({ listRunningModels, unloadModel: vi.fn() }), endpointUrl: 'https://old.example' } });
    using _cleanupResource = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await wrapper.get('[data-testid="ollama-ps-toggle"]').trigger('click');
    await wrapper.setProps({ endpointUrl: 'https://edited.example' });
    pending.reject(new TypeError('Network request failed'));
    await flushPromises();
    const hint = wrapper.get('[data-testid="csp-hint"][data-presentation="error"]');
    expect(hint.attributes('data-endpoint')).toBe('https://old.example');
    expect(hint.attributes('data-api-path')).toBe('/api/ps');
    expect(hint.attributes('data-activity')).toBe('running-models');
    expect(wrapper.get('[data-testid="ollama-ps-retry"]').element).toHaveProperty('disabled', false);
    await wrapper.get('[data-testid="ollama-ps-retry"]').trigger('click');
    await flushPromises();
    expect(listRunningModels).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-testid="ollama-ps-empty"]').exists()).toBe(true);
  });

  it('does not describe fake LM responses as external requests', async () => {
    const listRunningModels = vi.fn().mockResolvedValue([runningModel]);
    const wrapper = mount(OllamaPsView, { props: { provider: createProvider({ listRunningModels, unloadModel: vi.fn() }), endpointUrl: 'https://fake-lm.invalid', fakeLmDebugModeStatus: 'enabled' } });
    using _cleanupResource = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await wrapper.get('[data-testid="ollama-ps-toggle"]').trigger('click');
    await flushPromises();
    expect(listRunningModels).toHaveBeenCalledOnce();
    expect(wrapper.find('[data-testid="csp-hint"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="ollama-model-0-unload"]').element).toHaveProperty('disabled', false);
  });

  it('shares one unload hint before any unload and removes it when no model can be unloaded', async () => {
    const secondModel = { ...runningModel, name: 'second:latest', model: 'second:latest', digest: 'second-model' };
    const listRunningModels = vi.fn().mockResolvedValue([runningModel, secondModel]);
    const unloadModel = vi.fn().mockRejectedValue(new TypeError('Unload request failed'));
    const wrapper = mount(OllamaPsView, { props: { fakeLmDebugModeStatus: undefined, provider: createProvider({ listRunningModels, unloadModel }), endpointUrl: 'https://ollama.example' } });
    using cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    const compactSelector = '[data-testid="csp-hint"][data-presentation="compact"][data-api-path="/api/generate"]';
    expect(wrapper.find(compactSelector).exists()).toBe(false);
    expect(listRunningModels).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="ollama-ps-toggle"]').trigger('click');
    await flushPromises();
    expect(wrapper.findAll(compactSelector)).toHaveLength(1);
    expect(wrapper.get(compactSelector).attributes('data-endpoint')).toBe('https://ollama.example');
    expect(wrapper.get(compactSelector).attributes('data-activity')).toBe('unload-model');
    expect(wrapper.get('[data-testid="ollama-model-list"]').element.contains(wrapper.get(compactSelector).element)).toBe(false);
    expect(wrapper.get('[data-testid="ollama-model-0-unload"]').element).toHaveProperty('disabled', false);
    expect(wrapper.get('[data-testid="ollama-model-1-unload"]').element).toHaveProperty('disabled', false);
    expect(unloadModel).not.toHaveBeenCalled();
    expect(listRunningModels).toHaveBeenCalledOnce();
    await wrapper.get('[data-testid="ollama-model-0-unload"]').trigger('click');
    await flushPromises();
    expect(unloadModel).toHaveBeenCalledExactlyOnceWith({ model: runningModel.model, signal: expect.any(AbortSignal) });
    expect(wrapper.find('[data-testid="csp-hint"][data-presentation="error"][data-api-path="/api/generate"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="ollama-model-0-unload"]').element).toHaveProperty('disabled', false);
    listRunningModels.mockResolvedValueOnce([]);
    await wrapper.get('[data-testid="ollama-ps-refresh"]').trigger('click');
    await flushPromises();
    expect(wrapper.find(compactSelector).exists()).toBe(false);
    expect(wrapper.find('[data-testid="ollama-ps-empty"]').exists()).toBe(true);
    expect(listRunningModels).toHaveBeenCalledTimes(2);
    void cleanup;
  });

  it.each(['/api/generate', '/api/ps'] as const)('describes the actual failed unload stage at %s without preventing retry', async apiPath => {
    vi.useFakeTimers();
    const listRunningModels = vi.fn().mockResolvedValue([runningModel]);
    const unloadModel = vi.fn().mockResolvedValue(undefined);
    switch (apiPath) {
    case '/api/generate': unloadModel.mockRejectedValueOnce(new TypeError('Request failed'));
      break;
    case '/api/ps': listRunningModels.mockResolvedValueOnce([runningModel]).mockRejectedValueOnce(new TypeError('Confirmation failed'));
      break;
    default: {
      const exhaustive: never = apiPath;
      throw new Error(exhaustive);
    }
    }
    const wrapper = mount(OllamaPsView, { props: { fakeLmDebugModeStatus: undefined, provider: createProvider({ listRunningModels, unloadModel }), endpointUrl: 'https://ollama.example' } });
    using _cleanupResource = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await wrapper.get('[data-testid="ollama-ps-toggle"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="ollama-model-0-unload"]').trigger('click');
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    const hint = wrapper.get('[data-testid="csp-hint"][data-presentation="error"]');
    expect(hint.attributes('data-endpoint')).toBe('https://ollama.example');
    expect(hint.attributes('data-api-path')).toBe(apiPath);
    expect(hint.attributes('data-activity')).toBe('unload-model');
    expect(unloadModel).toHaveBeenCalledExactlyOnceWith({ model: runningModel.model, signal: expect.any(AbortSignal) });
    expect(listRunningModels).toHaveBeenCalledTimes(apiPath === '/api/ps' ? 2 : 1);
    expect(wrapper.get('[data-testid="ollama-model-0-unload"]').element).toHaveProperty('disabled', false);
  });

  it('animates model details and exposes accessible expanded state', async () => {
    const wrapper = mount(OllamaPsView, {
      props: {
        fakeLmDebugModeStatus: undefined,
        provider: createProvider({
          listRunningModels: vi.fn().mockResolvedValue([runningModel]),
          unloadModel: vi.fn(),
        }),
        endpointUrl: 'http://localhost:11434',
      },
    });

    await wrapper.find('[data-testid="ollama-ps-toggle"]').trigger('click');
    await flushPromises();
    const toggle = wrapper.find('[data-testid="ollama-model-0-details-toggle"]');
    const details = wrapper.find('[data-testid="ollama-model-0-details"]');

    expect(toggle.attributes('aria-expanded')).toBe('false');
    expect(details.classes()).toContain('grid-rows-[0fr]');
    expect(details.classes()).toContain('motion-reduce:transition-none');

    await toggle.trigger('click');

    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(details.classes()).toContain('grid-rows-[1fr]');
    expect(details.text()).toContain('500a1f067a9f');
  });

  it('polls until Ollama removes an unloaded model from the running list', async () => {
    vi.useFakeTimers();
    const listRunningModels = vi.fn()
      .mockResolvedValueOnce([runningModel])
      .mockResolvedValueOnce([]);
    const unloadModel = vi.fn().mockResolvedValue(undefined);
    const wrapper = mount(OllamaPsView, {
      props: {
        fakeLmDebugModeStatus: undefined,
        provider: createProvider({ listRunningModels, unloadModel }),
        endpointUrl: 'http://localhost:11434',
      },
    });

    await wrapper.find('[data-testid="ollama-ps-toggle"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-testid="ollama-model-0-unload"]').trigger('click');
    await flushPromises();
    await vi.runAllTimersAsync();
    await flushPromises();

    expect(unloadModel).toHaveBeenCalledWith({
      model: 'qwen3:8b',
      signal: expect.any(AbortSignal),
    });
    expect(listRunningModels).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-testid="ollama-ps-empty"]').exists()).toBe(true);
    expect(mockAddToast).toHaveBeenCalledWith({
      message: 'qwen3:8b unloaded',
      duration: 3000,
    });
  });

  it('keeps a model visible as requested when Ollama is still releasing it', async () => {
    vi.useFakeTimers();
    const listRunningModels = vi.fn().mockResolvedValue([runningModel]);
    const wrapper = mount(OllamaPsView, {
      props: {
        fakeLmDebugModeStatus: undefined,
        provider: createProvider({
          listRunningModels,
          unloadModel: vi.fn().mockResolvedValue(undefined),
        }),
        endpointUrl: 'http://localhost:11434',
      },
    });

    await wrapper.find('[data-testid="ollama-ps-toggle"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-testid="ollama-model-0-unload"]').trigger('click');
    await flushPromises();
    await vi.runAllTimersAsync();
    await flushPromises();

    expect(listRunningModels).toHaveBeenCalledTimes(21);
    expect(wrapper.find('[data-testid="ollama-model-0-notice"]').text()).toContain('Unload requested.');
    expect(wrapper.find('[data-testid="ollama-model-0"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="ollama-model-0-unload"]').text()).toContain('Unload requested');
    expect(wrapper.find('[data-testid="ollama-model-0-unload"]').attributes('disabled')).toBeDefined();
    expect(mockAddToast).toHaveBeenCalledWith({
      message: 'qwen3:8b unload requested',
      duration: 3000,
    });
  });

  it('discards unload confirmation polling when the provider changes', async () => {
    vi.useFakeTimers();
    const listRunningModels = vi.fn()
      .mockResolvedValueOnce([runningModel])
      .mockImplementationOnce(({ signal }: { signal: AbortSignal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }));
    const wrapper = mount(OllamaPsView, {
      props: {
        fakeLmDebugModeStatus: undefined,
        provider: createProvider({
          listRunningModels,
          unloadModel: vi.fn().mockResolvedValue(undefined),
        }),
        endpointUrl: 'http://localhost:11434',
      },
    });

    await wrapper.find('[data-testid="ollama-ps-toggle"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-testid="ollama-model-0-unload"]').trigger('click');
    await flushPromises();
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    expect(listRunningModels).toHaveBeenCalledTimes(2);

    await wrapper.setProps({
      provider: createProvider({
        listRunningModels: vi.fn(),
        unloadModel: vi.fn(),
      }),
    });
    await flushPromises();

    expect(wrapper.find('[data-testid="ollama-ps-status"]').text()).toBe('Not checked');
    expect(wrapper.text()).not.toContain('Unload requested.');
  });

  it('does not show a blank details panel for empty Ollama metadata', async () => {
    const emptyDetailsModel: OllamaRunningModel = {
      ...runningModel,
      digest: '',
      details: {
        parentModel: '',
        format: '',
        family: '',
        families: [],
        parameterSize: '',
        quantizationLevel: '',
      },
    };
    const wrapper = mount(OllamaPsView, {
      props: {
        fakeLmDebugModeStatus: undefined,
        provider: createProvider({
          listRunningModels: vi.fn().mockResolvedValue([emptyDetailsModel]),
          unloadModel: vi.fn(),
        }),
        endpointUrl: 'http://localhost:11434',
      },
    });

    await wrapper.find('[data-testid="ollama-ps-toggle"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="ollama-model-0-details-toggle"]').exists()).toBe(false);
  });

  it('resets cached results when the provider changes', async () => {
    const firstProvider = createProvider({
      listRunningModels: vi.fn().mockResolvedValue([runningModel]),
      unloadModel: vi.fn(),
    });
    const wrapper = mount(OllamaPsView, {
      props: {
        fakeLmDebugModeStatus: undefined,
        provider: firstProvider,
        endpointUrl: 'http://localhost:11434',
      },
    });

    await wrapper.find('[data-testid="ollama-ps-toggle"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('qwen3:8b');

    await wrapper.setProps({
      provider: createProvider({
        listRunningModels: vi.fn(),
        unloadModel: vi.fn(),
      }),
    });

    expect(wrapper.find('[data-testid="ollama-ps-status"]').text()).toBe('Not checked');
    expect(wrapper.text()).not.toContain('qwen3:8b');
  });
});
