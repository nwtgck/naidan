import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, onMounted, shallowRef, computed } from 'vue';
import { DOMWrapper, mount, flushPromises } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { useLiveConversation } from '@/features/live-conversation/composables/useLiveConversation';
import { createLiveControllerFixture } from '@/features/live-conversation/logic/controller.test-support';
import LiveConversationView from './LiveConversationView.vue';
import { useLiveModelPreference } from '@/features/live-conversation/composables/useLiveModelPreference';
import { listModelInventory } from '@/features/llama-cpp-browser/composables/model-inventory';
import { llamaCppBrowserModelFiles } from '@/features/llama-cpp-browser/model-files';
import { useLiveSpeechConversation } from '@/features/live-conversation/composables/useLiveSpeechConversation';
import { createLiveSpeechFixture } from '@/features/live-conversation/logic/speech-controller.test-support';
import { inspectStoredSpeechModel, openStoredSpeechModel } from '@/features/speech-cpp-browser/models';
import type { SpeechCapability } from '@/features/speech-cpp-browser/types';
import { createSpeechClient as createStandaloneSpeechClient } from '@/features/speech-cpp-browser/worker/client-standalone';
import { speechModelHeader } from '@/features/speech-cpp-browser/worker/model-file.test-support';
import { File as NativeFile } from 'node:buffer';
import { createStandaloneFacadeAliases } from '../../../../build/standalone-facades.js';
import SettingsSelect from '@/components/SettingsSelect.vue';
import { setLocale } from '@/strings';

const confirm = vi.hoisted(() => vi.fn(async () => true));
const captureModelFiles = vi.hoisted(() => vi.fn());
let speechCapability: SpeechCapability = { kind: 'available' };
vi.mock('@/composables/useConfirm', () => ({ useConfirm: () => ({ showConfirm: confirm }) }));
vi.mock('@/features/live-conversation/composables/useLiveModelPreference', () => ({ useLiveModelPreference: vi.fn() }));
vi.mock('@/features/llama-cpp-browser/composables/model-inventory', () => ({ listModelInventory: vi.fn(async () => [{ modelId: 'user/live', size: 1, importedAt: 0 }]) }));
vi.mock('@/features/llama-cpp-browser/model-files', () => ({ llamaCppBrowserModelFiles: { subscribeModelList: vi.fn(() => vi.fn()), captureModelFiles } }));
vi.mock('@/features/llama-cpp-browser/components/LlamaCppBrowserModelSuggestions.vue', () => ({ default: defineComponent({ name: 'LiveCatalogStub', props: ['suggestions', 'disabled', 'defaultActionDisabled', 'selectionAction'], emits: ['changed', 'select'], setup: () => () => h('div', { 'data-testid': 'mock-catalog' }) }) }));

vi.mock('@/features/live-conversation/composables/useLiveConversation', () => ({ useLiveConversation: vi.fn() }));
vi.mock('@/features/live-conversation/composables/useLiveSpeechConversation', () => ({ useLiveSpeechConversation: vi.fn() }));
vi.mock('@/features/speech-cpp-browser/models', () => ({ inspectStoredSpeechModel: vi.fn(async () => ({ kind: 'other' })), openStoredSpeechModel: vi.fn(async () => new File(['model'], 'model.gguf')) }));
vi.mock('@/00-storage/service', () => ({ storageService: { listVolumes: async function* () {} } }));
vi.mock('@/features/llama-cpp-browser/components/LlamaCppBrowserManager.vue', () => ({
  default: defineComponent({
    props: ['suspended'],
    emits: ['models-changed', 'model-selected', 'runtime-ready'],
    setup(_props, { emit }) {
      onMounted(() => {
        emit('models-changed', [{ modelId: 'user/live', size: 1, importedAt: 0 }]);
        emit('model-selected', 'user/live');
        emit('runtime-ready', true);
      });
      return () => h('div', { 'data-testid': 'mock-model-manager' });
    },
  }),
}));
vi.mock('@/components/ModelSelector.vue', () => ({
  default: defineComponent({
    props: ['modelValue', 'disabled', 'models'],
    emits: ['update:modelValue'],
    setup(props, { emit }) {
      return () => h('input', {
        value: props.modelValue,
        disabled: props.disabled,
        onChange: (event: Event) => {
          if (event.target instanceof HTMLInputElement) {
            emit('update:modelValue', event.target.value);
          }
        },
      });
    },
  }),
}));

beforeEach(async () => {
  vi.clearAllMocks();
  captureModelFiles.mockReset();
  speechCapability = { kind: 'available' };
  vi.mocked(inspectStoredSpeechModel).mockResolvedValue({ kind: 'other' });
  vi.mocked(openStoredSpeechModel).mockResolvedValue(new File(['model'], 'model.gguf'));
  confirm.mockResolvedValue(true);
  vi.mocked(useLiveModelPreference).mockReturnValue({ remembered: computed(() => undefined), remember: vi.fn(async () => {}), TEST_ONLY: {} });
  await ensureAllStringsForTest({ locale: 'en' });
});

async function fixture() {
  const f = createLiveControllerFixture();
  const state = shallowRef(f.controller.getState());
  f.onChange.mockImplementation(({ state: next }) => {
    state.value = next;
  });
  vi.mocked(useLiveConversation).mockReturnValue({ state, controller: f.controller, TEST_ONLY: {} });
  const speech = createLiveSpeechFixture();
  speech.controller.capability = speechCapability;
  const speechState = shallowRef(speech.controller.getState());
  speech.onChange.mockImplementation(({ state: next }) => {
    speechState.value = next;
  });
  vi.mocked(useLiveSpeechConversation).mockReturnValue({ state: speechState, controller: speech.controller, TEST_ONLY: {} });
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:attachment');
  const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const host = document.createElement('div');
  document.body.append(host);
  const wrapper = mount(LiveConversationView, { attachTo: host });
  const page = new DOMWrapper(document.body);
  await flushPromises();
  return {
    ...f,
    state,
    speech,
    wrapper,
    page,
    async [Symbol.asyncDispose]() {
      wrapper.unmount();
      host.remove();
      await f.controller.dispose();
      await speech.controller.dispose();
      pause.mockRestore();
      createUrl.mockRestore();
      revokeUrl.mockRestore();
    },
  };
}

describe('independent live conversation workspace', () => {
  it('passes an explicit conversation language with persona and preserves it across display-language changes', async () => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue({ kind: 'speech', info: { name: 'model', architecture: 'haru', task: 'dialogue', bytes: 1, sampleRate: 24000, frameSamples: 3200, requiredVersion: 'test' } });
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    await f.wrapper.get('[data-testid="live-open-settings"]').trigger('click');
    await flushPromises();
    const select = f.wrapper.findComponent(SettingsSelect);
    expect(select.props('options').map(option => option.value)).toEqual(['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh']);
    select.vm.$emit('update:modelValue', 'fr');
    await setLocale({ locale: 'ja' });
    await flushPromises();
    expect(select.props('modelValue')).toBe('fr');
    expect(select.props('options').find(option => option.value === 'fr')?.label).toBe('フランス語');
    await f.page.get('[data-testid="live-instructions"]').setValue('Friendly persona');
    await f.page.get('[data-testid="live-settings-close"]').trigger('click');
    await f.wrapper.get('[data-testid="live-speech-start"]').trigger('click');
    await flushPromises();
    expect(f.speech.client.start).toHaveBeenCalledWith({ options: { inputSampleRate: 24000, maxSeconds: 120, language: 'fr', persona: 'Friendly persona', name: undefined } });
  });

  it('does not let a cancelled model resolution overwrite a newer model load', async () => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue({ kind: 'speech', info: { name: 'model', architecture: 'haru', task: 'dialogue', bytes: 1, sampleRate: 24000, frameSamples: 3200, requiredVersion: 'test' } });
    const first = Promise.withResolvers<File>();
    vi.mocked(openStoredSpeechModel).mockReturnValueOnce(first.promise);
    await using f = await fixture();
    void f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    await f.wrapper.get('[data-testid="live-cancel-model-loading"]').trigger('click');
    await flushPromises();
    const second = Promise.withResolvers<void>();
    vi.mocked(f.speech.client.loadModel).mockImplementation(async () => {
      f.speech.change({ state: { phase: 'loading_model' } });
      await second.promise;
      f.speech.change({ state: { phase: 'ready', model: { name: 'second', architecture: 'haru', task: 'dialogue', bytes: 1, sampleRate: 24000, frameSamples: 3200, requiredVersion: 'test' } } });
    });
    f.wrapper.findComponent({ name: 'LiveCatalogStub' }).vm.$emit('select', { modelId: 'speech/second', size: 1, importedAt: 0 });
    await flushPromises();
    void f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    first.resolve(new File(['late'], 'first.gguf'));
    await flushPromises();
    second.resolve();
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-header-model"]').attributes('title')).toBe('speech/second');
    expect(f.wrapper.get('[data-testid="live-header-model"]').text()).toBe('second');
    expect(f.speech.client.loadModel).toHaveBeenCalledOnce();
  });

  it.each(['speech', 'llama'] as const)('clears both engines histories when starting a new conversation from %s', async engine => {
    await using f = await fixture();
    async function releaseResident() {
      await f.wrapper.get('[data-testid="live-open-settings"]').trigger('click');
      await flushPromises();
      await f.page.get('[data-testid="live-release"]').trigger('click');
      await flushPromises();
    }
    async function addSpeechHistory() {
      vi.mocked(inspectStoredSpeechModel).mockResolvedValue({ kind: 'speech', info: { name: 'speech', architecture: 'haru', task: 'dialogue', bytes: 1, sampleRate: 24000, frameSamples: 3200, requiredVersion: 'test' } });
      f.wrapper.findComponent({ name: 'LiveCatalogStub' }).vm.$emit('select', { modelId: 'speech/model', size: 1, importedAt: 0 });
      await flushPromises();
      await f.wrapper.get('[data-testid="live-start"]').trigger('click');
      await flushPromises();
      await f.wrapper.get('[data-testid="live-speech-start"]').trigger('click');
      await flushPromises();
      f.speech.frame({ text: 'Speech history', samples: new Float32Array() });
      await flushPromises();
    }
    async function addLfmHistory() {
      vi.mocked(inspectStoredSpeechModel).mockResolvedValue({ kind: 'other' });
      f.wrapper.findComponent({ name: 'LiveCatalogStub' }).vm.$emit('select', { modelId: 'user/live', size: 1, importedAt: 0 });
      await flushPromises();
      await f.wrapper.get('[data-testid="live-start"]').trigger('click');
      await flushPromises();
      await f.wrapper.get('[data-testid="live-text"]').setValue('LFM history');
      await f.wrapper.get('form').trigger('submit');
      await flushPromises();
    }
    if (engine === 'speech') {
      await addLfmHistory();
      await releaseResident();
      await addSpeechHistory();
    } else {
      await addSpeechHistory();
      await releaseResident();
      await addLfmHistory();
    }
    expect(f.controller.getState().entries).toHaveLength(1);
    expect(f.speech.controller.getState().sessions).toHaveLength(1);
    await f.wrapper.get('[data-testid="live-new-conversation"]').trigger('click');
    await flushPromises();
    expect(f.controller.getState().entries).toHaveLength(0);
    expect(f.speech.controller.getState().sessions).toHaveLength(0);
  });

  it('cancels model resolution and never loads files returned after cancellation', async () => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue({ kind: 'speech', info: { name: 'model', architecture: 'haru', task: 'dialogue', bytes: 1, sampleRate: 24000, frameSamples: 3200, requiredVersion: 'test' } });
    const opening = Promise.withResolvers<File>();
    vi.mocked(openStoredSpeechModel).mockReturnValue(opening.promise);
    await using f = await fixture();
    void f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-cancel-model-loading"]').attributes('disabled')).toBeUndefined();
    await f.wrapper.get('[data-testid="live-cancel-model-loading"]').trigger('click');
    await flushPromises();
    expect(vi.mocked(openStoredSpeechModel).mock.calls[0]?.[0].signal?.aborted).toBe(true);
    expect(f.speech.client.releaseModel).toHaveBeenCalledOnce();
    opening.resolve(new File(['late'], 'late.gguf'));
    await flushPromises();
    expect(f.speech.client.loadModel).not.toHaveBeenCalled();
    expect(f.wrapper.get('[data-testid="live-start"]').attributes('disabled')).toBeUndefined();
  });

  it('offers cancellation while the speech runtime loads a model', async () => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue({ kind: 'speech', info: { name: 'model', architecture: 'haru', task: 'dialogue', bytes: 1, sampleRate: 24000, frameSamples: 3200, requiredVersion: 'test' } });
    await using f = await fixture();
    const loading = Promise.withResolvers<void>();
    vi.mocked(f.speech.client.loadModel).mockImplementation(async () => {
      f.speech.change({ state: { phase: 'loading_model' } });
      await loading.promise;
    });
    void f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-cancel-model-loading"]').attributes('disabled')).toBeUndefined();
    await f.wrapper.get('[data-testid="live-cancel-model-loading"]').trigger('click');
    await flushPromises();
    expect(f.speech.client.releaseModel).toHaveBeenCalledOnce();
    loading.resolve();
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-start"]').attributes('disabled')).toBeUndefined();
    expect(f.speech.client.start).not.toHaveBeenCalled();
  });

  it('keeps speech errors and response history when a preselected LFM model becomes active after failure', async () => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue({ kind: 'speech', info: { name: 'model', architecture: 'haru', task: 'dialogue', bytes: 1, sampleRate: 24000, frameSamples: 3200, requiredVersion: 'test' } });
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    await f.wrapper.get('[data-testid="live-speech-start"]').trigger('click');
    f.speech.frame({ text: 'Previous answer', samples: new Float32Array() });
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue({ kind: 'other' });
    f.wrapper.findComponent({ name: 'LiveCatalogStub' }).vm.$emit('select', { modelId: 'next/lfm', size: 1, importedAt: 0 });
    await flushPromises();
    f.speech.change({ state: { phase: 'failed', model: undefined, failure: { code: 'runtime_failed', message: 'Worker stopped', nativeStatus: -9, nativeInput: 'speech_step' } } });
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-speech-failure"]').text()).toContain('Worker stopped');
    expect(f.wrapper.get('[data-testid="live-speech-failure"]').text()).toContain('-9');
    expect(f.wrapper.get('[data-testid="live-speech-history"]').text()).toContain('Previous answer');
    expect(f.wrapper.find('[data-testid="live-speech-controls"]').exists()).toBe(false);
    expect(f.wrapper.get('[data-testid="live-start"]').attributes('disabled')).toBeUndefined();
  });

  it('allows choosing LFM after a failed speech session releases its model', async () => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue({ kind: 'speech', info: { name: 'model', architecture: 'haru', task: 'dialogue', bytes: 1, sampleRate: 24000, frameSamples: 3200, requiredVersion: 'test' } });
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    f.speech.change({ state: { phase: 'failed', model: undefined, failure: { code: 'runtime_failed', message: 'Worker stopped', nativeStatus: undefined, nativeInput: undefined } } });
    await flushPromises();
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue({ kind: 'other' });
    f.wrapper.findComponent({ name: 'LiveCatalogStub' }).vm.$emit('select', { modelId: 'next/lfm', size: 1, importedAt: 0 });
    await flushPromises();
    expect(f.wrapper.find('[data-testid="live-speech-controls"]').exists()).toBe(false);
    expect(f.wrapper.get('[data-testid="live-start"]').attributes('disabled')).toBeUndefined();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    expect(f.runLiveSession).toHaveBeenCalledOnce();
    expect(f.speech.client.loadModel).toHaveBeenCalledOnce();
    expect(f.wrapper.get('[data-testid="live-header-model"]').attributes('title')).toBe('next/lfm');
  });

  it('explains an unavailable speech runtime and prevents sending the model to the LFM engine', async () => {
    speechCapability = { kind: 'unavailable', reason: 'artifact_unavailable' };
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue({ kind: 'speech', info: { name: 'model', architecture: 'haru', task: 'dialogue', bytes: 1, sampleRate: 24000, frameSamples: 3200, requiredVersion: 'test' } });
    await using f = await fixture();
    expect(f.wrapper.get('[data-testid="live-speech-unavailable"]').text()).toContain('not installed');
    expect(f.wrapper.get('[data-testid="live-start"]').attributes('disabled')).toBeDefined();
    expect(f.wrapper.get('[data-testid="live-speech-start"]').attributes('disabled')).toBeDefined();
    expect(f.runLiveSession).not.toHaveBeenCalled();
  });

  it('classifies an actual Haru header in standalone and keeps it out of the LM engine', async () => {
    const header = speechModelHeader({ architecture: 'haru', frameSamples: 3200 });
    const file = new NativeFile([new Uint8Array(await header.arrayBuffer())], 'arbitrary-model.gguf');
    captureModelFiles.mockResolvedValue({ primaryRelativePath: file.name, files: [{ relativePath: file.name, file }] });
    const facade = '@/features/speech-cpp-browser/models';
    const aliases = createStandaloneFacadeAliases({ resolvePath: path => `${process.cwd()}/${path}` });
    const replacement = aliases.find(({ find }) => find instanceof RegExp && find.test(facade))?.replacement ?? facade;
    const models = await vi.importActual<typeof import('@/features/speech-cpp-browser/models')>(replacement);
    vi.mocked(inspectStoredSpeechModel).mockImplementation(models.inspectStoredSpeechModel);
    const standalone = createStandaloneSpeechClient({ observers: { onFrame() {}, onState() {} } });
    speechCapability = standalone.capability;
    await using f = await fixture();
    expect(captureModelFiles).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'user/live' }));
    expect(f.wrapper.get('[data-testid="live-speech-unavailable"]').text()).toContain('hosted version');
    expect(f.wrapper.get('[data-testid="live-start"]').attributes('disabled')).toBeDefined();
    expect(f.wrapper.get('[data-testid="live-speech-start"]').attributes('disabled')).toBeDefined();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    expect(f.runLiveSession).not.toHaveBeenCalled();
    expect(openStoredSpeechModel).not.toHaveBeenCalled();
    expect(f.speech.client.loadModel).not.toHaveBeenCalled();
    await standalone.dispose();
  });

  it('selects continuous speech by metadata and keeps unsupported actions visibly disabled', async () => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue({ kind: 'speech', info: { name: 'arbitrary-name', architecture: 'haru', task: 'dialogue', bytes: 1, sampleRate: 24000, frameSamples: 3200, requiredVersion: 'test' } });
    await using f = await fixture();
    expect(f.wrapper.get('[data-testid="live-speech-help"]').text()).toContain('microphone');
    expect(f.wrapper.find('[data-testid="live-composer"]').exists()).toBe(false);
    expect(f.wrapper.get('[data-testid="live-input-text-enabled"]').attributes('disabled')).toBeDefined();
    expect(f.wrapper.get('[data-testid="live-input-images-enabled"]').attributes('disabled')).toBeDefined();
    expect(f.wrapper.get('[data-testid="live-transcription"]').attributes('disabled')).toBeDefined();
    expect(f.wrapper.get('[data-testid="live-wesh-enabled"]').attributes('disabled')).toBeDefined();
    const transfer = { types: ['Files'], dropEffect: 'copy', files: [new File(['audio'], 'unused.wav')] };
    await f.wrapper.get('[data-testid="live-conversation-page"]').trigger('dragenter', { dataTransfer: transfer });
    await f.wrapper.get('[data-testid="live-conversation-page"]').trigger('dragover', { dataTransfer: transfer });
    expect(transfer.dropEffect).toBe('none');
    expect(f.wrapper.find('[data-testid="live-drop-overlay"]').exists()).toBe(false);
    await f.wrapper.get('[data-testid="live-conversation-page"]').trigger('drop', { dataTransfer: transfer });
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    expect(openStoredSpeechModel).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'user/live' }));
    expect(f.runLiveSession).not.toHaveBeenCalled();
    await f.wrapper.get('[data-testid="live-speech-start"]').trigger('click');
    await flushPromises();
    expect(f.speech.client.start).toHaveBeenCalledWith({ options: { inputSampleRate: 24000, maxSeconds: 120, language: 'en', persona: undefined, name: undefined } });
    f.speech.frame({ text: 'Continuous answer', samples: new Float32Array([0.3]) });
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-speech-text"]').text()).toBe('Continuous answer');
    expect(f.wrapper.find('[data-testid="live-input-transcript"]').exists()).toBe(false);
    await f.wrapper.get('[data-testid="live-speech-mute-microphone"]').trigger('click');
    expect(f.speech.controller.getState().microphone).toBe('off');
    expect(f.wrapper.get('[data-testid="live-speech-mute-microphone"]').attributes('aria-pressed')).toBe('true');
    expect(f.wrapper.get('[data-testid="live-speech-audio-status"]').text()).toContain('muted');
    await f.wrapper.get('[data-testid="live-speech-mute-playback"]').trigger('click');
    expect(f.speech.player.mute).toHaveBeenLastCalledWith({ value: 'off' });
    expect(f.speech.controller.getState().microphone).toBe('off');
    expect(f.speech.client.stop).not.toHaveBeenCalled();
    await f.wrapper.get('[data-testid="live-speech-stop"]').trigger('click');
    await flushPromises();
    expect(f.speech.client.stop).toHaveBeenCalledWith({ mode: 'cancel' });
    expect(f.speech.client.releaseModel).not.toHaveBeenCalled();
    await f.wrapper.get('[data-testid="live-open-settings"]').trigger('click');
    await flushPromises();
    await f.page.get('[data-testid="live-release"]').trigger('click');
    await flushPromises();
    expect(f.speech.client.releaseModel).toHaveBeenCalledOnce();
  });

  it('does not announce readiness before model loading completes', async () => {
    await using f = await fixture();
    f.state.value = { ...f.state.value, phase: 'loading' };
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-empty"]').text()).toBe(f.wrapper.get('[data-testid="live-status"]').text());
    expect(f.wrapper.get('[data-testid="live-record"]').attributes('disabled')).toBeDefined();
    expect(f.wrapper.get('[data-testid="live-open-settings"]').attributes('disabled')).toBeUndefined();
  });

  it('keeps header and composer outside the message scroller and opens settings without replacing the catalog', async () => {
    await using f = await fixture();
    const scroller = f.wrapper.get('[data-testid="live-message-scroll"]').element;
    const header = f.wrapper.get('[data-testid="live-header"]').element;
    const footer = f.wrapper.get('[data-testid="live-composer-footer"]').element;
    expect(scroller.contains(header)).toBe(false);
    expect(scroller.contains(footer)).toBe(false);
    expect(header.parentElement).toBe(scroller.parentElement);
    expect(footer.parentElement).toBe(scroller.parentElement);
    const catalog = f.wrapper.findComponent({ name: 'LiveCatalogStub' }).vm;
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    await f.wrapper.get('[data-testid="live-text"]').setValue('unfinished draft');
    scroller.scrollTop = 120;
    await f.wrapper.get('[data-testid="live-open-settings"]').trigger('click');
    await flushPromises();
    expect(f.page.find('[role="dialog"]').exists()).toBe(true);
    expect(f.wrapper.findComponent({ name: 'LiveCatalogStub' }).vm).toBe(catalog);
    expect(f.wrapper.get('[data-testid="live-conversation-page"]').attributes('inert')).toBeDefined();
    await f.page.get('[data-testid="live-settings-close"]').trigger('click');
    await flushPromises();
    expect(scroller.scrollTop).toBe(120);
    expect(f.wrapper.get<HTMLTextAreaElement>('[data-testid="live-text"]').element.value).toBe('unfinished draft');
    expect(f.runLiveSession).toHaveBeenCalledOnce();
    expect(f.wrapper.findComponent({ name: 'LiveCatalogStub' }).vm).toBe(catalog);
  });

  it('shows the resident model in the header when a different next model is selected', async () => {
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    f.wrapper.findComponent({ name: 'LiveCatalogStub' }).vm.$emit('select', { modelId: 'next/model', size: 1, importedAt: 0 });
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-header-model"]').attributes('title')).toBe('user/live');
    expect(f.wrapper.get('[data-testid="live-header-model"]').text()).toBe('live');
    await f.wrapper.get('[data-testid="live-new-conversation"]').trigger('click');
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-header-model"]').attributes('title')).toBe('next/model');
  });

  it('keeps submitted images in history after composer URLs are released and clears them with a new conversation', async () => {
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    const file = new File(['original'], 'attached.png', { type: 'image/png' });
    const picker = f.wrapper.get<HTMLInputElement>('[data-testid="live-images"]');
    Object.defineProperty(picker.element, 'files', { configurable: true, value: [file] });
    await picker.trigger('change');
    await f.wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(f.wrapper.find('[data-testid="live-draft-images"]').exists()).toBe(false);
    expect(f.state.value.entries[0]!.images[0]!.blob).toBe(file);
    expect(f.wrapper.get('[data-testid="live-message-images"]').text()).toContain(file.name);
    await f.wrapper.get('[data-testid="live-image-preview"]').trigger('click');
    await flushPromises();
    expect(f.page.find('[data-testid="preview-image"]').exists()).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    await flushPromises();
    await f.wrapper.get('[data-testid="live-new-conversation"]').trigger('click');
    await flushPromises();
    expect(f.wrapper.find('[data-testid="live-message-images"]').exists()).toBe(false);
    expect(f.state.value.entries).toEqual([]);
    expect(f.runLiveSession).toHaveBeenCalledOnce();
  });

  it('starts only explicitly and keeps the resident model while allowing the next model selection', async () => {
    await using f = await fixture();
    expect(f.runLiveSession).not.toHaveBeenCalled();
    expect(f.capture).not.toHaveBeenCalled();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    expect(f.runLiveSession).toHaveBeenCalledOnce();
    expect(f.page.get('[data-testid="live-model"]').attributes('disabled')).toBeUndefined();
    expect(f.capture).not.toHaveBeenCalled();
    await f.page.get('[data-testid="live-release"]').trigger('click');
    await flushPromises();
    expect(f.wrapper.find('[data-testid="live-start"]').exists()).toBe(true);
  });

  it('changes only the next response channels without another model load', async () => {
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    await f.page.get('[data-testid="live-output-voice"]').setValue(false);
    await f.wrapper.get('[data-testid="live-text"]').setValue('Hello');
    await f.wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(f.request.mock.calls.find(([args]) => args.command.type === 'respond')?.[0].command).toMatchObject({ output: 'text' });
    expect(f.runLiveSession).toHaveBeenCalledOnce();
    expect(f.wrapper.get('[data-testid="live-history"]').text()).toContain('Answer');
    await f.page.get('[data-testid="live-output-text"]').setValue(false);
    expect(f.wrapper.get('[data-testid="live-record"]').attributes('disabled')).toBeDefined();
    expect(f.wrapper.get('[data-testid="live-send"]').attributes('disabled')).toBeDefined();
  });

  it('uses a plain text transcript rather than interpreting model HTML', async () => {
    await using f = await fixture();
    f.state.value = { ...f.state.value, entries: [{ id: 'turn', modelId: 'LiquidAI/LFM3-Omni-2B', audioSource: { kind: 'microphone' }, inputAudio: undefined, outputAudio: undefined, inputStatistics: undefined, inputText: '<script>bad()</script>', images: [], hasAudio: true, transcript: '', answer: '<img src=x onerror=bad()>', output: 'mixed', status: 'complete', toolResults: [] }] };
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-history"]').text()).toContain('<img src=x onerror=bad()>');
    expect(f.wrapper.find('[data-testid="live-history"] img').exists()).toBe(false);
    expect(f.wrapper.find('[data-testid="live-history"] script').exists()).toBe(false);
  });

  it('keeps image controls visible but unavailable for an Audio-only model', async () => {
    await using f = await fixture();
    f.scope.info.vision = 'unavailable';
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-images"]').attributes('disabled')).toBeDefined();
    expect(f.wrapper.get('[data-testid="live-record"]').attributes('disabled')).toBeUndefined();
  });

  it('defaults to input transcription but not retaining audio, and keeps settings outside the composer', async () => {
    await using f = await fixture();
    expect(f.wrapper.get<HTMLInputElement>('[data-testid="live-transcription"]').element.checked).toBe(true);
    expect(f.wrapper.get<HTMLInputElement>('[data-testid="live-keep-audio"]').element.checked).toBe(false);
    expect(f.wrapper.get('[data-testid="live-settings"]').find('[data-testid="live-transcription"]').exists()).toBe(true);
    expect(f.wrapper.get('[data-testid="live-text"]').attributes('disabled')).toBeUndefined();
    expect(f.wrapper.text()).not.toContain('Wesh');
    expect(f.wrapper.text()).toContain('disappear on reload');
  });

  it('clears conversation with confirmation but does not reload the resident model', async () => {
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    await f.wrapper.get('[data-testid="live-text"]').setValue('question');
    await f.wrapper.get('form').trigger('submit');
    await flushPromises();
    await f.wrapper.get('[data-testid="live-text"]').setValue('next draft');
    confirm.mockResolvedValueOnce(false);
    await f.wrapper.get('[data-testid="live-new-conversation"]').trigger('click');
    await flushPromises();
    expect(f.state.value.entries).toHaveLength(1);
    expect(f.wrapper.get<HTMLTextAreaElement>('[data-testid="live-text"]').element.value).toBe('next draft');
    await f.wrapper.get('[data-testid="live-new-conversation"]').trigger('click');
    await flushPromises();
    expect(f.state.value.entries).toEqual([]);
    expect(f.state.value.phase).toBe('ready');
    expect(f.runLiveSession).toHaveBeenCalledOnce();
    expect(f.player.close).not.toHaveBeenCalled();
    expect(f.wrapper.get<HTMLTextAreaElement>('[data-testid="live-text"]').element.value).toBe('');
  });

  it('allows composing and editing a queue during playback, then submits in order', async () => {
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    const notify = f.playback.mock.calls[0]![0].onPlaying;
    notify({ playing: true });
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-text"]').attributes('disabled')).toBeUndefined();
    expect(f.wrapper.get('[data-testid="live-images"]').attributes('disabled')).toBeUndefined();
    await f.wrapper.get('[data-testid="live-text"]').setValue('queued');
    await f.wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.wrapper.findAll('[data-testid="live-pending-message"]')).toHaveLength(1);
    await f.wrapper.get('[data-testid="live-pending-message"] textarea').setValue('edited before send');
    await f.wrapper.get('[data-testid="live-text"]').setValue('a different draft');
    notify({ playing: false });
    await flushPromises();
    expect(f.request.mock.calls[0]?.[0].command).toMatchObject({ type: 'begin', text: 'edited before send' });
    expect(f.wrapper.get<HTMLTextAreaElement>('[data-testid="live-text"]').element.value).toBe('a different draft');
    expect(f.runLiveSession).toHaveBeenCalledOnce();
  });

  it('keeps catalog downloads available and observes their inventory without touching a resident session', async () => {
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    const catalog = f.wrapper.findComponent({ name: 'LiveCatalogStub' });
    expect(catalog.props('disabled')).toBe(false);
    expect(catalog.props('selectionAction')).toBe('select');
    const listener = vi.mocked(llamaCppBrowserModelFiles.subscribeModelList).mock.calls[0]![0].listener;
    listener();
    await flushPromises();
    expect(listModelInventory).toHaveBeenCalled();
    expect(f.runLiveSession).toHaveBeenCalledOnce();
    expect(f.player.close).not.toHaveBeenCalled();
  });

  it('accepts file input without microphone permission and renders the real model name', async () => {
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    const element = f.wrapper.get<HTMLInputElement>('[data-testid="live-audio-file"]');
    Object.defineProperty(element.element, 'files', { configurable: true, value: [new File(['data'], 'clear-speech.wav', { type: 'audio/wav' })] });
    await element.trigger('change');
    expect(f.wrapper.get('[data-testid="live-draft-audio"]').text()).toContain('clear-speech.wav');
    await f.wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(f.decodeFile).toHaveBeenCalledOnce();
    expect(f.capture).not.toHaveBeenCalled();
    expect(f.request.mock.calls.map(([args]) => args.command.type)).toEqual(['begin', 'audio', 'transcribe', 'respond']);
    expect(f.wrapper.get('[data-testid="live-history"]').text()).toContain('live');
    expect(f.wrapper.find('[data-testid="live-input-replay"]').exists()).toBe(false);
  });

  it('selects a downloaded model for the next conversation without replacing the active one early', async () => {
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    f.wrapper.findComponent({ name: 'LiveCatalogStub' }).vm.$emit('select', { modelId: 'user/LFM3-Omni-2B', size: 1, importedAt: 0 });
    await flushPromises();
    expect(f.runLiveSession).toHaveBeenCalledOnce();
    expect(f.player.close).not.toHaveBeenCalled();
    expect(f.page.get<HTMLInputElement>('[data-testid="live-model"]').element.value).toBe('user/LFM3-Omni-2B');
    await f.wrapper.get('[data-testid="live-text"]').setValue('keep this until confirmed');
    confirm.mockResolvedValueOnce(false);
    await f.wrapper.get('[data-testid="live-new-conversation"]').trigger('click');
    await flushPromises();
    expect(f.runLiveSession).toHaveBeenCalledOnce();
    await f.wrapper.get('[data-testid="live-new-conversation"]').trigger('click');
    await flushPromises();
    expect(f.runLiveSession).toHaveBeenCalledTimes(2);
    expect(f.runLiveSession.mock.calls[1]?.[0].modelId).toBe('user/LFM3-Omni-2B');
    expect(f.state.value.entries).toEqual([]);
    expect(f.wrapper.get<HTMLTextAreaElement>('[data-testid="live-text"]').element.value).toBe('');
  });

  it('mutes automatic speech for manual replay and releases the preview on send without cancelling inference', async () => {
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    const audio = f.wrapper.get<HTMLInputElement>('[data-testid="live-audio-file"]');
    Object.defineProperty(audio.element, 'files', { configurable: true, value: [new File(['data'], 'comparison.wav', { type: 'audio/wav' })] });
    await audio.trigger('change');
    const notify = f.playback.mock.calls[0]![0].onPlaying;
    notify({ playing: true });
    await f.wrapper.get('[data-testid="live-draft-audio"] audio').trigger('play');
    await flushPromises();
    expect(f.player.mute).toHaveBeenCalledWith({ value: 'off' });
    expect(f.scope.interrupt).not.toHaveBeenCalled();
    await f.wrapper.get('form').trigger('submit');
    notify({ playing: false });
    await flushPromises();
    expect(f.wrapper.find('[data-testid="live-pending"]').exists()).toBe(false);
    expect(f.request.mock.calls.map(([args]) => args.command.type)).toEqual(['begin', 'audio', 'transcribe', 'respond']);
    expect(f.scope.interrupt).not.toHaveBeenCalled();
    expect(f.runLiveSession).toHaveBeenCalledOnce();
  });

  it('accepts an image drop while speech is playing without sending it or clearing the draft', async () => {
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    f.playback.mock.calls[0]![0].onPlaying({ playing: true });
    await f.wrapper.get('[data-testid="live-text"]').setValue('draft with image');
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: [new File(['image'], 'picture.png', { type: 'image/png' })] } });
    f.wrapper.get('[data-testid="live-conversation-page"]').element.dispatchEvent(event);
    await flushPromises();
    expect(event.defaultPrevented).toBe(true);
    expect(f.wrapper.get<HTMLTextAreaElement>('[data-testid="live-text"]').element.value).toBe('draft with image');
    expect(f.wrapper.find('[data-testid="live-draft-images"]').exists()).toBe(true);
    expect(f.request).not.toHaveBeenCalled();
  });
});
