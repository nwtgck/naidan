import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { OllamaProvider, OllamaRunningModel } from '@/features/lm/ollama';
import OllamaPsView from './OllamaPsView.vue';
import { ensureAllStringsForTest } from '@/strings/test-utils';

const mockAddToast = vi.fn();

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ addToast: mockAddToast }),
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
  beforeAll(async () => {
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

  it('shows endpoint guidance without making a request', async () => {
    const listRunningModels = vi.fn();
    const wrapper = mount(OllamaPsView, {
      props: {
        provider: createProvider({ listRunningModels, unloadModel: vi.fn() }),
        endpointUrl: undefined,
      },
    });

    await wrapper.find('[data-testid="ollama-ps-toggle"]').trigger('click');

    expect(wrapper.find('[data-testid="ollama-ps-no-endpoint"]').exists()).toBe(true);
    expect(listRunningModels).not.toHaveBeenCalled();
  });

  it('animates model details and exposes accessible expanded state', async () => {
    const wrapper = mount(OllamaPsView, {
      props: {
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
