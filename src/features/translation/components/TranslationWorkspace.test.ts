import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { flushPromises, mount } from '@vue/test-utils';
import type { useSettings } from '@/composables/useSettings';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import type { LlamaCppBrowserService } from '@/features/llama-cpp-browser/service-contract';
import type { EngineState, GenerationResult } from '@/features/llama-cpp-browser/types';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import TranslationWorkspace from './TranslationWorkspace.vue';
import type { InspectTranslationModel } from '@/features/translation/types';
import { useTranslationNavigation } from '@/features/translation/navigation';

const mocks = vi.hoisted(() => ({
  inspect: vi.fn<InspectTranslationModel>(),
  generate: vi.fn<LlamaCppBrowserService['generate']>(),
  run: vi.fn<LlamaCppBrowserService['runGenerationOperation']>(),
  store: undefined as Pick<ReturnType<typeof useSettings>, 'settings' | 'initialized' | 'captureExperimentalStorage' | 'updateExperimentalForStorage'> | undefined,
  state: { status: 'idle' } as EngineState,
  listener: undefined as (({ state }: { state: EngineState }) => void) | undefined,
}));
vi.mock('@/composables/useSettings', () => ({ useSettings: () => mocks.store }));
vi.mock('../model-detection', () => ({ inspectStoredTranslationModel: mocks.inspect }));
vi.mock('@/features/llama-cpp-browser', () => ({
  llamaCppBrowserService: {
    getState: () => mocks.state,
    subscribe: ({ listener }: { listener: ({ state }: { state: EngineState }) => void }) => {
      mocks.listener = listener;
      return () => {
        mocks.listener = undefined;
      };
    },
    runGenerationOperation: mocks.run,
  },
}));
vi.mock('./TranslationModels.vue', () => ({
  __esModule: true,
  default: {
    props: ['disabled', 'suspended', 'modelId'],
    emits: ['select', 'changed'],
    template: `<section data-testid="test-models"><button data-testid="test-select-model" :disabled="disabled" @click="$emit('select', 'second.gguf')">Select</button></section>`,
  },
}));

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  mocks.inspect.mockReset().mockResolvedValue({ status: 'supported', profileId: 'plamo3-translate' });
  mocks.generate.mockReset().mockResolvedValue({ content: 'Hello', reasoningContent: '', toolCalls: [], finishReason: 'stop' });
  mocks.run.mockReset().mockImplementation(async ({ operation, signal }) => operation({ scope: { signal: signal!, generate: mocks.generate } }));
  mocks.state = { status: 'idle' };
});

async function fixture() {
  const settings = ref<Settings>({ ...DEFAULT_SETTINGS, endpoint: { type: 'openai', url: 'https://example.invalid/v1' }, storageType: 'local', defaultModelId: 'chat-default', experimental: { locale: 'en', translation: { modelId: 'first.gguf', autoTranslate: false } } });
  let storageGeneration = 0;
  const save = vi.fn<ReturnType<typeof useSettings>['updateExperimentalForStorage']>().mockImplementation(async ({ isCurrent, updater }) => {
    if (!isCurrent()) {
      return 'changed';
    }
    settings.value = { ...settings.value, experimental: updater({ experimental: settings.value.experimental }) };
    return 'saved';
  });
  mocks.store = {
    settings,
    initialized: ref(true),
    updateExperimentalForStorage: save,
    captureExperimentalStorage: () => {
      const accepted = storageGeneration;
      return () => accepted === storageGeneration;
    },
  };
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/translation', component: { template: '<div />' } }] });
  await router.push('/translation?from=ja&to=en');
  await router.isReady();
  const wrapper = mount(TranslationWorkspace, { props: { tab: 'workspace' }, global: { plugins: [router], stubs: { Teleport: true } } });
  await flushPromises();
  return {
    wrapper,
    router,
    settings,
    save,
    switchStorage() {
      storageGeneration++;
      settings.value = { ...DEFAULT_SETTINGS, endpoint: { type: 'openai', url: 'https://example.invalid/v1' }, storageType: 'local', experimental: { translation: { modelId: 'first.gguf' } } };
    },
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

describe('translation workspace workflow', () => {
  it('registers independent navigation and keeps text out of saved settings', async () => {
    using f = await fixture();
    expect(useTranslationNavigation().active.value).toBeDefined();
    await f.wrapper.get('[data-testid="translation-source"]').setValue('private text');
    await f.wrapper.get('[data-testid="translation-context"]').setValue('private context');
    expect(f.save).not.toHaveBeenCalled();
    expect(f.settings.value.defaultModelId).toBe('chat-default');
    expect(JSON.stringify(f.settings.value.experimental)).not.toContain('private');
    f.wrapper.unmount();
    expect(useTranslationNavigation().active.value).toBeUndefined();
  });

  it('renders translation output as text, not executable markup, and invalidates it after editing', async () => {
    using f = await fixture();
    mocks.generate.mockResolvedValueOnce({ content: '<img src=x onerror=alert(1)>', reasoningContent: '', toolCalls: [], finishReason: 'stop' });
    await f.wrapper.get('[data-testid="translation-source"]').setValue('原文');
    await f.wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(f.wrapper.get('[data-testid="translation-output"]').text()).toBe('<img src=x onerror=alert(1)>');
    expect(f.wrapper.find('[data-testid="translation-output"] img').exists()).toBe(false);
    await f.wrapper.get('[data-testid="translation-source"]').setValue('changed');
    expect(f.wrapper.get('[data-testid="translation-output"]').text()).not.toContain('<img');
  });

  it('keeps the draft while visiting models, selects without creating a chat and returns to the workspace', async () => {
    using f = await fixture();
    await f.wrapper.get('[data-testid="translation-source"]').setValue('draft');
    await f.wrapper.setProps({ tab: 'models' });
    await flushPromises();
    expect(f.wrapper.get('form').attributes()).toHaveProperty('inert');
    await f.wrapper.get('[data-testid="test-select-model"]').trigger('click');
    await flushPromises();
    expect(f.wrapper.emitted('openWorkspace')).toHaveLength(1);
    expect(f.settings.value.experimental?.translation?.modelId).toBe('second.gguf');
    expect(f.settings.value.defaultModelId).toBe('chat-default');
    await f.wrapper.setProps({ tab: 'workspace' });
    expect(f.wrapper.get<HTMLTextAreaElement>('[data-testid="translation-source"]').element.value).toBe('draft');
  });

  it('does not save an unsupported model or leave the picker after a failed selection', async () => {
    using f = await fixture();
    await f.wrapper.setProps({ tab: 'models' });
    await flushPromises();
    mocks.inspect.mockResolvedValueOnce({ status: 'unsupported' });
    await f.wrapper.get('[data-testid="test-select-model"]').trigger('click');
    await flushPromises();
    expect(f.save).not.toHaveBeenCalled();
    expect(f.wrapper.emitted('openWorkspace')).toBeUndefined();
    expect(f.wrapper.text()).toContain('supported translation template');
  });

  it('replaces URL language preferences without saving settings and disables swap for automatic detection', async () => {
    using f = await fixture();
    const source = f.wrapper.findAllComponents({ name: 'SettingsFormSelect' }).find(component => component.props('label') === 'Source language')!;
    source.vm.$emit('update:modelValue', '');
    await flushPromises();
    expect(f.router.currentRoute.value.query).toEqual({ to: 'en' });
    expect(f.save).not.toHaveBeenCalled();
    expect(f.settings.value.experimental?.translation).toEqual({ modelId: 'first.gguf', autoTranslate: false });
    expect(f.wrapper.get<HTMLButtonElement>('[data-testid="translation-swap"]').element.disabled).toBe(true);
    expect(f.settings.value.defaultModelId).toBe('chat-default');
  });

  it('cancels owned generation and clears private text when settings storage changes', async () => {
    using f = await fixture();
    const pending = Promise.withResolvers<GenerationResult>();
    mocks.generate.mockImplementation(async ({ onEvent }) => {
      await onEvent({ event: { type: 'text', text: 'partial' } });
      return pending.promise;
    });
    await f.wrapper.get('[data-testid="translation-source"]').setValue('private');
    await f.wrapper.get('form').trigger('submit');
    await flushPromises();
    f.switchStorage();
    await flushPromises();
    expect(mocks.generate.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    expect(f.wrapper.get<HTMLTextAreaElement>('[data-testid="translation-source"]').element.value).toBe('');
    pending.resolve({ content: 'old result', reasoningContent: '', toolCalls: [], finishReason: 'stop' });
    await flushPromises();
    expect(f.wrapper.get('[data-testid="translation-output"]').text()).not.toContain('old result');
  });

  it('keeps a stop control during output generation and does not turn a token cap into a percentage', async () => {
    using f = await fixture();
    const pending = Promise.withResolvers<GenerationResult>();
    mocks.generate.mockReturnValue(pending.promise);
    mocks.run.mockImplementation(async ({ signal, operation, onProgress }) => {
      onProgress?.({ progress: { phase: 'generating', completed: 5, total: 4096 } });
      await operation({ scope: { signal: signal!, generate: mocks.generate } });
    });
    await f.wrapper.get('[data-testid="translation-source"]').setValue('原文');
    await f.wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(f.wrapper.find('[data-testid="translation-stop"]').exists()).toBe(true);
    expect(f.wrapper.find('progress').exists()).toBe(false);
    await f.wrapper.get('[data-testid="translation-stop"]').trigger('click');
    expect(mocks.generate.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    pending.resolve({ content: 'ignored', reasoningContent: '', toolCalls: [], finishReason: 'stop' });
    await flushPromises();
    expect(f.wrapper.get('[data-testid="translation-status"]').text()).toContain('Stopped');
  });

  it('does not overwrite newer source input while a language swap navigation is pending', async () => {
    using f = await fixture();
    await f.wrapper.get('[data-testid="translation-source"]').setValue('old source');
    await f.wrapper.get('form').trigger('submit');
    await flushPromises();
    const navigation = Promise.withResolvers<void>();
    f.router.beforeEach(() => navigation.promise);
    await f.wrapper.get('[data-testid="translation-swap"]').trigger('click');
    await flushPromises();
    await f.wrapper.get('[data-testid="translation-source"]').setValue('new source during navigation');
    navigation.resolve();
    await flushPromises();
    expect(f.router.currentRoute.value.query).toEqual({ from: 'en' });
    expect(f.wrapper.get<HTMLTextAreaElement>('[data-testid="translation-source"]').element.value).toBe('new source during navigation');
  });

  it('copies a complete translation into the source when swapping without an intervening edit', async () => {
    using f = await fixture();
    await f.wrapper.get('[data-testid="translation-source"]').setValue('old source');
    await f.wrapper.get('form').trigger('submit');
    await flushPromises();
    await f.wrapper.get('[data-testid="translation-swap"]').trigger('click');
    await flushPromises();
    expect(f.router.currentRoute.value.query).toEqual({ from: 'en' });
    expect(f.wrapper.get<HTMLTextAreaElement>('[data-testid="translation-source"]').element.value).toBe('Hello');
    expect(f.save).not.toHaveBeenCalled();
  });

  it('ignores a delayed clipboard failure belonging to an obsolete result', async () => {
    using f = await fixture();
    const pending = Promise.withResolvers<void>();
    using _clipboard = {
      original: Object.getOwnPropertyDescriptor(navigator, 'clipboard'),
      [Symbol.dispose]() {
        if (this.original) {
          Object.defineProperty(navigator, 'clipboard', this.original);
        } else {
          Reflect.deleteProperty(navigator, 'clipboard');
        }
      },
    };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => pending.promise } });
    await f.wrapper.get('[data-testid="translation-source"]').setValue('old source');
    await f.wrapper.get('form').trigger('submit');
    await flushPromises();
    await f.wrapper.get('[data-testid="translation-copy"]').trigger('click');
    await f.wrapper.get('[data-testid="translation-source"]').setValue('new source');
    pending.reject(new Error('clipboard denied'));
    await flushPromises();
    expect(f.wrapper.get('[data-testid="translation-status"]').text()).toBe('');
  });

  it('does not enable Japanese style controls for a non-Japanese target', async () => {
    using f = await fixture();
    const control = f.wrapper.findAllComponents({ name: 'SettingsFormSelect' }).find(component => component.props('label') === 'Japanese style')!;
    expect(control.props('disabled')).toBe(true);
    const target = f.wrapper.findAllComponents({ name: 'SettingsFormSelect' }).find(component => component.props('label') === 'Target language')!;
    target.vm.$emit('update:modelValue', 'ja');
    await flushPromises();
    expect(control.props('disabled')).toBe(false);
  });
});

function fakeClock() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  return {
    [Symbol.dispose]() {
      vi.useRealTimers();
    },
  };
}

describe('translation automatic workflow', () => {
  it('defaults to automatic translation without persisting drafts or requiring a submit', async () => {
    using f = await fixture();
    using _clock = fakeClock();
    f.settings.value.experimental!.translation = { modelId: 'first.gguf' };
    await f.wrapper.get('[data-testid="translation-source"]').setValue('こんにちは');
    await vi.advanceTimersByTimeAsync(599);
    expect(mocks.generate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(mocks.generate).toHaveBeenCalledOnce();
    expect(f.wrapper.get('[data-testid="translation-output"]').text()).toBe('Hello');
    expect(f.save).not.toHaveBeenCalled();
    expect(f.wrapper.get('[data-testid="translation-run"]').isVisible()).toBe(false);
    expect(f.wrapper.get('[data-testid="translation-status"]').text()).toBe('');
  });

  it('keeps editing available, cancels obsolete output and waits before starting the newest request', async () => {
    using f = await fixture();
    using _clock = fakeClock();
    f.settings.value.experimental!.translation!.autoTranslate = true;
    const old = Promise.withResolvers<GenerationResult>();
    mocks.generate.mockImplementationOnce(async ({ onEvent }) => {
      await onEvent({ event: { type: 'text', text: 'obsolete' } });
      return old.promise;
    });
    await f.wrapper.get('[data-testid="translation-source"]').setValue('first');
    await vi.advanceTimersByTimeAsync(600);
    await flushPromises();
    expect(f.wrapper.get<HTMLTextAreaElement>('[data-testid="translation-source"]').element.disabled).toBe(false);
    await f.wrapper.get('[data-testid="translation-source"]').setValue('newest');
    expect(mocks.generate.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    expect(f.wrapper.get('[data-testid="translation-output"]').text()).not.toContain('obsolete');
    await vi.advanceTimersByTimeAsync(1200);
    expect(mocks.generate).toHaveBeenCalledOnce();
    old.resolve({ content: 'old completion', reasoningContent: '', toolCalls: [], finishReason: 'stop' });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(mocks.generate.mock.calls[1]?.[0].input.messages).toEqual([{ role: 'user', content: 'newest' }]);
    expect(f.wrapper.get('[data-testid="translation-output"]').text()).toBe('Hello');
  });

  it('does not translate IME preedit text, including a submit during composition', async () => {
    using f = await fixture();
    using _clock = fakeClock();
    f.settings.value.experimental!.translation!.autoTranslate = true;
    const source = f.wrapper.get('[data-testid="translation-source"]');
    await source.trigger('compositionstart');
    await source.setValue('preedit');
    await f.wrapper.get('form').trigger('submit');
    await vi.advanceTimersByTimeAsync(1200);
    expect(mocks.generate).not.toHaveBeenCalled();
    await source.trigger('compositionend');
    await source.setValue('confirmed');
    await vi.advanceTimersByTimeAsync(600);
    await flushPromises();
    expect(mocks.generate).toHaveBeenCalledOnce();
  });

  it('persists only the automatic preference and retains the old value after save failure', async () => {
    using f = await fixture();
    f.settings.value.experimental!.translation!.autoTranslate = true;
    await flushPromises();
    f.save.mockRejectedValueOnce(new Error('full'));
    await f.wrapper.get('[data-testid="translation-automatic"]').setValue(false);
    await flushPromises();
    expect(f.wrapper.get<HTMLInputElement>('[data-testid="translation-automatic"]').element.checked).toBe(true);
    expect(f.settings.value.experimental?.translation?.autoTranslate).toBe(true);
    await f.wrapper.get('[data-testid="translation-automatic"]').setValue(false);
    await flushPromises();
    expect(f.settings.value.experimental?.translation).toEqual({ modelId: 'first.gguf', autoTranslate: false });
    expect(f.wrapper.get('[data-testid="translation-run"]').isVisible()).toBe(true);
  });

  it('keeps automatic translation stopped until edit or explicit retry', async () => {
    using f = await fixture();
    using _clock = fakeClock();
    f.settings.value.experimental!.translation!.autoTranslate = true;
    const pending = Promise.withResolvers<GenerationResult>();
    mocks.generate.mockReturnValueOnce(pending.promise);
    await f.wrapper.get('[data-testid="translation-source"]').setValue('text');
    await vi.advanceTimersByTimeAsync(600);
    await flushPromises();
    await f.wrapper.get('[data-testid="translation-stop"]').trigger('click');
    pending.resolve({ content: 'ignored', reasoningContent: '', toolCalls: [], finishReason: 'stop' });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1200);
    expect(mocks.generate).toHaveBeenCalledOnce();
    expect(f.wrapper.get('[data-testid="translation-run"]').isVisible()).toBe(true);
    await f.wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(mocks.generate).toHaveBeenCalledTimes(2);
  });

  it('shows the catalog above real editors without losing text on model selection', async () => {
    using f = await fixture();
    f.settings.value.experimental!.translation = { autoTranslate: false };
    await flushPromises();
    await f.wrapper.get('[data-testid="translation-source"]').setValue('draft before model');
    const modelPanel = f.wrapper.get('[data-testid="translation-model-panel"]').element;
    const editors = f.wrapper.get('[data-testid="translation-editors"]').element;
    expect(modelPanel.compareDocumentPosition(editors) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(f.wrapper.get('[data-testid="translation-source"]').isVisible()).toBe(true);
    expect(f.wrapper.get('[data-testid="translation-output"]').isVisible()).toBe(true);
    await f.wrapper.get('[data-testid="test-select-model"]').trigger('click');
    await flushPromises();
    expect(f.settings.value.experimental?.translation?.modelId).toBe('second.gguf');
    expect(f.wrapper.get<HTMLTextAreaElement>('[data-testid="translation-source"]').element.value).toBe('draft before model');
  });

  it('does not select a model whose inspection resolves after the drawer is closed', async () => {
    using f = await fixture();
    await f.wrapper.setProps({ tab: 'models' });
    await flushPromises();
    const pending = Promise.withResolvers<Awaited<ReturnType<InspectTranslationModel>>>();
    mocks.inspect.mockReturnValueOnce(pending.promise);
    await f.wrapper.get('[data-testid="test-select-model"]').trigger('click');
    await f.wrapper.setProps({ tab: 'workspace' });
    pending.resolve({ status: 'supported', profileId: 'plamo3-translate' });
    await flushPromises();
    expect(f.save).not.toHaveBeenCalled();
    expect(f.settings.value.experimental?.translation?.modelId).toBe('first.gguf');
  });

  it('blocks malformed URL parameters instead of silently translating to the default', async () => {
    using f = await fixture();
    await f.router.replace('/translation?to=en&to=ko');
    await f.wrapper.get('[data-testid="translation-source"]').setValue('text');
    await f.wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(f.wrapper.get<HTMLButtonElement>('[data-testid="translation-run"]').element.disabled).toBe(true);
  });

  it('uses the shared loading presentation with real progress', async () => {
    using f = await fixture();
    const pending = Promise.withResolvers<GenerationResult>();
    mocks.generate.mockReturnValueOnce(pending.promise);
    mocks.run.mockImplementationOnce(async ({ onProgress, operation, signal }) => {
      onProgress?.({ progress: { phase: 'loading', completed: 1, total: 4 } });
      await operation({ scope: { signal: signal!, generate: mocks.generate } });
    });
    await f.wrapper.get('[data-testid="translation-source"]').setValue('text');
    await f.wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(f.wrapper.get('[data-testid="model-load-percentage"]').text()).toBe('25%');
    pending.resolve({ content: 'done', reasoningContent: '', toolCalls: [], finishReason: 'stop' });
    await flushPromises();
  });
});
