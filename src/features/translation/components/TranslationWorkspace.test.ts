import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
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
  const settings = ref<Settings>({ ...DEFAULT_SETTINGS, endpoint: { type: 'openai', url: 'https://example.invalid/v1' }, storageType: 'local', defaultModelId: 'chat-default', experimental: { locale: 'en', translation: { modelId: 'first.gguf', sourceLang: 'ja', targetLang: 'en' } } });
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
  const wrapper = mount(TranslationWorkspace, { props: { tab: 'workspace' } });
  await flushPromises();
  return {
    wrapper,
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
    expect(f.wrapper.get('form').isVisible()).toBe(false);
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

  it('saves language preferences without saving transient options and disables swap for automatic detection', async () => {
    using f = await fixture();
    const source = f.wrapper.findAllComponents({ name: 'SettingsFormSelect' }).find(component => component.props('label') === 'Source language')!;
    source.vm.$emit('update:modelValue', '');
    await flushPromises();
    expect(f.settings.value.experimental?.translation).toEqual({ modelId: 'first.gguf', sourceLang: undefined, targetLang: 'en' });
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
