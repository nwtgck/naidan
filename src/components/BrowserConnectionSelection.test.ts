import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, type Ref } from 'vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { BrowserProvidedLmEndpoint, HttpEndpoint } from '@/01-models/types';
import type { PromptApiRuntimeState } from '@/features/prompt-api/runtime';
import type { CspHintMessage, CspHintTarget } from '@/logic/csp-message-hints/types';
import BrowserConnectionSelection from './BrowserConnectionSelection.vue';
import ModelSelector from './ModelSelector.vue';
import HttpHeadersEditor from './HttpHeadersEditor.vue';

const mocks = vi.hoisted(() => ({
  loadLmProvider: vi.fn(),
  globalFetch: vi.fn(),
  getLanguageModel: vi.fn(),
  availability: vi.fn(),
  prepare: vi.fn(),
  runtimeState: { value: { status: 'unchecked' } as PromptApiRuntimeState },
}));
vi.mock('@/features/lm/providerFactory', () => ({ loadLmProvider: mocks.loadLmProvider }));
vi.mock('@/features/prompt-api/api', () => ({ getPromptApiLanguageModel: mocks.getLanguageModel, getPromptApiAvailability: mocks.availability }));
vi.mock('@/features/prompt-api/runtime', async () => {
  const { ref } = await import('vue');
  mocks.runtimeState = ref(mocks.runtimeState.value);
  return { promptApiRuntimeState: mocks.runtimeState, preparePromptApi: mocks.prepare };
});
vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({ settings: { value: { experimental: { fakeLm: 'disabled' } } }, availableModels: { value: ['global-only'] }, isFetchingModels: { value: false }, fetchModels: mocks.globalFetch }),
}));
vi.mock('@/composables/useCspMessageHintsOnly', () => ({
  useCspMessageHintsOnly: ({ target }: { target: Readonly<Ref<CspHintTarget | undefined>> }) => {
    // Deny every ready destination so these tests exercise draft readiness,
    // independently of a deployment's actual connection policy.
    const message: CspHintMessage = { tone: 'caution', subject: 'connection', suggestedDeployments: [], details: [{ directive: 'connect-src', context: 'document', sources: ["'none'"], sourceDescriptions: [{ kind: 'none' }] }] };
    return computed(() => target.value === undefined ? undefined : message);
  },
}));

enableAutoUnmount(afterEach);

beforeEach(async () => {
  mocks.loadLmProvider.mockReset().mockResolvedValue({ listModels: vi.fn().mockResolvedValue(['model-b', 'model-a']) });
  mocks.globalFetch.mockReset();
  mocks.getLanguageModel.mockReset().mockReturnValue({});
  mocks.availability.mockReset().mockResolvedValue('available');
  mocks.prepare.mockReset().mockResolvedValue(undefined);
  mocks.runtimeState.value = { status: 'unchecked' };
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  vi.useRealTimers();
});

function renderConnection({ initialEndpoint, applySelection }: {
  initialEndpoint: 'openai' | 'browser_provided_lm',
  applySelection: ({ endpoint, modelId }: { endpoint: HttpEndpoint | BrowserProvidedLmEndpoint, modelId: string }) => Promise<void>,
}) {
  return mount(BrowserConnectionSelection, { attachTo: document.body, props: { initialEndpoint, active: true, applySelection }, global: { stubs: { LanguageSelector: true } } });
}

describe('browser model connection selection', () => {
  it.each(['http', 'https'])('waits for a recognizable %s host without changing the connection workflow', async scheme => {
    vi.useFakeTimers();
    const apply = vi.fn().mockResolvedValue(undefined);
    const wrapper = renderConnection({ initialEndpoint: 'openai', applySelection: apply });
    const input = wrapper.get('#model-connection-url');
    // Start with a visible warning so the partial-input checks also prove that
    // an existing warning disappears, after the optional boundary has loaded.
    await input.setValue('https://ready.example/v1');
    await vi.dynamicImportSettled();
    await flushPromises();
    expect(wrapper.find('[data-testid="csp-hint-trigger"]').exists()).toBe(true);
    const hint = wrapper.getComponent({ name: 'CspLmEndpointHint' });
    const prefix = `${scheme}://`;
    for (let length = 1; length <= prefix.length; length++) {
      await input.setValue(prefix.slice(0, length));
      expect(wrapper.find('[data-testid="csp-hint-trigger"]').exists()).toBe(false);
    }
    for (const host of ['l', 'myhost']) {
      await input.setValue(`${scheme}://${host}`);
      expect(wrapper.find('[data-testid="csp-hint-trigger"]').exists()).toBe(false);
      expect(hint.props('endpoint')).toEqual({ type: 'openai', url: `${scheme}://${host}`, httpHeaders: undefined });
    }
    await input.setValue(`${scheme}://myhost.`);
    expect(wrapper.find('[data-testid="csp-hint-trigger"]').exists()).toBe(true);
    await input.setValue(`${scheme}://localhost:11434`);
    expect(wrapper.find('[data-testid="csp-hint-trigger"]').exists()).toBe(true);
    expect(hint.props('endpoint')).toEqual({ type: 'openai', url: `${scheme}://localhost:11434`, httpHeaders: undefined });
    await input.setValue('localhost:11434');
    expect(hint.props('endpoint')).toEqual({ type: 'openai', url: 'http://localhost:11434', httpHeaders: undefined });
    await input.setValue('https://remote.example/v1');
    expect(hint.props('endpoint')).toEqual({ type: 'openai', url: 'https://remote.example/v1', httpHeaders: undefined });
    expect(wrapper.get('#model-connection-url').element).toBe(input.element);
    expect(mocks.loadLmProvider).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('keeps an empty remote connection uncommitted and scrolls only the form region', async () => {
    const apply = vi.fn().mockResolvedValue(undefined);
    const wrapper = renderConnection({ initialEndpoint: 'openai', applySelection: apply });
    const fields = wrapper.get('[data-testid="model-connection-fields"]').element;
    expect(fields.contains(wrapper.get('header').element)).toBe(false);
    expect(fields.contains(wrapper.get('footer').element)).toBe(false);
    expect(wrapper.get('header').text()).toContain('AI outside your web browser or to browser-provided models');
    expect(wrapper.get<HTMLInputElement>('#model-connection-url').element.value).toBe('');
    expect(wrapper.findComponent({ name: 'Logo' }).exists()).toBe(false);
    expect(wrapper.getComponent(ModelSelector).props('models')).toEqual([]);
    expect(wrapper.getComponent(ModelSelector).props('popupPresentation')).toBe('inline');
    expect(wrapper.get('[data-testid="connection-submit"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="connection-submit"]').text()).toBe('Use this connection');
    await wrapper.get('#model-connection-url').setValue('https://example.invalid/v1');
    await flushPromises();
    expect(mocks.loadLmProvider).not.toHaveBeenCalled();
    expect(mocks.globalFetch).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    await wrapper.get('#model-connection-endpoint').trigger('click');
    const choices = wrapper.get('#connection-endpoint-options').text();
    expect(choices).toContain('OpenAI-compatible API');
    expect(choices).toContain('Ollama');
    expect(choices).toContain('Browser-provided');
    expect(choices).not.toContain('Naidan RPC');
    expect(choices).not.toContain('Transformers.js');
  });

  it('uses the draft endpoint and selected real model only after explicit discovery and confirmation', async () => {
    const apply = vi.fn().mockResolvedValue(undefined);
    const wrapper = renderConnection({ initialEndpoint: 'openai', applySelection: apply });
    await wrapper.get('#model-connection-url').setValue('https://example.invalid/v1/');
    await wrapper.get('[data-testid="connection-fetch-models"]').trigger('click');
    await flushPromises();
    expect(wrapper.getComponent(ModelSelector).props('models')).toEqual(['model-a', 'model-b']);
    expect(wrapper.getComponent(ModelSelector).props('modelValue')).toBe('model-a');
    expect(apply).not.toHaveBeenCalled();
    wrapper.getComponent(ModelSelector).vm.$emit('update:modelValue', 'model-b');
    await wrapper.get('[data-testid="connection-submit"]').trigger('click');
    expect(apply).toHaveBeenCalledExactlyOnceWith({ endpoint: { type: 'openai', url: 'https://example.invalid/v1', httpHeaders: undefined }, modelId: 'model-b' });
    expect(mocks.globalFetch).not.toHaveBeenCalled();
  });

  it('shows only the error supplement after a request failure and restores the URL-adjacent hint for other states', async () => {
    const listModels = vi.fn().mockRejectedValue(new Error('provider failed'));
    mocks.loadLmProvider.mockResolvedValue({ listModels });
    const apply = vi.fn().mockResolvedValue(undefined);
    const wrapper = mount(BrowserConnectionSelection, {
      attachTo: document.body,
      props: { initialEndpoint: 'openai', active: true, applySelection: apply },
      global: {
        stubs: {
          LanguageSelector: true,
          CspLmEndpointHint: {
            props: ['endpoint', 'operation', 'presentation', 'activityForDisplayOnly'],
            template: '<span data-testid="connection-csp-probe" :data-presentation="presentation" :data-activity="activityForDisplayOnly" />',
          },
        },
      },
    });
    await wrapper.get('#model-connection-url').setValue('https://example.invalid/v1');
    expect(wrapper.findAll('[data-testid="connection-csp-probe"]').map(hint => hint.attributes('data-presentation'))).toEqual(['compact']);
    expect(wrapper.get('[data-testid="connection-csp-probe"]').attributes('data-activity')).toBe('connection');
    const labelRow = wrapper.get('label[for="model-connection-url"]').element.parentElement;
    expect(labelRow?.contains(wrapper.get('[data-testid="connection-csp-probe"]').element)).toBe(true);
    expect(wrapper.get('[data-testid="connection-csp-probe"]').element.closest('label')).toBeNull();
    const urlInput = wrapper.get('#model-connection-url').element;
    expect(urlInput.parentElement?.nextElementSibling).toBe(wrapper.get('[data-testid="connection-csp-probe"]').element);

    await wrapper.get('[data-testid="connection-fetch-models"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="connection-model-list-error"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-testid="connection-csp-probe"]').map(hint => hint.attributes('data-presentation'))).toEqual(['error']);
    expect(wrapper.get('[data-testid="connection-csp-probe"]').attributes('data-activity')).toBe('model-list');
    expect(wrapper.get('[data-testid="connection-model-list-error"]').element.nextElementSibling).toBe(wrapper.get('[data-testid="connection-csp-probe"]').element);
    expect(listModels).toHaveBeenCalledTimes(1);

    listModels.mockResolvedValue([]);
    await wrapper.get('[data-testid="connection-fetch-models"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="connection-model-list-error"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-testid="connection-csp-probe"]').map(hint => hint.attributes('data-presentation'))).toEqual(['compact']);
    expect(wrapper.get('#model-connection-url').element).toBe(urlInput);

    await wrapper.get('#model-connection-url').setValue('not a valid URL');
    await wrapper.get('[data-testid="connection-fetch-models"]').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('[data-testid="connection-csp-probe"]').map(hint => hint.attributes('data-presentation'))).toEqual(['compact']);
    expect(listModels).toHaveBeenCalledTimes(2);
    expect(mocks.globalFetch).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('keeps API form controls mounted while presets change type and URL', async () => {
    const wrapper = renderConnection({ initialEndpoint: 'openai', applySelection: vi.fn().mockResolvedValue(undefined) });
    const input = wrapper.get('#model-connection-url').element;
    const selector = wrapper.getComponent(ModelSelector).element;
    await wrapper.get('[data-testid="connection-preset-lm-studio--local-"]').trigger('click');
    expect(wrapper.get<HTMLInputElement>('#model-connection-url').element.value).toBe('http://localhost:1234/v1');
    await wrapper.get('[data-testid="connection-preset-ollama--local-"]').trigger('click');
    expect(wrapper.get<HTMLInputElement>('#model-connection-url').element.value).toBe('http://localhost:11434');
    expect(wrapper.get('#model-connection-url').element).toBe(input);
    expect(wrapper.getComponent(ModelSelector).element).toBe(selector);
  });

  it('links the optional API-key control and the header editor without clearing a collapsed key', async () => {
    const wrapper = renderConnection({ initialEndpoint: 'openai', applySelection: vi.fn().mockResolvedValue(undefined) });
    const trigger = wrapper.get('[data-testid="connection-api-key-disclosure"]');
    const input = wrapper.get<HTMLInputElement>('#model-connection-key');
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(trigger.text()).toContain('(optional)');
    expect(input.element.type).toBe('password');
    await trigger.trigger('click');
    await input.setValue('token-one');
    const headers = wrapper.getComponent(HttpHeadersEditor);
    expect(headers.props('modelValue')).toEqual([['Authorization', 'Bearer token-one']]);
    await headers.get('button[aria-expanded]').trigger('click');
    await headers.get('[data-testid="connection-header-value-input"]').setValue('Bearer token-two');
    expect(input.element.value).toBe('token-two');
    await wrapper.get('[data-testid="connection-api-key-visibility"]').trigger('click');
    expect(input.element.type).toBe('text');
    await trigger.trigger('click');
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(trigger.text()).toContain('Configured');
    await trigger.trigger('click');
    expect(wrapper.get('#model-connection-key').element).toBe(input.element);
    expect(input.element.value).toBe('token-two');
    await headers.get('[data-testid="connection-header-add-button"]').trigger('click');
    expect(headers.props('modelValue')).toEqual([['Authorization', 'Bearer token-two'], ['', '']]);
    await headers.get('[data-testid="connection-header-remove-button"]').trigger('click');
    expect(input.element.value).toBe('');
    expect(mocks.loadLmProvider).not.toHaveBeenCalled();
  });

  it('retains its draft after save failure and disables dismissal only while the save is pending', async () => {
    const pending = Promise.withResolvers<void>();
    const apply = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    const wrapper = renderConnection({ initialEndpoint: 'openai', applySelection: apply });
    await wrapper.get('#model-connection-url').setValue('https://example.invalid/v1');
    await wrapper.get('[data-testid="connection-api-key-disclosure"]').trigger('click');
    await wrapper.get('#model-connection-key').setValue('secret');
    await wrapper.get('[data-testid="connection-fetch-models"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="connection-submit"]').trigger('click');
    expect(wrapper.get('[data-testid="model-connection-back"]').attributes('disabled')).toBeDefined();
    expect(wrapper.getComponent(ModelSelector).props('disabled')).toBe(true);
    pending.reject(new Error('save failed: secret'));
    await flushPromises();
    expect(wrapper.get('[data-testid="connection-save-error"]').text()).toContain('Could not save');
    expect(wrapper.get('[data-testid="connection-save-error"]').text()).not.toContain('secret');
    expect(wrapper.get<HTMLInputElement>('#model-connection-url').element.value).toBe('https://example.invalid/v1');
    expect(wrapper.get<HTMLInputElement>('#model-connection-key').element.value).toBe('secret');
    expect(wrapper.getComponent(ModelSelector).props('modelValue')).toBe('model-a');
    await wrapper.get('[data-testid="connection-submit"]').trigger('click');
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('checks a browser model without preparing it and starts preparation in the confirm click before saving', async () => {
    const order: string[] = [];
    mocks.prepare.mockImplementation(() => {
      order.push('prepare');
      return Promise.reject(new Error('runtime handles this'));
    });
    const apply = vi.fn(() => {
      order.push('save');
      return Promise.resolve();
    });
    const wrapper = renderConnection({ initialEndpoint: 'browser_provided_lm', applySelection: apply });
    await flushPromises();
    expect(wrapper.find('#model-connection-endpoint').exists()).toBe(false);
    expect(wrapper.find('#model-connection-url').exists()).toBe(false);
    expect(mocks.availability).toHaveBeenCalledExactlyOnceWith({ inputMode: 'text' });
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="connection-submit"]').text()).toBe('Run in your browser');
    expect(wrapper.get('[data-testid="connection-submit"]').attributes('disabled')).toBeUndefined();
    const clicked = wrapper.get('[data-testid="connection-submit"]').trigger('click');
    expect(order).toEqual(['prepare', 'save']);
    await clicked;
    await flushPromises();
    expect(apply).toHaveBeenCalledExactlyOnceWith({ endpoint: { type: 'browser_provided_lm' }, modelId: 'browser-provided-language-model' });
  });

  it('keeps browser availability failures visible and does not prepare an unsupported model', async () => {
    mocks.getLanguageModel.mockReturnValue(undefined);
    const apply = vi.fn().mockResolvedValue(undefined);
    const wrapper = renderConnection({ initialEndpoint: 'browser_provided_lm', applySelection: apply });
    await flushPromises();
    expect(wrapper.text()).toContain('Not available in this environment');
    expect(wrapper.get('[data-testid="connection-submit"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-testid="connection-submit"]').trigger('click');
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('shows unknown progress for an existing browser download without starting preparation', async () => {
    mocks.availability.mockResolvedValue('downloading');
    const wrapper = renderConnection({ initialEndpoint: 'browser_provided_lm', applySelection: vi.fn().mockResolvedValue(undefined) });
    await flushPromises();
    expect(wrapper.text()).toContain('Downloading browser-provided model');
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBeUndefined();
    expect(wrapper.find('[data-testid="prompt-api-download-progress-indeterminate"]').exists()).toBe(true);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(wrapper.get('header').text()).not.toContain('AI outside your web browser');
  });

  it('uses the shared native progress through download, preparation, and ready while saving', async () => {
    mocks.availability.mockResolvedValue('downloadable');
    mocks.prepare.mockImplementation(() => {
      mocks.runtimeState.value = { status: 'downloading', progress: undefined };
      return Promise.resolve();
    });
    const pending = Promise.withResolvers<void>();
    const wrapper = renderConnection({ initialEndpoint: 'browser_provided_lm', applySelection: () => pending.promise });
    await flushPromises();
    await wrapper.get('[data-testid="connection-submit"]').trigger('click');
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBeUndefined();
    mocks.runtimeState.value = { status: 'downloading', progress: 0.42 };
    await flushPromises();
    expect(wrapper.text()).toContain('42%');
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('42');
    mocks.runtimeState.value = { status: 'preparing' };
    await flushPromises();
    expect(wrapper.text()).toContain('Preparing browser-provided model');
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(false);
    mocks.runtimeState.value = { status: 'ready' };
    await flushPromises();
    expect(wrapper.text()).toContain('Available in this browser');
    expect(wrapper.find('[data-testid="prompt-api-preparation-progress"]').exists()).toBe(false);
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    pending.resolve();
    await flushPromises();
  });

  it('shows current runtime readiness after preparation succeeds but saving fails', async () => {
    mocks.availability.mockResolvedValue('downloadable');
    mocks.prepare.mockImplementation(() => {
      mocks.runtimeState.value = { status: 'ready' };
      return Promise.resolve();
    });
    const apply = vi.fn().mockRejectedValue(new Error('storage failed'));
    const wrapper = renderConnection({ initialEndpoint: 'browser_provided_lm', applySelection: apply });
    await flushPromises();
    expect(wrapper.text()).toContain('Preparation is needed the first time');
    await wrapper.get('[data-testid="connection-submit"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Available in this browser');
    expect(wrapper.text()).not.toContain('Preparation is needed the first time');
    expect(wrapper.find('[data-testid="connection-save-error"]').exists()).toBe(true);
  });

  it.each(['api_unavailable', 'model_unavailable'] as const)('shows a current unavailable runtime instead of old availability: %s', async status => {
    const wrapper = renderConnection({ initialEndpoint: 'browser_provided_lm', applySelection: vi.fn().mockResolvedValue(undefined) });
    await flushPromises();
    mocks.runtimeState.value = { status };
    await flushPromises();
    expect(wrapper.text()).toContain('Not available in this environment');
  });

  it('rejects a late browser capability response after the form stops owning the presentation', async () => {
    const pending = Promise.withResolvers<'available'>();
    mocks.availability.mockReturnValue(pending.promise);
    const apply = vi.fn().mockResolvedValue(undefined);
    const wrapper = renderConnection({ initialEndpoint: 'browser_provided_lm', applySelection: apply });
    await flushPromises();
    await wrapper.setProps({ active: false });
    pending.resolve('available');
    await flushPromises();
    expect(wrapper.get('[data-testid="connection-submit"]').attributes('disabled')).toBeDefined();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('does not prepare from a browser button left behind after unmount', async () => {
    const apply = vi.fn().mockResolvedValue(undefined);
    const wrapper = renderConnection({ initialEndpoint: 'browser_provided_lm', applySelection: apply });
    await flushPromises();
    const button = wrapper.get<HTMLButtonElement>('[data-testid="connection-submit"]').element;
    expect(button.disabled).toBe(false);
    wrapper.unmount();
    button.click();
    await flushPromises();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('closes the endpoint menu before its modal when Escape starts from the trigger', async () => {
    const wrapper = renderConnection({ initialEndpoint: 'openai', applySelection: vi.fn().mockResolvedValue(undefined) });
    const escaped = vi.fn();
    wrapper.element.addEventListener('keydown', escaped);
    const trigger = wrapper.get<HTMLButtonElement>('#model-connection-endpoint');
    await trigger.trigger('click');
    trigger.element.focus();
    await trigger.trigger('keydown', { key: 'Escape' });
    expect(wrapper.find('#connection-endpoint-options').exists()).toBe(false);
    expect(document.activeElement).toBe(trigger.element);
    expect(escaped).not.toHaveBeenCalled();
    await trigger.trigger('keydown', { key: 'Escape' });
    expect(escaped).toHaveBeenCalledOnce();
  });
});
