import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, h, ref, shallowRef } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { provideAppEntry } from '@/composables/useAppEntry';
import type { StartupState } from '@/logic/startup/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import { modelLaunchCommand, modelLaunchEntryState, setModelLaunchEntryState, TEST_ONLY } from '@/features/llama-cpp-browser/model-launch/entry-state';
import { modelLaunchPresentation } from '@/features/llama-cpp-browser/model-launch/presentation';
import WelcomeScreenFrame from '@/components/layout/WelcomeScreenFrame.vue';
import LlamaCppBrowserModelLaunchEntry from './LlamaCppBrowserModelLaunchEntry.vue';
const settings = ref<Settings>({ ...DEFAULT_SETTINGS, storageType: 'memory', endpoint: { type: 'openai', url: '' }, defaultModelId: undefined });
const inspect = vi.hoisted(() => vi.fn());
vi.mock('@/features/llama-cpp-browser/hugging-face/metadata-session', () => ({ getMetadataSession: () => ({ inspect }) }));
vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    settings,
    initialized: ref(true),
    captureExperimentalStorage: () => () => true,
    captureModelLaunchDefaults: () => Promise.resolve(undefined),
    deferModelRefresh: () => {},
    resumeModelRefresh: () => {},
  }),
}));
vi.mock('@/features/file-protocol-standalone/composables/usePortableAppDownload', () => ({ usePortableAppDownload: () => ({}) }));

beforeEach(async () => {
  TEST_ONLY.reset();
  inspect.mockReset();
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => TEST_ONLY.reset());

describe('immediate model link presentation', () => {
  it('selects a real quantization for an unspecified model-link variant without an automatic option', async () => {
    inspect.mockResolvedValue({
      repository: 'owner/Unknown-GGUF',
      revision: 'a'.repeat(40),
      projectors: [],
      models: ['Model-Q8_0.gguf', 'Model-Q4_K_M.gguf'].map(path => ({ label: path, files: [{ path, size: 1024 ** 3 }], size: 1024 ** 3 })),
    });
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] });
    await router.push('/?llama-cpp-browser-model=owner/Unknown-GGUF');
    const host = defineComponent({
      setup() {
        provideAppEntry({ startupState: shallowRef<StartupState>({ kind: 'ready', mainApp: LlamaCppBrowserModelLaunchEntry }) });
        return () => h(LlamaCppBrowserModelLaunchEntry, { input: router.currentRoute.value.query['llama-cpp-browser-model'] });
      },
    });
    const wrapper = mount(host, { global: { plugins: [router], stubs: { Teleport: true } } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await flushPromises();
    const trigger = wrapper.get('[data-testid="model-preview-quantization"]');
    expect(trigger.text()).toContain('Q4_K_M');
    expect(trigger.text()).not.toContain('Automatic');
    expect(wrapper.text()).toContain('1.00 GiB');
    await trigger.trigger('click');
    expect(wrapper.get('[data-testid="quantization-option-Model-Q4_K_M.gguf"]').attributes('aria-selected')).toBe('true');
    expect(wrapper.findAll('[role="option"]')).toHaveLength(2);
    expect(modelLaunchCommand.value).toBeUndefined();
    await wrapper.get('[data-testid="start-preview-model"]').trigger('click');
    expect(modelLaunchCommand.value).toMatchObject({ kind: 'start', request: { requestedVariant: 'Model-Q4_K_M.gguf' } });
  });

  it.each([
    { path: '/', automatic: true },
    { path: '/chat/existing', automatic: false },
    { path: '/home', automatic: false },
  ])('limits automatic HF metadata to the dedicated root model-link page: $path', async ({ path, automatic }) => {
    const catalog = {
      repository: 'owner/Unknown-GGUF',
      revision: 'a'.repeat(40),
      projectors: [],
      models: [{ label: 'Q4_K_M', files: [{ path: 'Model-Q4_K_M.gguf', size: 1024 ** 3 }], size: 1024 ** 3 }],
    };
    inspect.mockResolvedValue(catalog);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] });
    const query = { 'llama-cpp-browser-model': 'owner/Unknown-GGUF:Q4_K_M', q: 'ignored' };
    await router.push({ path, query });
    const startupState = shallowRef<StartupState>({ kind: 'initializing-foundation' });
    const host = defineComponent({
      setup() {
        provideAppEntry({ startupState });
        return () => h(LlamaCppBrowserModelLaunchEntry, { input: router.currentRoute.value.query['llama-cpp-browser-model'] });
      },
    });
    const wrapper = mount(host, { global: { plugins: [router], stubs: { Teleport: true } } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await flushPromises();
    expect(inspect).toHaveBeenCalledTimes(automatic ? 1 : 0);
    expect(modelLaunchCommand.value).toBeUndefined();
    expect(modelLaunchEntryState.value.status).toBe('idle');
    expect(router.currentRoute.value.path).toBe(path);
    expect(router.currentRoute.value.query).toEqual(query);
    if (automatic) {
      expect(wrapper.text()).toContain('1.00 GiB');
      startupState.value = { kind: 'ready', mainApp: host };
      await flushPromises();
      await wrapper.get('[data-testid="model-preview-quantization"]').trigger('click');
      expect(wrapper.find('[data-testid="quantization-fetch-options"]').exists()).toBe(false);
      expect(wrapper.get('[data-testid="quantization-option-Model-Q4_K_M.gguf"]').text()).toContain('1.00 GiB');
      expect(inspect).toHaveBeenCalledOnce();
    }
  });

  it('shows local catalog information before startup is ready and starts only on an explicit action', async () => {
    const wrapper = mount(LlamaCppBrowserModelLaunchEntry, { props: { input: 'LiquidAI/LFM2.5-230M-GGUF:Q4_K_M', interaction: 'blocked' } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    expect(wrapper.get('h2').text()).toBe('LFM2.5 230M');
    const frame = wrapper.getComponent(WelcomeScreenFrame);
    expect(frame.props('placement')).toBe('contained');
    expect(frame.classes()).toEqual(expect.arrayContaining(['model-url-entry-welcome', 'relative', 'min-h-full', 'p-6', 'sm:p-12']));
    expect(wrapper.find('[data-testid="suggestions-container"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="model-link-repair"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Liquid AI');
    expect(wrapper.get('[data-testid="model-preview-quantization"]').text()).toContain('Q4_K_M');
    expect(wrapper.get('[data-testid="start-preview-model"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="model-entry-language"]').attributes('inert')).toBeDefined();
    expect(modelLaunchEntryState.value.status).toBe('idle');
    expect(wrapper.find('[data-testid="model-launch-download"]').exists()).toBe(false);
    await wrapper.setProps({ interaction: 'ready' });
    expect(wrapper.get('[data-testid="model-entry-language"]').attributes('inert')).toBeUndefined();
    expect(wrapper.get('[data-testid="browser-model-preparation"]').attributes('inert')).toBeUndefined();
    await wrapper.get('[data-testid="start-preview-model"]').trigger('click');
    const state = modelLaunchEntryState.value;
    expect(state.status).toBe('checking');
    if (state.status !== 'checking') {
      throw new Error('Expected an explicit launch operation');
    }
    setModelLaunchEntryState({ state: { ...state, phase: 'opening-chat' } });
    await flushPromises();
    expect(wrapper.get('[data-testid="start-preview-model"]').attributes('aria-busy')).toBe('true');
    expect(wrapper.get('h2').text()).toBe('LFM2.5 230M');
  });

  it('preserves the same model heading on network failure and retries in place', async () => {
    const input = 'owner/Model-GGUF';
    const operation = Symbol('retry');
    const wrapper = mount(LlamaCppBrowserModelLaunchEntry, { props: { input, operation, interaction: 'ready' } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    setModelLaunchEntryState({ state: { status: 'failed', operation, input, problem: 'failed' } });
    await flushPromises();
    expect(wrapper.get('h2').text()).toBe('Model');
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    await wrapper.get('[data-testid="start-preview-model"]').trigger('click');
    expect(modelLaunchCommand.value).toEqual({ kind: 'retry', operation });
  });

  it('does not fabricate a variant or size when the link has no selector', () => {
    const wrapper = mount(LlamaCppBrowserModelLaunchEntry, { props: { input: 'owner/Model-GGUF' } });
    expect(wrapper.find('[data-testid="model-launch-requested-variant"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('GiB');
    wrapper.unmount();
  });

  it('changes an unknown repository quantization through an explicit metadata check before Start', async () => {
    inspect.mockResolvedValue({
      repository: 'owner/Unknown-GGUF',
      revision: 'a'.repeat(40),
      projectors: [],
      models: [
        { label: 'Q4_K_M', files: [{ path: 'Model-Q4_K_M.gguf', size: 1024 ** 3 }], size: 1024 ** 3 },
        { label: 'Q8_0', files: [{ path: 'Model-Q8_0.gguf', size: 2 * 1024 ** 3 }], size: 2 * 1024 ** 3 },
      ],
    });
    const wrapper = mount(LlamaCppBrowserModelLaunchEntry, { global: { stubs: { Teleport: true } }, props: { input: 'owner/Unknown-GGUF:Q4_K_M', interaction: 'ready' } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    expect(inspect).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="model-preview-quantization"]').text()).toContain('Q4_K_M');
    await wrapper.get('[data-testid="model-preview-quantization"]').trigger('click');
    expect(wrapper.find('[data-testid="quantization-fetch-options"]').exists()).toBe(true);
    expect(inspect).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="quantization-fetch-options"]').trigger('click');
    await flushPromises();
    expect(inspect).toHaveBeenCalledOnce();
    expect(wrapper.text()).toContain('1.00 GiB');
    await wrapper.get('[data-testid="quantization-option-Model-Q8_0.gguf"]').trigger('click');
    expect(wrapper.get('[data-testid="model-preview-quantization"]').text()).toContain('Q8_0');
    expect(wrapper.text()).toContain('2.00 GiB');
    expect(modelLaunchEntryState.value.status).toBe('idle');
    expect(modelLaunchCommand.value).toBeUndefined();
    await wrapper.get('[data-testid="start-preview-model"]').trigger('click');
    expect(modelLaunchCommand.value).toMatchObject({ kind: 'start', request: { requestedVariant: 'Model-Q8_0.gguf' } });
  });

  it.each([null, undefined, ['owner/repo', 'owner/other'], '', 'https://external.example/owner/repo', 'x'.repeat(4097), 'https://user:password@huggingface.co/owner/repo'])('rejects untrusted display input %s', input => {
    expect(modelLaunchPresentation({ input })).toBeUndefined();
  });

  it.each([null, undefined, ['owner/repo', 'owner/other'], '', 'https://external.example/owner/repo'])('allows an invalid link to be repaired in place before an explicit Start: %s', async input => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const originalUrl = window.location.href;
    const wrapper = mount(LlamaCppBrowserModelLaunchEntry, { props: { input, interaction: 'ready' } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
        fetch.mockRestore();
      },
    };
    expect(wrapper.find('[data-testid="model-link-repair"]').exists()).toBe(true);
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="start-preview-model"]').exists()).toBe(false);
    const repaired = 'owner/Repaired-GGUF:Q8_0';
    await wrapper.get('[data-testid="model-link-repository-input"]').setValue(repaired);
    expect(wrapper.get('[data-testid="preparation-model-name"]').text()).toBe('Repaired');
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(modelLaunchEntryState.value.status).toBe('idle');
    expect(modelLaunchCommand.value).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(window.location.href).toBe(originalUrl);
    await wrapper.get('[data-testid="start-preview-model"]').trigger('click');
    const command = modelLaunchCommand.value;
    expect(command?.kind).toBe('start');
    if (command === undefined) {
      throw new Error('Expected an explicit start command');
    }
    switch (command.kind) {
    case 'start': expect(command.request).toMatchObject({ input: repaired, requestedVariant: 'Q8_0', source: 'model-url' });
      break;
    case 'confirm': case 'retry': case 'retire': throw new Error('Expected an explicit start command');
    default: {
      const exhaustive: never = command;
      throw new Error(String(exhaustive));
    }
    }
    expect(window.location.href).toBe(originalUrl);
  });

  it('keeps repair input disabled until startup is ready', async () => {
    const wrapper = mount(LlamaCppBrowserModelLaunchEntry, { props: { input: '', interaction: 'blocked' } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    expect(wrapper.get('[data-testid="model-link-repository-input"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="model-link-repair"]').attributes('inert')).toBeDefined();
    await wrapper.setProps({ interaction: 'ready' });
    expect(wrapper.get('[data-testid="model-link-repository-input"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.get('[data-testid="model-link-repair"]').attributes('inert')).toBeUndefined();
  });

  it('resets a repaired input when the model link owner input changes', async () => {
    const wrapper = mount(LlamaCppBrowserModelLaunchEntry, { props: { input: '', interaction: 'ready' } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await wrapper.get('[data-testid="model-link-repository-input"]').setValue('owner/Previous-GGUF');
    expect(wrapper.get('[data-testid="preparation-model-name"]').text()).toBe('Previous');
    await wrapper.setProps({ input: ['owner/first', 'owner/second'] });
    expect(wrapper.get<HTMLInputElement>('[data-testid="model-link-repository-input"]').element.value).toBe('');
    expect(wrapper.find('[data-testid="preparation-model-name"]').exists()).toBe(false);
    expect(modelLaunchCommand.value).toBeUndefined();
  });

  it('renders remote-looking selector text as inert trigger text', () => {
    const selector = '<img src=x onerror=alert(1)>';
    const wrapper = mount(LlamaCppBrowserModelLaunchEntry, { props: { input: `owner/repo:${selector}`, interaction: 'ready' } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    expect(wrapper.get('[data-testid="model-preview-quantization"]').text()).toContain(selector);
    expect(wrapper.find('img[src="x"]').exists()).toBe(false);
    expect(wrapper.find('[onerror]').exists()).toBe(false);
  });
});
