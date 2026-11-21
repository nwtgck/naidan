import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, onMounted, shallowRef, computed } from 'vue';
import { DOMWrapper, mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { useLiveConversation } from '@/features/live-conversation/composables/useLiveConversation';
import { createLiveControllerFixture } from '@/features/live-conversation/logic/controller.test-support';
import LiveConversationView from './LiveConversationView.vue';
import ModelSelector from '@/components/ModelSelector.vue';
import { useLiveModelPreference } from '@/features/live-conversation/composables/useLiveModelPreference';
import { listModelInventory } from '@/features/llama-cpp-browser/composables/model-inventory';
import { llamaCppBrowserModelFiles } from '@/features/llama-cpp-browser/model-files';
import { acquireRepositoryModel } from '@/features/llama-cpp-browser/model-launch/acquire-repository-model';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import { useLiveSpeechConversation } from '@/features/live-conversation/composables/useLiveSpeechConversation';
import { useSpeechRecognition } from '@/features/live-conversation/composables/useSpeechRecognition';
import { useSpeechResponseRecording } from '@/features/live-conversation/composables/useSpeechResponseRecording';
import { inspectStoredSpeechRecognitionModel, openStoredSpeechRecognitionModel } from '@/features/speech-cpp-browser/recognition/models';
import { createRecognitionUiFixture } from './recognition-ui.test-support';
import { createLiveSpeechFixture } from '@/features/live-conversation/logic/speech-controller.test-support';
import { inspectStoredSpeechModel, openStoredSpeechModel } from '@/features/speech-cpp-browser/models';
import { SpeechRuntimeError, type SpeechCapability, type SpeechFailure } from '@/features/speech-cpp-browser/types';
import { createSpeechClient as createStandaloneSpeechClient } from '@/features/speech-cpp-browser/worker/client-standalone';
import { speechModelHeader } from '@/features/speech-cpp-browser/worker/model-file.test-support';
import { File as NativeFile } from 'node:buffer';
import { createStandaloneFacadeAliases } from '../../../../build/standalone-facades.js';
import SettingsSelect from '@/components/SettingsSelect.vue';
import { setLocale } from '@/strings';
import { ensureStrings } from '@/strings';
import LlamaCppBrowserManager from '@/features/llama-cpp-browser/components/LlamaCppBrowserManager.vue';
import { downloadSpeechInvestigation } from '@/features/speech-cpp-browser/investigation/archive';
import type { SpeechInvestigationSnapshot } from '@/features/speech-cpp-browser/investigation/types';

const confirm = vi.hoisted(() => vi.fn(async () => true));
const captureModelFiles = vi.hoisted(() => vi.fn());
const speechInspection: Awaited<ReturnType<typeof inspectStoredSpeechModel>> = { kind: 'speech', info: { name: 'model', architecture: 'haru', task: 'dialogue', bytes: 1, sampleRate: 24000, frameSamples: 3200, requiredVersion: 'test' } };
const recognitionInspection: Awaited<ReturnType<typeof inspectStoredSpeechRecognitionModel>> = { kind: 'recognition', info: { name: 'ASR model', bytes: 1, architecture: 'qwen3-asr', task: 'recognition', sampleRate: 16000, requiredVersion: 'test' } };
const residentPanels = [['speech', 'conversation'], ['speech', 'diagnostics'], ['llama', 'conversation'], ['llama', 'diagnostics']] as const;
let speechCapability: SpeechCapability = { kind: 'available' };
let managerInventory: LocalModel[];
vi.mock('@/composables/useConfirm', () => ({ useConfirm: () => ({ showConfirm: confirm }) }));
vi.mock('@/features/live-conversation/composables/useLiveModelPreference', () => ({ useLiveModelPreference: vi.fn() }));
vi.mock('@/features/llama-cpp-browser/composables/model-inventory', () => ({ listModelInventory: vi.fn(async () => [{ modelId: 'user/live', size: 1, importedAt: 0 }]) }));
vi.mock('@/features/llama-cpp-browser/model-files', () => ({ llamaCppBrowserModelFiles: { subscribeModelList: vi.fn(() => vi.fn()), captureModelFiles } }));
vi.mock('@/features/llama-cpp-browser/model-launch/acquire-repository-model', () => ({ acquireRepositoryModel: vi.fn() }));
vi.mock('@/features/llama-cpp-browser/components/LlamaCppBrowserRepositoryPicker.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: defineComponent({
    name: 'LiveCatalogStub',
    props: ['suggestions', 'disabled', 'layout', 'selectionPolicy'],
    emits: ['select-model'],
    setup: () => () => h('div', { 'data-testid': 'mock-catalog' }),
  }),
}));

vi.mock('@/features/live-conversation/composables/useLiveConversation', () => ({ useLiveConversation: vi.fn() }));
vi.mock('@/features/live-conversation/composables/useLiveSpeechConversation', () => ({ useLiveSpeechConversation: vi.fn() }));
vi.mock('@/features/live-conversation/composables/useSpeechRecognition', () => ({ useSpeechRecognition: vi.fn() }));
vi.mock('@/features/live-conversation/composables/useSpeechResponseRecording', () => ({ useSpeechResponseRecording: vi.fn() }));
vi.mock('@/features/speech-cpp-browser/investigation/archive', () => ({ downloadSpeechInvestigation: vi.fn(async () => {}) }));
vi.mock('@/features/speech-cpp-browser/recognition/models', () => ({ inspectStoredSpeechRecognitionModel: vi.fn(async () => ({ kind: 'other' })), openStoredSpeechRecognitionModel: vi.fn(async () => new File(['ASR model'], 'recognition.gguf')) }));
vi.mock('@/features/speech-cpp-browser/models', () => ({ inspectStoredSpeechModel: vi.fn(async () => ({ kind: 'other' })), openStoredSpeechModel: vi.fn(async () => new File(['model'], 'model.gguf')) }));
vi.mock('@/00-storage/service', () => ({
  storageService: {
    listVolumes: async function* () {},
    subscribeLocalModelPromotions: () => () => {},
    subscribeToChanges: () => () => {},
  },
}));
vi.mock('@/features/llama-cpp-browser/components/LlamaCppBrowserManager.vue', () => ({
  default: defineComponent({
    props: ['suspended', 'runtimeSettings'],
    emits: ['models-changed', 'model-selected', 'runtime-ready'],
    setup(_props, { emit }) {
      onMounted(() => {
        emit('models-changed', managerInventory);
        const firstModel = managerInventory[0];
        if (firstModel) {
          emit('model-selected', firstModel.modelId);
        }
        emit('runtime-ready', true);
      });
      return () => h('div', { 'data-testid': 'mock-model-manager' });
    },
  }),
}));

beforeEach(async () => {
  vi.clearAllMocks();
  captureModelFiles.mockReset();
  speechCapability = { kind: 'available' };
  managerInventory = [{ modelId: 'user/live', size: 1, importedAt: 0 }];
  vi.mocked(acquireRepositoryModel).mockReset();
  vi.mocked(inspectStoredSpeechModel).mockResolvedValue({ kind: 'other' });
  vi.mocked(openStoredSpeechModel).mockResolvedValue(new File(['model'], 'model.gguf'));
  vi.mocked(inspectStoredSpeechRecognitionModel).mockResolvedValue({ kind: 'other' });
  vi.mocked(openStoredSpeechRecognitionModel).mockResolvedValue(new File(['ASR model'], 'recognition.gguf'));
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
  const recognition = createRecognitionUiFixture();
  const recognitionState = shallowRef(recognition.controller.getState());
  recognition.onChange.mockImplementation(({ state: next }) => {
    recognitionState.value = next;
  });
  const recordingState = shallowRef(recognition.recorder.getState());
  recognition.onRecordingChange.mockImplementation(({ state: next }) => {
    recordingState.value = next;
  });
  vi.mocked(useSpeechRecognition).mockReturnValue({
    state: recognitionState,
    controller: {
      ...recognition.controller,
      async runFile({ file, language, investigation }) {
        await recognition.controller.runFile({ file, language, ...(investigation === undefined ? {} : { investigation }) });
      },
      async runAudio({ samples, sampleRate, inputName, language, investigation }) {
        await recognition.controller.runAudio({ samples, sampleRate, inputName, language, ...(investigation === undefined ? {} : { investigation }) });
      },
    },
    recordingState,
    recording: recognition.recording,
    TEST_ONLY: {},
  });
  const responseRecording = createRecognitionUiFixture();
  const responseRecordingState = shallowRef(responseRecording.recorder.getState());
  responseRecording.onRecordingChange.mockImplementation(({ state: next }) => {
    responseRecordingState.value = next;
  });
  vi.mocked(useSpeechResponseRecording).mockReturnValue({ recordingState: responseRecordingState, recording: { start: () => responseRecording.recorder.start({ language: undefined }), stop: responseRecording.recorder.stop, discard: responseRecording.recorder.discard }, TEST_ONLY: {} });
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  let urlSequence = 0;
  const createUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:attachment-${++urlSequence}`);
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
    speechState,
    recognition,
    recognitionState,
    recordingState,
    responseRecording,
    responseRecordingState,
    createUrl,
    revokeUrl,
    wrapper,
    page,
    async [Symbol.asyncDispose]() {
      wrapper.unmount();
      host.remove();
      await f.controller.dispose();
      await speech.controller.dispose();
      await recognition.controller.dispose();
      await recognition.recorder.dispose();
      await responseRecording.recorder.dispose();
      await responseRecording.controller.dispose();
      pause.mockRestore();
      createUrl.mockRestore();
      revokeUrl.mockRestore();
    },
  };
}

async function openCatalog({ page }: { page: DOMWrapper<HTMLElement> }): Promise<void> {
  await page.get('[data-testid="live-model"] [data-testid="model-selector-trigger"]').trigger('click');
  await page.get('[data-testid="model-selector-tabs"] button').trigger('click');
  await flushPromises();
}

async function selectDownloadedModel({ wrapper, page, modelId }: { wrapper: VueWrapper, page: DOMWrapper<HTMLElement>, modelId: string }): Promise<void> {
  const openedSettings = !page.get('[data-testid="live-settings-surface"]').isVisible();
  if (openedSettings) {
    await wrapper.get('[data-testid="live-open-settings"]').trigger('click');
  }
  await openCatalog({ page });
  wrapper.getComponent({ name: 'LiveCatalogStub' }).vm.$emit('select-model', { modelId, size: 1, importedAt: 0 });
  if (openedSettings) {
    await page.get('[data-testid="live-settings-close"]').trigger('click');
  }
  await flushPromises();
}

function downloadedSnapshot(): SpeechInvestigationSnapshot | undefined {
  const collection = vi.mocked(downloadSpeechInvestigation).mock.calls.at(-1)?.[0].collection;
  if (!collection) {
    return undefined;
  }
  for (const trial of [...collection.trials].reverse()) {
    switch (trial.status) {
    case 'not_run': break;
    case 'in_progress': case 'completed': case 'partial': case 'cancelled': case 'failed':
      if (trial.snapshot) {
        return trial.snapshot;
      }
      break;
    default: {
      const exhaustive: never = trial;
      throw new Error(String(exhaustive));
    }
    }
  }
  return collection.load;
}

describe('independent live conversation workspace', () => {
  it('groups compatible quantizations in diagnostics and resets the open list when the task changes', async () => {
    const dialogueModels = ['hf.co/example/Haru-GGUF:Q4_K_M', 'hf.co/example/Haru-GGUF:Q8_0'];
    const transcriptionModel = 'hf.co/example/ASR-GGUF:Q8_0';
    managerInventory = [...dialogueModels, transcriptionModel, 'user/unrelated'].map(modelId => ({ modelId, size: 1, importedAt: 0 }));
    vi.mocked(inspectStoredSpeechModel).mockImplementation(async ({ modelId }) => dialogueModels.includes(modelId) ? speechInspection : { kind: 'other' });
    vi.mocked(inspectStoredSpeechRecognitionModel).mockImplementation(async ({ modelId }) => modelId === transcriptionModel ? recognitionInspection : { kind: 'other' });
    await using f = await fixture();
    await f.wrapper.setProps({ panel: 'diagnostics', task: 'response' });
    await flushPromises();
    const trigger = '[data-testid="live-diagnostics-model"] [data-testid="model-selector-trigger"]';
    const dropdown = '[data-testid="model-selector-dropdown"]';
    await f.wrapper.get(trigger).trigger('click');
    const picker = f.page.get(dropdown);
    expect(picker.findAll('[data-testid="model-selector-stored-variant-group"]')).toHaveLength(1);
    expect(picker.get('[data-testid="model-selector-option"]').attributes('title')).toBe(dialogueModels[0]);
    expect(picker.find('[data-testid="model-selector-stored-variant"]').exists()).toBe(true);

    await f.wrapper.setProps({ task: 'transcription' });
    await flushPromises();
    expect(f.page.find(dropdown).exists()).toBe(false);
    expect(f.wrapper.get('[data-testid="live-diagnostics-load-model"]').attributes('disabled')).toBeDefined();
    await f.wrapper.get(trigger).trigger('click');
    const transcriptionPicker = f.page.get(dropdown);
    expect(transcriptionPicker.findAll('[data-testid="model-selector-option"]').map(option => option.attributes('title'))).toEqual([transcriptionModel]);
    await transcriptionPicker.get('[data-testid="model-selector-option"]').trigger('click');
    await flushPromises();
    expect(f.wrapper.get(trigger).attributes('title')).toBe(transcriptionModel);
    expect(f.wrapper.get('[data-testid="live-diagnostics-load-model"]').attributes('disabled')).toBeUndefined();
    expect(f.recognition.client.loadModel).not.toHaveBeenCalled();
  });

  it.each([
    ['speech', 'conversation'], ['speech', 'diagnostics'], ['recognition', 'conversation'], ['recognition', 'diagnostics'],
  ] as const)('keeps the %s load failure through inventory refresh and cleanup in %s until a different model is selected', async (engine, panel) => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue(engine === 'speech' ? speechInspection : { kind: 'other' });
    vi.mocked(inspectStoredSpeechRecognitionModel).mockResolvedValue(recognitionInspection);
    await using f = await fixture();
    await f.wrapper.setProps({ panel, task: engine === 'speech' ? 'response' : 'transcription' });
    await flushPromises();
    const failureSelector = `[data-testid="${panel === 'diagnostics' ? 'live-diagnostics-model-failure' : 'live-model-failure'}"]`;
    const target = engine === 'speech' ? f.speech : f.recognition;
    const failure: SpeechFailure = { code: 'runtime_failed', message: 'GGUF tensor size overflow', nativeStatus: -5, nativeInput: 'model_source' };
    vi.mocked(target.client.loadModel).mockRejectedValueOnce(new SpeechRuntimeError({ details: failure }));
    await f.page.get(`[data-testid="${panel === 'diagnostics' ? 'live-diagnostics-load-model' : 'live-start'}"]`).trigger('click');
    await flushPromises();
    expect(f.page.get(failureSelector).text()).toContain(failure.message);
    // Physical cleanup and a refreshed selector list are not a new load attempt.
    await target.controller.release();
    target.change({ state: { phase: 'unloaded', model: undefined, failure: undefined } });
    await f.recognition.controller.clearRun();
    const manager = f.wrapper.findComponent(LlamaCppBrowserManager);
    manager.vm.$emit('models-changed', [{ modelId: 'user/live', size: 1, importedAt: 0 }]);
    await flushPromises();
    const alert = f.page.get(failureSelector);
    expect(alert.text()).toContain(failure.message);
    expect(alert.text()).toContain(String(failure.nativeStatus));
    expect(alert.text()).toContain(failure.nativeInput);
    vi.mocked(inspectStoredSpeechModel).mockRejectedValueOnce(new Error('Inventory refresh could not read the candidate'));
    manager.vm.$emit('models-changed', [{ modelId: 'user/live', size: 1, importedAt: 0 }]);
    await flushPromises();
    expect(f.page.get(failureSelector).text()).toContain(failure.message);
    expect(f.page.get(failureSelector).text()).not.toContain('Inventory refresh could not read the candidate');
    manager.vm.$emit('model-selected', 'next/model');
    await flushPromises();
    expect(f.page.find(failureSelector).exists()).toBe(false);
  });

  it('clears the previous model load error on an explicit retry and replaces it with the new native failure', async () => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue(speechInspection);
    await using f = await fixture();
    vi.mocked(f.speech.client.loadModel).mockRejectedValueOnce(new Error('First load failed'));
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    expect(f.page.get('[data-testid="live-model-failure"]').text()).toContain('First load failed');
    const retry = Promise.withResolvers<void>();
    using gate = {
      [Symbol.dispose]() {
        retry.resolve();
      },
    };
    vi.mocked(f.speech.client.loadModel).mockReturnValueOnce(retry.promise);
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    expect(f.page.find('[data-testid="live-model-failure"]').exists()).toBe(false);
    retry.reject(new SpeechRuntimeError({ details: { code: 'runtime_failed', message: 'Second load failed', nativeStatus: -7, nativeInput: 'device' } }));
    await flushPromises();
    const alert = f.page.get('[data-testid="live-model-failure"]');
    expect(alert.text()).toContain('Second load failed');
    expect(alert.text()).toContain('-7');
    expect(alert.text()).toContain('device');
    expect(alert.text()).not.toContain('First load failed');
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    expect(f.page.find('[data-testid="live-model-failure"]').exists()).toBe(false);
    expect(f.speech.controller.getState().runtime.phase).toBe('ready');
    void gate;
  });

  it('clears an inspection error after the same candidate is successfully inspected again', async () => {
    vi.mocked(inspectStoredSpeechModel).mockRejectedValue(new Error('Candidate could not be read'));
    await using f = await fixture();
    expect(f.page.get('[data-testid="live-model-failure"]').text()).toContain('Candidate could not be read');
    const manager = f.wrapper.findComponent(LlamaCppBrowserManager);
    vi.mocked(inspectStoredSpeechModel).mockRejectedValue(new Error('Candidate metadata is incomplete'));
    manager.vm.$emit('models-changed', [{ modelId: 'user/live', size: 1, importedAt: 0 }]);
    await flushPromises();
    expect(f.page.get('[data-testid="live-model-failure"]').text()).toContain('Candidate metadata is incomplete');
    expect(f.page.get('[data-testid="live-model-failure"]').text()).not.toContain('Candidate could not be read');
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue(speechInspection);
    manager.vm.$emit('models-changed', [{ modelId: 'user/live', size: 1, importedAt: 0 }]);
    await flushPromises();
    expect(f.page.find('[data-testid="live-model-failure"]').exists()).toBe(false);
  });

  it.each(['response', 'transcription'] as const)('saves a real failure during %s model preparation without a model file', async task => {
    if (task === 'response') {
      vi.mocked(inspectStoredSpeechModel).mockResolvedValue(speechInspection);
      vi.mocked(openStoredSpeechModel).mockRejectedValue(new Error('Model source unavailable'));
    } else {
      vi.mocked(inspectStoredSpeechRecognitionModel).mockResolvedValue(recognitionInspection);
      vi.mocked(openStoredSpeechRecognitionModel).mockRejectedValue(new Error('Model source unavailable'));
    }
    await using f = await fixture();
    await f.wrapper.setProps({ panel: 'diagnostics', task });
    await flushPromises();
    await f.wrapper.get('[data-testid="live-diagnostics-load-model"]').trigger('click');
    await flushPromises();
    await f.wrapper.get('[data-testid="live-investigation-save"]').trigger('click');
    await flushPromises();
    const saved = downloadedSnapshot();
    expect(saved?.status).toBe('failed');
    expect(saved?.operation.source.kind).toBe('unset');
    expect(saved?.operation.failure).toMatchObject({ status: 'observed', value: { message: 'Model source unavailable' } });
    expect(saved?.events.map(item => item.event)).toContainEqual(expect.objectContaining({ kind: 'stage', stage: 'app_model_load', state: 'failed', durationMilliseconds: expect.any(Number) }));
  });

  it('saves a microphone permission failure before a recognition run is accepted', async () => {
    vi.mocked(inspectStoredSpeechRecognitionModel).mockResolvedValue(recognitionInspection);
    await using f = await fixture();
    await f.wrapper.setProps({ panel: 'diagnostics', task: 'transcription' });
    await flushPromises();
    await f.wrapper.get('[data-testid="live-diagnostics-load-model"]').trigger('click');
    await flushPromises();
    f.recognition.capture.mockRejectedValueOnce(new Error('Microphone permission denied'));
    await f.wrapper.get('[data-testid="live-recognition-microphone-source"]').trigger('click');
    await f.wrapper.get('[data-testid="live-recognition-record"]').trigger('click');
    await flushPromises();
    await f.wrapper.get('[data-testid="live-investigation-save"]').trigger('click');
    await flushPromises();
    const saved = downloadedSnapshot();
    expect(saved?.status).toBe('failed');
    expect(saved?.operation.failure).toMatchObject({ status: 'observed', value: { message: 'Microphone permission denied' } });
    expect(saved?.events.map(item => item.event)).toContainEqual(expect.objectContaining({ kind: 'stage', stage: 'input_capture', state: 'failed' }));
    expect(f.recognition.client.transcribe).not.toHaveBeenCalled();
  });

  it.each(['stop', 'discard'] as const)('settles the record when microphone opening is cancelled with %s', async action => {
    vi.mocked(inspectStoredSpeechRecognitionModel).mockResolvedValue(recognitionInspection);
    await using f = await fixture();
    await f.wrapper.setProps({ panel: 'diagnostics', task: 'transcription' });
    await flushPromises();
    await f.wrapper.get('[data-testid="live-diagnostics-load-model"]').trigger('click');
    await flushPromises();
    const opening = Promise.withResolvers<Awaited<ReturnType<typeof f.recognition.capture>>>();
    f.recognition.capture.mockReturnValueOnce(opening.promise);
    await f.wrapper.get('[data-testid="live-recognition-microphone-source"]').trigger('click');
    await f.wrapper.get('[data-testid="live-recognition-record"]').trigger('click');
    await flushPromises();
    await f.wrapper.get(`[data-testid="live-recognition-record-${action}"]`).trigger('click');
    await flushPromises();
    await f.wrapper.get('[data-testid="live-investigation-save"]').trigger('click');
    await flushPromises();
    const saved = downloadedSnapshot();
    expect(saved?.status).toBe('cancelled');
    expect(saved?.operation.failure.status).toBe('unset');
    expect(f.recognition.client.transcribe).not.toHaveBeenCalled();
    opening.resolve({ finish: vi.fn(async () => {}) });
    await flushPromises();
  });

  it('keeps normal dialogue model loading outside investigation recording', async () => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue(speechInspection);
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    expect(vi.mocked(f.speech.client.loadModel).mock.calls.at(-1)?.[0].investigation).toBeUndefined();
    await f.wrapper.setProps({ panel: 'diagnostics' });
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-investigation-save"]').attributes('disabled')).toBeDefined();
  });

  it('records a response source without a model, keeps one microphone, and generates only after an explicit action', async () => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue(speechInspection);
    await using f = await fixture();
    await f.wrapper.setProps({ panel: 'diagnostics', task: 'response' });
    await flushPromises();
    await f.wrapper.get('[data-testid="live-response-microphone-source"]').trigger('click');
    await f.wrapper.get('[data-testid="live-response-record"]').trigger('click');
    await flushPromises();
    f.responseRecording.pcm({ samples: new Float32Array([0.25, -0.25]) });
    expect(f.responseRecording.capture).toHaveBeenCalledOnce();
    expect(f.speech.client.loadModel).not.toHaveBeenCalled();
    await f.wrapper.setProps({ task: 'transcription' });
    expect(f.wrapper.get('[data-testid="live-recognition-microphone-source"]').attributes('disabled')).toBeDefined();
    expect(f.recognition.capture).not.toHaveBeenCalled();
    await f.wrapper.get('[data-testid="live-recording-background-stop"]').trigger('click');
    await flushPromises();
    const recorded = f.responseRecording.recorder.getState().clip?.file;
    expect(recorded).toBeInstanceOf(File);
    expect(f.speech.client.start).not.toHaveBeenCalled();
    await f.wrapper.get('[data-testid="live-recognition-microphone-source"]').trigger('click');
    expect(f.wrapper.find('[data-testid="live-recognition-recording-replay"]').exists()).toBe(true);
    await f.wrapper.setProps({ task: 'response' });
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-response-recording-download"]').attributes('download')).toMatch(/^naidan-response-.*-input\.wav$/);
    await f.wrapper.get('[data-testid="live-diagnostics-load-model"]').trigger('click');
    await flushPromises();
    expect(f.speech.client.start).not.toHaveBeenCalled();
    await f.wrapper.get('[data-testid="live-diagnostics-generate"]').trigger('click');
    await flushPromises();
    expect(f.speech.decodeFile.mock.calls.at(-1)?.[0].file).toBe(recorded);
    expect(f.speech.client.loadModel).toHaveBeenCalledOnce();
    expect(f.recognition.client.transcribe).not.toHaveBeenCalled();
    await f.wrapper.get('[data-testid="live-response-record-discard"]').trigger('click');
    await flushPromises();
    expect(f.wrapper.find('[data-testid="live-response-recording-replay"]').exists()).toBe(false);
    await f.wrapper.get('[data-testid="live-response-file-source"]').trigger('click');
    expect(f.wrapper.find('[data-testid="live-diagnostics-input-name"]').exists()).toBe(false);
  });

  it('saves a load checkpoint and an explicit cancellation before the model file is available', async () => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue(speechInspection);
    const opening = Promise.withResolvers<File>();
    vi.mocked(openStoredSpeechModel).mockReturnValue(opening.promise);
    await using f = await fixture();
    await f.wrapper.setProps({ panel: 'diagnostics' });
    await flushPromises();
    await f.wrapper.get('[data-testid="live-diagnostics-load-model"]').trigger('click');
    await flushPromises();
    await f.wrapper.get('[data-testid="live-investigation-save"]').trigger('click');
    await flushPromises();
    const pending = downloadedSnapshot();
    expect(pending?.status).toBe('in_progress');
    expect(pending?.finishedAt).toBeUndefined();
    expect(pending?.operation.source.kind).toBe('unset');
    expect(pending?.events.map(item => item.event)).toContainEqual(expect.objectContaining({ kind: 'stage', stage: 'app_load_checking_model' }));
    await f.wrapper.get('[data-testid="live-diagnostics-cancel-model"]').trigger('click');
    await flushPromises();
    await f.wrapper.get('[data-testid="live-investigation-save"]').trigger('click');
    await flushPromises();
    const cancelled = downloadedSnapshot();
    expect(cancelled?.id).toBe(pending?.id);
    expect(cancelled?.status).toBe('cancelled');
    opening.resolve(new File(['late'], 'late.gguf'));
    await flushPromises();
    expect(f.speech.client.loadModel).not.toHaveBeenCalled();
  });

  it('keeps model-load observations and native output audio in the first response ZIP, then creates a new record for a rerun', async () => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue(speechInspection);
    await using f = await fixture();
    await f.wrapper.setProps({ panel: 'diagnostics' });
    await flushPromises();
    await f.wrapper.get('[data-testid="live-diagnostics-load-model"]').trigger('click');
    await flushPromises();
    const loading = vi.mocked(f.speech.client.loadModel).mock.calls.at(-1)?.[0].investigation;
    expect(loading).toBeDefined();
    await f.wrapper.get('[data-testid="live-investigation-save"]').trigger('click');
    await flushPromises();
    expect(downloadedSnapshot()?.status).toBe('completed');
    vi.mocked(f.speech.client.start).mockImplementation(async ({ investigation }) => {
      if (investigation) {
        f.speech.observe({ context: investigation, event: { kind: 'native_log', level: 'info', message: 'native test log' } });
      }
      f.speech.change({ state: { phase: 'running' } });
      f.speech.frame({ samples: new Float32Array(3200).fill(0.25), text: 'Response text' });
    });
    const file = new File(['audio'], 'source.wav', { type: 'audio/wav' });
    await f.wrapper.get('[data-testid="live-diagnostics-input"]').trigger('drop', { dataTransfer: { files: [file], types: ['Files'] } });
    await flushPromises();
    await f.wrapper.get('[data-testid="live-diagnostics-generate"]').trigger('click');
    await flushPromises();
    expect(vi.mocked(f.speech.client.start).mock.calls.at(-1)?.[0].investigation).not.toEqual(loading);
    await f.wrapper.get('[data-testid="live-investigation-save"]').trigger('click');
    await flushPromises();
    const first = downloadedSnapshot();
    expect(first?.operation.failure.status).toBe('unset');
    expect(first?.status).toBe('completed');
    expect(first?.operation.result.text).toBe('Response text');
    expect(first?.events.map(item => item.event)).toContainEqual(expect.objectContaining({ kind: 'native_log', message: 'native test log' }));
    const firstCollection = vi.mocked(downloadSpeechInvestigation).mock.calls.at(-1)?.[0].collection;
    expect(firstCollection?.load?.events.map(item => item.event)).toContainEqual(expect.objectContaining({ kind: 'stage', stage: 'app_model_load', state: 'completed' }));
    expect(first?.events.map(item => item.event)).not.toContainEqual(expect.objectContaining({ kind: 'stage', stage: 'app_model_load' }));
    expect(first?.audio.output).toMatchObject({ status: 'retained', format: 'wav' });
    expect(first?.audio.input).toMatchObject({ status: 'retained', format: 'wav' });
    await f.wrapper.get('[data-testid="live-diagnostics-generate"]').trigger('click');
    await flushPromises();
    await f.wrapper.get('[data-testid="live-investigation-save"]').trigger('click');
    await flushPromises();
    const rerun = downloadedSnapshot();
    expect(rerun?.id).not.toBe(first?.id);
    expect(rerun?.events.map(item => item.event)).not.toContainEqual(expect.objectContaining({ kind: 'stage', stage: 'app_model_load', state: 'completed' }));
    expect(f.speech.client.loadModel).toHaveBeenCalledOnce();
  });

  it('records without a model and keeps a reusable WAV after stopping from another task', async () => {
    await using f = await fixture();
    await f.wrapper.setProps({ panel: 'diagnostics', task: 'transcription' });
    await flushPromises();
    await f.wrapper.get('[data-testid="live-recognition-microphone-source"]').trigger('click');
    await f.wrapper.get('[data-testid="live-recognition-record"]').trigger('click');
    await flushPromises();
    expect(f.recognition.capture).toHaveBeenCalledOnce();
    await f.wrapper.get('[data-testid="live-open-settings"]').trigger('click');
    await flushPromises();
    expect(f.page.get('[data-testid="live-start"]').attributes('disabled')).toBeDefined();
    await f.page.get('[data-testid="live-settings-close"]').trigger('click');
    f.recognition.pcm({ samples: new Float32Array([0.25, -0.25]) });
    await f.wrapper.get('[data-testid="live-diagnostics-response-task"]').trigger('click');
    expect(f.wrapper.emitted('investigationTask')?.at(-1)).toEqual(['response']);
    await f.wrapper.setProps({ task: 'response' });
    expect(f.recognition.recorder.getState().phase).toBe('recording');
    await f.wrapper.get('[data-testid="live-recording-background-stop"]').trigger('click');
    await flushPromises();
    expect(f.recognition.recorder.getState().phase).toBe('ready');
    expect(f.recognition.client.transcribe).not.toHaveBeenCalled();
    expect(f.wrapper.get('[data-testid="live-diagnostics-input-name"]').text()).toMatch(/^naidan-recording-.*\.wav$/);
    await f.wrapper.setProps({ task: 'transcription' });
    expect(f.wrapper.get('[data-testid="live-recognition-recording-download"]').attributes('download')).toMatch(/^naidan-transcription-.*-input\.wav$/);
    expect(f.wrapper.find('[data-testid="live-recognition-recording-replay"]').exists()).toBe(true);
    await f.recognition.recorder.discard();
    await flushPromises();
    expect(f.wrapper.find('[data-testid="live-recognition-recording-replay"]').exists()).toBe(true);
    await f.wrapper.get('[data-testid="live-recognition-record-discard"]').trigger('click');
    await flushPromises();
    expect(f.wrapper.find('[data-testid="live-recognition-recording-replay"]').exists()).toBe(false);
    await f.wrapper.setProps({ task: 'response' });
    expect(f.wrapper.find('[data-testid="live-diagnostics-input-name"]').exists()).toBe(false);
    expect(f.speech.client.loadModel).not.toHaveBeenCalled();
    expect(f.runLiveSession).not.toHaveBeenCalled();
  });

  it('stops microphone capture into the loaded recognizer without decoding and can reuse the same audio file', async () => {
    vi.mocked(inspectStoredSpeechRecognitionModel).mockResolvedValue(recognitionInspection);
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    expect(f.wrapper.find('[data-testid="live-speech-controls"]').exists()).toBe(false);
    expect(f.wrapper.find('[data-testid="live-text"]').exists()).toBe(false);
    await f.wrapper.setProps({ panel: 'diagnostics', task: 'transcription' });
    await flushPromises();
    await f.wrapper.get('[data-testid="live-recognition-microphone-source"]').trigger('click');
    await f.wrapper.get('[data-testid="live-recognition-record"]').trigger('click');
    await flushPromises();
    const samples = new Float32Array([0.25, -0.25]);
    f.recognition.pcm({ samples });
    await f.wrapper.get('[data-testid="live-recognition-record-stop"]').trigger('click');
    await flushPromises();
    expect(f.recognition.client.transcribe).toHaveBeenCalledWith({ samples, sampleRate: 16000, language: undefined, investigation: expect.objectContaining({ source: 'investigation' }) });
    expect(f.recognition.decodeFile).not.toHaveBeenCalled();
    expect(f.wrapper.get('[data-testid="live-recognition-text"]').text()).toBe('こんにちは。');
    const sourceName = f.recognition.recorder.getState().clip?.file.name;
    await selectDownloadedModel({ wrapper: f.wrapper, page: f.page, modelId: 'next/model' });
    await f.wrapper.get('[data-testid="live-investigation-save"]').trigger('click');
    await flushPromises();
    const saved = vi.mocked(downloadSpeechInvestigation).mock.calls.at(-1)?.[0];
    expect(saved?.includeInputAudio).toBe('off');
    expect(saved?.includeInputText).toBe('off');
    expect(downloadedSnapshot()?.status).toBe('completed');
    expect(downloadedSnapshot()?.operation.result.text).toBe('こんにちは。');
    expect(downloadedSnapshot()?.operation.model.id).toMatchObject({ status: 'observed', value: 'user/live' });
    expect(downloadedSnapshot()?.operation.source).toMatchObject({ kind: 'recording', name: sourceName });
    await f.wrapper.get('[data-testid="live-recognition-generate"]').trigger('click');
    await flushPromises();
    expect(f.recognition.decodeFile.mock.calls.at(-1)?.[0].file).toHaveProperty('name', sourceName);
    expect(f.recognition.client.loadModel).toHaveBeenCalledOnce();
    expect(f.recognition.client.releaseModel).not.toHaveBeenCalled();
    expect(f.speech.client.start).not.toHaveBeenCalled();
    await f.wrapper.get('[data-testid="live-investigation-clear"]').trigger('click');
    expect(f.wrapper.get('[data-testid="live-investigation-save"]').attributes('disabled')).toBeDefined();
    expect(f.recognition.controller.getState().run?.text).toBe('こんにちは。');
  });

  it('keeps a recognition run alive across task navigation and cancels the actual owner', async () => {
    vi.mocked(inspectStoredSpeechRecognitionModel).mockResolvedValue(recognitionInspection);
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    await f.wrapper.setProps({ panel: 'diagnostics', task: 'transcription' });
    await flushPromises();
    const file = new File(['audio'], 'same.wav', { type: 'audio/wav' });
    await f.wrapper.get('[data-testid="live-diagnostics-input"]').trigger('drop', { dataTransfer: { files: [file], types: ['Files'] } });
    await flushPromises();
    const transcribing = Promise.withResolvers<Awaited<ReturnType<typeof f.recognition.client.transcribe>>>();
    vi.mocked(f.recognition.client.transcribe).mockImplementation(async () => {
      f.recognition.change({ state: { phase: 'recognizing' } });
      return transcribing.promise;
    });
    vi.mocked(f.recognition.client.cancel).mockImplementation(async () => {
      transcribing.resolve({ status: 'cancelled', text: '', languages: [] });
      f.recognition.change({ state: { phase: 'ready' } });
    });
    await f.wrapper.get('[data-testid="live-recognition-generate"]').trigger('click');
    await flushPromises();
    const cancels = vi.mocked(f.recognition.client.cancel).mock.calls.length;
    await f.wrapper.get('[data-testid="live-diagnostics-response-task"]').trigger('click');
    await f.wrapper.setProps({ task: 'response' });
    await flushPromises();
    expect(f.recognition.client.cancel).toHaveBeenCalledTimes(cancels);
    expect(f.recognition.client.releaseModel).not.toHaveBeenCalled();
    expect(f.wrapper.get('[data-testid="live-investigation-background-status"]').text()).toContain(await ensureStrings.liveConversation__transcribing_audio_file());
    await f.wrapper.get('[data-testid="live-investigation-cancel-running"]').trigger('click');
    await flushPromises();
    expect(f.recognition.controller.getState().run?.status).toBe('cancelled');
    expect(f.speech.client.stop).not.toHaveBeenCalled();
    expect(f.wrapper.get('[data-testid="live-diagnostics-input-name"]').text()).toBe(file.name);
  });

  it('awaits each resident release before switching between dialogue and recognition and keeps the source file', async () => {
    vi.mocked(inspectStoredSpeechModel).mockImplementation(async ({ modelId }) => modelId === 'asr/model' ? { kind: 'other' } : speechInspection);
    vi.mocked(inspectStoredSpeechRecognitionModel).mockImplementation(async ({ modelId }) => modelId === 'asr/model' ? recognitionInspection : { kind: 'other' });
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    await f.wrapper.setProps({ panel: 'diagnostics', task: 'transcription' });
    await selectDownloadedModel({ wrapper: f.wrapper, page: f.page, modelId: 'asr/model' });
    const file = new File(['audio'], 'retained.wav', { type: 'audio/wav' });
    await f.wrapper.get('[data-testid="live-diagnostics-input"]').trigger('drop', { dataTransfer: { files: [file], types: ['Files'] } });
    await flushPromises();
    const speechReleased = Promise.withResolvers<void>();
    const recognitionReleased = Promise.withResolvers<void>();
    using _gates = {
      [Symbol.dispose]() {
        speechReleased.resolve();
        recognitionReleased.resolve();
      },
    };
    const releaseSpeech = vi.mocked(f.speech.client.releaseModel).getMockImplementation();
    if (!releaseSpeech) {
      throw new Error('Expected a model release implementation');
    }
    vi.mocked(f.speech.client.releaseModel).mockImplementation(async () => {
      await speechReleased.promise;
      await releaseSpeech();
    });
    await f.wrapper.get('[data-testid="live-diagnostics-load-model"]').trigger('click');
    await flushPromises();
    expect(f.recognition.client.loadModel).not.toHaveBeenCalled();
    speechReleased.resolve();
    await flushPromises();
    expect(f.recognition.client.loadModel).toHaveBeenCalledOnce();
    expect(f.wrapper.get('[data-testid="live-header-model"]').attributes('title')).toBe('asr/model');
    expect(f.wrapper.get('[data-testid="live-diagnostics-input-name"]').text()).toBe(file.name);
    await f.wrapper.setProps({ task: 'response' });
    await flushPromises();
    await f.wrapper.get('[data-testid="live-diagnostics-model"] [data-testid="model-selector-trigger"]').trigger('click');
    await f.page.get('[data-testid="model-selector-option"][title="user/live"]').trigger('click');
    await flushPromises();
    const releaseRecognition = vi.mocked(f.recognition.client.releaseModel).getMockImplementation();
    if (!releaseRecognition) {
      throw new Error('Expected a recognition release implementation');
    }
    vi.mocked(f.recognition.client.releaseModel).mockImplementation(async () => {
      await recognitionReleased.promise;
      await releaseRecognition();
    });
    await f.wrapper.get('[data-testid="live-diagnostics-load-model"]').trigger('click');
    await flushPromises();
    expect(f.speech.client.loadModel).toHaveBeenCalledOnce();
    recognitionReleased.resolve();
    await flushPromises();
    expect(f.speech.client.loadModel).toHaveBeenCalledTimes(2);
    expect(f.wrapper.get('[data-testid="live-header-model"]').attributes('title')).toBe('user/live');
    expect(f.wrapper.get('[data-testid="live-diagnostics-input-name"]').text()).toBe(file.name);
    expect(f.runLiveSession).not.toHaveBeenCalled();
  });

  it.each(['response', 'transcription'] as const)('prepares input files and settings throughout %s model loading without cancelling its record', async task => {
    const opening = Promise.withResolvers<File>();
    if (task === 'response') {
      vi.mocked(inspectStoredSpeechModel).mockResolvedValue(speechInspection);
      vi.mocked(openStoredSpeechModel).mockReturnValueOnce(opening.promise);
    } else {
      vi.mocked(inspectStoredSpeechRecognitionModel).mockResolvedValue(recognitionInspection);
      vi.mocked(openStoredSpeechRecognitionModel).mockReturnValueOnce(opening.promise);
    }
    await using f = await fixture();
    const loading = Promise.withResolvers<void>();
    if (task === 'response') {
      const load = vi.mocked(f.speech.client.loadModel).getMockImplementation();
      if (!load) {
        throw new Error('Expected speech load implementation');
      }
      vi.mocked(f.speech.client.loadModel).mockImplementation(async args => {
        f.speech.change({ state: { phase: 'loading_model' } });
        await loading.promise;
        await load(args);
      });
    } else {
      const load = vi.mocked(f.recognition.client.loadModel).getMockImplementation();
      if (!load) {
        throw new Error('Expected recognition load implementation');
      }
      vi.mocked(f.recognition.client.loadModel).mockImplementation(async args => {
        f.recognition.change({ state: { phase: 'loading_model' } });
        await loading.promise;
        await load(args);
      });
    }
    await f.wrapper.setProps({ panel: 'diagnostics', task });
    await flushPromises();
    await f.wrapper.get('[data-testid="live-diagnostics-load-model"]').trigger('click');
    await flushPromises();
    await f.wrapper.get('[data-testid="live-investigation-save"]').trigger('click');
    await flushPromises();
    const loadId = downloadedSnapshot()?.id;
    const first = new File(['first'], 'first-loading.wav', { type: 'audio/wav' });
    const picker = f.wrapper.get<HTMLInputElement>('[data-testid="live-diagnostics-file"]');
    expect(picker.attributes('disabled')).toBeUndefined();
    Object.defineProperty(picker.element, 'files', { configurable: true, value: [first] });
    await picker.trigger('change');
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-diagnostics-input-name"]').text()).toBe(first.name);
    await f.wrapper.get('[data-testid="live-diagnostics-clear"]').trigger('click');
    await flushPromises();
    if (task === 'response') {
      expect(f.wrapper.get('[data-testid="live-diagnostics-seed"]').attributes('disabled')).toBeUndefined();
      await f.wrapper.get('[data-testid="live-diagnostics-seed"]').setValue('7');
      await f.wrapper.get('[data-testid="live-diagnostics-instructions"]').setValue('Prepared during loading');
      await f.wrapper.get('[data-testid="live-diagnostics-input-level-gain-2"]').setValue(true);
    }
    opening.resolve(new File(['model'], 'selected.gguf'));
    await flushPromises();
    const cancels = vi.mocked(f.recognition.client.cancel).mock.calls.length;
    const root = f.wrapper.get('[data-testid="live-conversation-page"]');
    const transfer = { types: ['Files'], dropEffect: 'none' };
    await root.trigger('dragenter', { dataTransfer: transfer });
    await root.trigger('dragover', { dataTransfer: transfer });
    expect(transfer.dropEffect).toBe('copy');
    expect(f.wrapper.find('[data-testid="live-drop-overlay"]').exists()).toBe(true);
    const second = new File(['second'], 'second-loading.wav', { type: 'audio/wav' });
    await root.trigger('drop', { dataTransfer: { types: ['Files'], files: [second] } });
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-diagnostics-input-name"]').text()).toBe(second.name);
    await f.wrapper.get('[data-testid="live-diagnostics-clear"]').trigger('click');
    await flushPromises();
    const final = new File(['final'], 'final-loading.wav', { type: 'audio/wav' });
    await f.wrapper.get('[data-testid="live-diagnostics-input"]').trigger('drop', { dataTransfer: { types: ['Files'], files: [final] } });
    await flushPromises();
    expect(f.recognition.client.cancel).toHaveBeenCalledTimes(cancels);
    await f.wrapper.get('[data-testid="live-investigation-save"]').trigger('click');
    await flushPromises();
    expect(downloadedSnapshot()?.id).toBe(loadId);
    expect(downloadedSnapshot()?.status).toBe('in_progress');
    loading.resolve();
    await flushPromises();
    await f.wrapper.get(task === 'response' ? '[data-testid="live-diagnostics-generate"]' : '[data-testid="live-recognition-generate"]').trigger('click');
    await flushPromises();
    await f.wrapper.get('[data-testid="live-investigation-save"]').trigger('click');
    await flushPromises();
    const saved = vi.mocked(downloadSpeechInvestigation).mock.calls.at(-1)?.[0].collection;
    expect(saved?.load?.id).toBe(loadId);
    expect(saved?.load?.status).toBe('completed');
    expect(saved?.plan.source).toMatchObject({ name: final.name });
    if (task === 'response') {
      expect(f.speech.decodeFile.mock.calls.at(-1)?.[0].file).toBe(final);
      expect(saved?.plan.requested.seed).toMatchObject({ status: 'observed', value: 7 });
      expect(saved?.plan.trials).toHaveLength(2);
      expect(f.speech.client.loadModel).toHaveBeenCalledOnce();
    } else {
      expect(f.recognition.decodeFile.mock.calls.at(-1)?.[0].file).toBe(final);
      expect(f.recognition.client.loadModel).toHaveBeenCalledOnce();
    }
  });

  it('keeps microphone preparation made during model File retrieval through load completion', async () => {
    vi.mocked(inspectStoredSpeechRecognitionModel).mockResolvedValue(recognitionInspection);
    const opening = Promise.withResolvers<File>();
    vi.mocked(openStoredSpeechRecognitionModel).mockReturnValueOnce(opening.promise);
    await using f = await fixture();
    await f.wrapper.setProps({ panel: 'diagnostics', task: 'transcription' });
    await flushPromises();
    await f.wrapper.get('[data-testid="live-diagnostics-load-model"]').trigger('click');
    await flushPromises();
    await f.wrapper.get('[data-testid="live-recognition-microphone-source"]').trigger('click');
    await f.wrapper.get('[data-testid="live-recognition-record"]').trigger('click');
    await flushPromises();
    expect(f.recognition.capture).toHaveBeenCalledOnce();
    f.recognition.pcm({ samples: new Float32Array([0.25, -0.25]) });
    opening.resolve(new File(['model'], 'selected.gguf'));
    await flushPromises();
    expect(f.recognition.recorder.getState().phase).toBe('recording');
    expect(f.recognition.client.loadModel).toHaveBeenCalledOnce();
    await f.wrapper.get('[data-testid="live-recognition-record-stop"]').trigger('click');
    await flushPromises();
    expect(f.recognition.client.transcribe).toHaveBeenCalledOnce();
    expect(f.wrapper.find('[data-testid="live-recognition-recording-replay"]').exists()).toBe(true);
    await f.wrapper.get('[data-testid="live-investigation-save"]').trigger('click');
    await flushPromises();
    const saved = vi.mocked(downloadSpeechInvestigation).mock.calls.at(-1)?.[0].collection;
    expect(saved?.load?.status).toBe('completed');
    expect(saved?.trials).toHaveLength(1);
  });

  it.each(['diagnostics', 'conversation'] as const)('attaches only an observed matching ASR load from the %s surface', async surface => {
    vi.mocked(inspectStoredSpeechRecognitionModel).mockResolvedValue(recognitionInspection);
    await using f = await fixture();
    if (surface === 'diagnostics') {
      await f.wrapper.setProps({ panel: 'diagnostics', task: 'transcription' });
      await flushPromises();
      await f.wrapper.get('[data-testid="live-diagnostics-load-model"]').trigger('click');
    } else {
      await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    }
    await flushPromises();
    await f.wrapper.setProps({ panel: 'diagnostics', task: 'transcription' });
    await flushPromises();
    const file = new File(['audio'], 'transcription-load.wav', { type: 'audio/wav' });
    await f.wrapper.get('[data-testid="live-diagnostics-input"]').trigger('drop', { dataTransfer: { files: [file], types: ['Files'] } });
    await flushPromises();
    await f.wrapper.get('[data-testid="live-recognition-generate"]').trigger('click');
    await flushPromises();
    await f.wrapper.get('[data-testid="live-investigation-save"]').trigger('click');
    await flushPromises();
    const saved = vi.mocked(downloadSpeechInvestigation).mock.calls.at(-1)?.[0].collection;
    if (surface === 'diagnostics') {
      expect(saved?.load?.status).toBe('completed');
      expect(saved?.load?.operation.model.id).toMatchObject({ status: 'observed', value: 'user/live' });
    } else {
      expect(saved?.load).toBeUndefined();
    }
    expect(saved?.trials).toHaveLength(1);
    expect(downloadedSnapshot()?.operation.result.text).toBe('こんにちは。');
    expect(f.recognition.client.loadModel).toHaveBeenCalledOnce();
    expect(f.recognition.client.releaseModel).not.toHaveBeenCalled();
    const replacement = new File(['replacement'], 'replacement.wav', { type: 'audio/wav' });
    await f.wrapper.get('[data-testid="live-diagnostics-input"]').trigger('drop', { dataTransfer: { files: [replacement], types: ['Files'] } });
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-investigation-save"]').attributes('disabled')).toBeDefined();
    expect(f.recognition.controller.getState().run).toBeUndefined();
    expect(f.recognition.controller.getState().runtime.model).toBeDefined();
    expect(f.recognition.client.releaseModel).not.toHaveBeenCalled();
  });

  it('invalidates old comparison audio and exports on source changes and explicit model loads while retaining selection-only behavior', async () => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue(speechInspection);
    await using f = await fixture();
    await f.wrapper.setProps({ panel: 'diagnostics' });
    await flushPromises();
    await f.wrapper.get('[data-testid="live-diagnostics-load-model"]').trigger('click');
    await flushPromises();
    const first = new File(['first'], 'first.wav', { type: 'audio/wav' });
    await f.wrapper.get('[data-testid="live-diagnostics-input"]').trigger('drop', { dataTransfer: { files: [first], types: ['Files'] } });
    await flushPromises();
    await f.wrapper.get('[data-testid="live-diagnostics-generate"]').trigger('click');
    await flushPromises();
    const firstUrl = f.wrapper.get('[data-testid="live-diagnostics-download-input"]').attributes('href');
    const firstRun = f.speech.controller.getState().fileRun;
    if (!firstRun) {
      throw new Error('Expected first file run');
    }
    const second = new File(['second'], 'second.wav', { type: 'audio/wav' });
    await f.wrapper.get('[data-testid="live-diagnostics-input"]').trigger('drop', { dataTransfer: { files: [second], types: ['Files'] } });
    await flushPromises();
    expect(f.wrapper.findAll('[data-testid="live-response-result"]')).toHaveLength(0);
    expect(f.wrapper.get('[data-testid="live-investigation-save"]').attributes('disabled')).toBeDefined();
    expect(f.speech.controller.getState().fileRun).toBeUndefined();
    expect(f.speech.controller.getFileRunAudio({ id: firstRun.id, role: 'input' })).toBeUndefined();
    expect(f.revokeUrl).toHaveBeenCalledWith(firstUrl);
    expect(f.speech.client.releaseModel).not.toHaveBeenCalled();
    await f.wrapper.get('[data-testid="live-diagnostics-generate"]').trigger('click');
    await flushPromises();
    const secondUrl = f.wrapper.get('[data-testid="live-diagnostics-download-input"]').attributes('href');
    await selectDownloadedModel({ wrapper: f.wrapper, page: f.page, modelId: 'speech/next' });
    expect(f.wrapper.findAll('[data-testid="live-response-result"]')).toHaveLength(1);
    expect(f.revokeUrl).not.toHaveBeenCalledWith(secondUrl);
    expect(f.speech.client.loadModel).toHaveBeenCalledOnce();
    await f.wrapper.get('[data-testid="live-diagnostics-load-model"]').trigger('click');
    await flushPromises();
    expect(f.wrapper.findAll('[data-testid="live-response-result"]')).toHaveLength(0);
    expect(f.speech.controller.getState().fileRun).toBeUndefined();
    expect(f.revokeUrl).toHaveBeenCalledWith(secondUrl);
    await f.wrapper.get('[data-testid="live-investigation-save"]').trigger('click');
    await flushPromises();
    expect(vi.mocked(downloadSpeechInvestigation).mock.calls.at(-1)?.[0].collection.load?.operation.model.id).toMatchObject({ status: 'observed', value: 'speech/next' });
  });

  it('adjusts only normal speech microphone input and measures it only while the panel is open', async () => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue(speechInspection);
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    expect(f.speech.controller.getState().inputLevel).toMatchObject({ gain: 1, observation: 'off', window: undefined });
    const details = f.wrapper.get<HTMLDetailsElement>('[data-testid="live-speech-input-level"]');
    details.element.open = true;
    await details.trigger('toggle');
    expect(f.speech.controller.getState().inputLevel.observation).toBe('on');
    expect(f.speech.capture).not.toHaveBeenCalled();
    await f.wrapper.get('[data-testid="live-speech-input-gain"]').trigger('click');
    await f.page.get('[data-testid="settings-select-option-2"]').trigger('click');
    await flushPromises();
    expect(f.speech.controller.getState().inputLevel.gain).toBe(2);
    await f.wrapper.get('[data-testid="live-speech-start"]').trigger('click');
    await flushPromises();
    f.speech.pcm({ samples: new Float32Array(12000).fill(0.25) });
    await flushPromises();
    expect(vi.mocked(f.speech.client.push).mock.calls.at(-1)?.[0].samples[0]).toBe(0.5);
    expect(f.speech.controller.getState().inputLevel.window).toMatchObject({ before: { peak: 0.25 }, after: { peak: 0.5 } });
    await f.wrapper.get('[data-testid="live-speech-mute-microphone"]').trigger('click');
    f.speech.pcm({ samples: new Float32Array(12000).fill(0.25) });
    await flushPromises();
    expect(f.speech.controller.getState().inputLevel.window).toMatchObject({ before: { peak: 0 }, after: { peak: 0 } });
    expect(f.wrapper.get('[data-testid="live-speech-input-muted"]').text()).toBe(await ensureStrings.liveConversation__microphone_muted());
    details.element.open = false;
    await details.trigger('toggle');
    expect(f.speech.controller.getState().inputLevel).toMatchObject({ gain: 2, observation: 'off', window: undefined });
    details.element.open = true;
    await details.trigger('toggle');
    await f.wrapper.setProps({ panel: 'diagnostics' });
    await flushPromises();
    expect(f.speech.controller.getState().inputLevel).toMatchObject({ gain: 2, observation: 'off', window: undefined });
    expect(f.wrapper.find('[data-testid="live-speech-input-level"]').exists()).toBe(false);
    expect(f.wrapper.get<HTMLInputElement>('[data-testid="live-diagnostics-input-level-gain-1"]').element.checked).toBe(true);
    expect(f.speech.client.loadModel).toHaveBeenCalledOnce();
  });

  it('cancels a comparison during the current condition, retains its partial result, and leaves later conditions unrun', async () => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue(speechInspection);
    await using f = await fixture();
    await f.wrapper.setProps({ panel: 'diagnostics' });
    await flushPromises();
    await f.wrapper.get('[data-testid="live-diagnostics-load-model"]').trigger('click');
    await flushPromises();
    const file = new File(['audio'], 'cancel-comparison.wav', { type: 'audio/wav' });
    await f.wrapper.get('[data-testid="live-diagnostics-input"]').trigger('drop', { dataTransfer: { files: [file], types: ['Files'] } });
    await flushPromises();
    await f.wrapper.get('[data-testid="live-diagnostics-input-level-gain-4"]').setValue(true);
    await f.wrapper.get('[data-testid="live-diagnostics-input-level-gain-8"]').setValue(true);
    const decoding = Promise.withResolvers<Float32Array<ArrayBuffer>>();
    f.speech.decodeFile.mockResolvedValueOnce(new Float32Array([0.5])).mockReturnValueOnce(decoding.promise);
    await f.wrapper.get('[data-testid="live-diagnostics-generate"]').trigger('click');
    await flushPromises();
    expect(f.speech.decodeFile).toHaveBeenCalledTimes(2);
    expect(f.wrapper.get('[data-testid="live-diagnostics-input-level-gain-4"]').attributes('disabled')).toBeDefined();
    const recognitionCancels = vi.mocked(f.recognition.client.cancel).mock.calls.length;
    await f.wrapper.setProps({ task: 'transcription' });
    await f.wrapper.get('[data-testid="live-investigation-cancel-running"]').trigger('click');
    await flushPromises();
    await f.wrapper.setProps({ task: 'response' });
    expect(f.wrapper.findAll('[data-testid="live-response-result"]')).toHaveLength(2);
    expect(f.wrapper.get('[data-testid="live-response-comparison-progress"]').text()).toBe(await ensureStrings.liveConversation__response_condition_progress({ completed: 2, total: 3 }));
    expect(f.wrapper.get('[data-testid="live-response-comparison-not-run"]').text()).toBe(await ensureStrings.liveConversation__remaining_conditions_not_run({ count: 1 }));
    expect(f.wrapper.find('[data-testid="live-diagnostics-audio-retention-limit"]').exists()).toBe(false);
    await f.wrapper.get('[data-testid="live-investigation-save"]').trigger('click');
    await flushPromises();
    const saved = vi.mocked(downloadSpeechInvestigation).mock.calls.at(-1)?.[0].collection;
    expect(saved?.status).toBe('cancelled');
    expect(saved?.trials.map(trial => trial.status)).toEqual(['completed', 'partial', 'not_run']);
    expect(saved?.plan.trials).toHaveLength(3);
    expect(f.speech.client.start).toHaveBeenCalledOnce();
    expect(f.speech.client.loadModel).toHaveBeenCalledOnce();
    expect(f.recognition.client.cancel).toHaveBeenCalledTimes(recognitionCancels);
    decoding.resolve(new Float32Array([0.25]));
    await flushPromises();
    expect(f.speech.client.start).toHaveBeenCalledOnce();
    expect(f.speech.decodeFile.mock.calls.every(call => call[0].file === file)).toBe(true);
  });

  it('generates selected multipliers and peak matching in order with one model and independent result audio', async () => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue(speechInspection);
    await using f = await fixture();
    await f.wrapper.setProps({ panel: 'diagnostics' });
    await flushPromises();
    await f.wrapper.get('[data-testid="live-diagnostics-load-model"]').trigger('click');
    await flushPromises();
    const file = new File(['original audio'], 'peak.wav', { type: 'audio/wav' });
    await f.wrapper.get('[data-testid="live-diagnostics-input"]').trigger('drop', { dataTransfer: { files: [file], types: ['Files'] } });
    await flushPromises();
    await f.wrapper.get('[data-testid="live-diagnostics-input-level-gain-4"]').setValue(true);
    await f.wrapper.get('[data-testid="live-diagnostics-input-level-peak-0.8"]').setValue(true);
    let generated = 0;
    vi.mocked(f.speech.client.start).mockImplementation(async () => {
      generated++;
      f.speech.change({ state: { phase: 'running' } });
      f.speech.frame({ text: `Response ${generated}`, samples: new Float32Array(3200).fill(0.25) });
    });
    const run = vi.spyOn(f.speech.controller, 'runFile');
    expect(f.speech.client.start).not.toHaveBeenCalled();
    await f.wrapper.get('[data-testid="live-diagnostics-generate"]').trigger('click');
    await flushPromises();
    expect(run.mock.calls.map(call => call[0].inputLevel)).toEqual([{ kind: 'gain', gain: 1 }, { kind: 'gain', gain: 4 }, { kind: 'peak', targetPeak: 0.8 }]);
    expect(run.mock.calls.every(call => call[0].file === file && call[0].seed === 0 && call[0].language === 'en' && call[0].maxSeconds === 120 && call[0].inputPacing === 'fast')).toBe(true);
    expect(f.speech.controller.getState().fileRun?.inputLevel).toMatchObject({ requested: { kind: 'peak', targetPeak: 0.8 }, appliedGain: 1.6, clippedSamples: 0 });
    const results = f.wrapper.findAll('[data-testid="live-response-result"]');
    expect(results).toHaveLength(3);
    expect(results.map(result => result.get('[data-testid="live-diagnostics-text"]').text())).toEqual(['Response 1', 'Response 2', 'Response 3']);
    const urls = results.map(result => result.get('[data-testid="live-diagnostics-output-replay"]').attributes('src'));
    expect(new Set(urls).size).toBe(3);
    for (const url of urls) {
      expect(f.revokeUrl).not.toHaveBeenCalledWith(url);
    }
    expect(f.wrapper.findAll('[data-testid="live-diagnostics-settings"]')).toHaveLength(1);
    expect(f.wrapper.get('[data-testid="live-response-comparison-progress"]').text()).toBe(await ensureStrings.liveConversation__response_condition_progress({ completed: 3, total: 3 }));
    await f.wrapper.get('[data-testid="live-diagnostics-input-level-gain-1"]').setValue(false);
    expect(f.wrapper.findAll('[data-testid="live-response-result"]')).toHaveLength(3);
    await f.wrapper.get('[data-testid="live-investigation-save"]').trigger('click');
    await flushPromises();
    const saved = vi.mocked(downloadSpeechInvestigation).mock.calls.at(-1)?.[0].collection;
    expect(saved?.plan.trials).toHaveLength(3);
    expect(saved?.trials).toHaveLength(3);
    expect(downloadedSnapshot()?.operation.processing).toMatchObject({ status: 'observed', value: { inputLevel: { requested: { kind: 'peak', targetPeak: 0.8 }, appliedGain: 1.6 } } });
    expect(f.speech.client.loadModel).toHaveBeenCalledOnce();
    expect(f.speech.client.releaseModel).not.toHaveBeenCalled();
    expect(f.recognition.client.transcribe).not.toHaveBeenCalled();
    await f.wrapper.get('[data-testid="live-investigation-clear"]').trigger('click');
    await flushPromises();
    expect(f.wrapper.findAll('[data-testid="live-response-result"]')).toHaveLength(0);
    for (const url of urls) {
      expect(f.revokeUrl).toHaveBeenCalledWith(url);
    }
  });

  it('applies an explicit input volume on generation while retaining the model, source file, and previous result snapshot', async () => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue(speechInspection);
    await using f = await fixture();
    await f.wrapper.setProps({ panel: 'diagnostics' });
    await flushPromises();
    expect(f.wrapper.get<HTMLInputElement>('[data-testid="live-diagnostics-input-level-gain-1"]').element.checked).toBe(true);
    await f.wrapper.get('[data-testid="live-diagnostics-load-model"]').trigger('click');
    await flushPromises();
    const file = new File(['original audio'], 'volume.wav', { type: 'audio/wav' });
    await f.wrapper.get('[data-testid="live-diagnostics-input"]').trigger('drop', { dataTransfer: { files: [file], types: ['Files'] } });
    await flushPromises();
    await f.wrapper.get('[data-testid="live-diagnostics-input-level-gain-1"]').setValue(false);
    await f.wrapper.get('[data-testid="live-diagnostics-input-level-gain-4"]').setValue(true);
    await flushPromises();
    expect(f.speech.client.start).not.toHaveBeenCalled();
    expect(f.speech.client.loadModel).toHaveBeenCalledOnce();
    await f.wrapper.get('[data-testid="live-diagnostics-generate"]').trigger('click');
    await flushPromises();
    expect(f.speech.decodeFile.mock.calls.at(-1)?.[0].file).toBe(file);
    expect(f.speech.controller.getState().fileRun?.inputLevel).toMatchObject({ requested: { kind: 'gain', gain: 4 }, appliedGain: 4, before: { peak: 0.5 }, after: { peak: 1 }, clippedSamples: 1 });
    expect(vi.mocked(f.speech.client.push).mock.calls[0]?.[0].samples[0]).toBe(1);
    expect(f.wrapper.get('[data-testid="live-diagnostics-input-clipped"]').text()).toBe(await ensureStrings.liveConversation__input_volume_clipped({ count: 1 }));
    await f.wrapper.get('[data-testid="live-diagnostics-input-level-gain-4"]').setValue(false);
    await f.wrapper.get('[data-testid="live-diagnostics-input-level-gain-2"]').setValue(true);
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-diagnostics-result-gain"]').text()).toContain('4×');
    await f.wrapper.get('[data-testid="live-investigation-save"]').trigger('click');
    await flushPromises();
    const saved = downloadedSnapshot();
    expect(saved?.operation.processing).toMatchObject({ status: 'observed', value: { inputLevel: { requested: { kind: 'gain', gain: 4 }, appliedGain: 4, clippedSamples: 1 } } });
    await f.wrapper.get('[data-testid="live-diagnostics-generate"]').trigger('click');
    await flushPromises();
    expect(f.speech.decodeFile.mock.calls.at(-1)?.[0].file).toBe(file);
    expect(f.speech.controller.getState().fileRun?.inputLevel).toMatchObject({ requested: { kind: 'gain', gain: 2 }, appliedGain: 2, clippedSamples: 0 });
    expect(f.wrapper.find('[data-testid="live-diagnostics-input-clipped"]').exists()).toBe(false);
    expect(f.speech.client.loadModel).toHaveBeenCalledOnce();
    expect(f.speech.client.releaseModel).not.toHaveBeenCalled();
    expect(f.recognition.client.transcribe).not.toHaveBeenCalled();
  });

  it('defaults to fast file input and changes pacing without loading or generating automatically', async () => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue(speechInspection);
    await using f = await fixture();
    await f.wrapper.setProps({ panel: 'diagnostics' });
    await flushPromises();
    const pacing = f.wrapper.get('[data-testid="live-diagnostics-pacing"]');
    expect(pacing.text()).toBe(await ensureStrings.liveConversation__as_fast_as_possible());
    expect(f.wrapper.findAll('[role="tab"]')).toHaveLength(3);
    const run = vi.spyOn(f.speech.controller, 'runFile').mockResolvedValue(undefined);
    await pacing.trigger('click');
    await f.page.get('[data-testid="settings-select-option-real_time"]').trigger('click');
    await flushPromises();
    expect(pacing.text()).toBe(await ensureStrings.liveConversation__real_time_pace());
    expect(f.wrapper.get('[data-testid="live-diagnostics-pacing-help"]').text()).toBe(await ensureStrings.liveConversation__real_time_input_pacing_help());
    expect(f.speech.client.loadModel).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    await f.wrapper.get('[data-testid="live-diagnostics-load-model"]').trigger('click');
    await flushPromises();
    const file = new File(['audio'], 'paced.wav', { type: 'audio/wav' });
    await f.wrapper.get('[data-testid="live-diagnostics-input"]').trigger('drop', { dataTransfer: { files: [file], types: ['Files'] } });
    await flushPromises();
    expect(run).not.toHaveBeenCalled();
    await f.wrapper.get('[data-testid="live-diagnostics-generate"]').trigger('click');
    await flushPromises();
    expect(run).toHaveBeenCalledWith({ file, maxSeconds: 120, language: 'en', persona: undefined, name: undefined, tailSeconds: 5, seed: 0, inputPacing: 'real_time', inputLevel: { kind: 'gain', gain: 1 }, maximumRetainedAudioBytes: 64 * 1024 * 1024 - file.size, investigation: expect.objectContaining({ context: expect.objectContaining({ source: 'investigation' }), observer: expect.any(Function) }) });
    await pacing.trigger('click');
    await f.page.get('[data-testid="settings-select-option-fast"]').trigger('click');
    await flushPromises();
    expect(run).toHaveBeenCalledOnce();
    await f.wrapper.get('[data-testid="live-diagnostics-generate"]').trigger('click');
    await flushPromises();
    expect(run).toHaveBeenLastCalledWith({ file, maxSeconds: 120, language: 'en', persona: undefined, name: undefined, tailSeconds: 5, seed: 0, inputPacing: 'fast', inputLevel: { kind: 'gain', gain: 1 }, maximumRetainedAudioBytes: 64 * 1024 * 1024 - file.size, investigation: expect.objectContaining({ context: expect.objectContaining({ source: 'investigation' }), observer: expect.any(Function) }) });
    expect(f.speech.client.loadModel).toHaveBeenCalledOnce();
    expect(f.speech.client.releaseModel).not.toHaveBeenCalled();
    expect(f.speech.capture).not.toHaveBeenCalled();
  });

  it('cancels a real-time file run while waiting for its first input deadline and keeps the model', async () => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue(speechInspection);
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    await f.wrapper.setProps({ panel: 'diagnostics' });
    await flushPromises();
    const file = new File(['audio'], 'waiting.wav', { type: 'audio/wav' });
    await f.wrapper.get('[data-testid="live-diagnostics-input"]').trigger('drop', { dataTransfer: { files: [file], types: ['Files'] } });
    await flushPromises();
    await f.wrapper.get('[data-testid="live-diagnostics-pacing"]').trigger('click');
    await f.page.get('[data-testid="settings-select-option-real_time"]').trigger('click');
    await flushPromises();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    using _timers = {
      [Symbol.dispose]() {
        vi.useRealTimers();
      },
    };
    await f.wrapper.get('[data-testid="live-diagnostics-generate"]').trigger('click');
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-diagnostics-status"]').text()).toBe(await ensureStrings.liveConversation__sending_input_audio());
    expect(f.wrapper.get('[data-testid="live-diagnostics-pacing"]').attributes('disabled')).toBeDefined();
    expect(f.speech.client.push).not.toHaveBeenCalled();
    await f.wrapper.get('[data-testid="live-diagnostics-cancel"]').trigger('click');
    await flushPromises();
    expect(f.speech.controller.getState().fileRun?.status).toBe('partial');
    expect(f.speech.controller.getState().fileRun?.replayTiming?.interruption).toBe('user_cancel');
    expect(f.wrapper.get('[data-testid="live-diagnostics-interruption"]').text()).toBe(await ensureStrings.liveConversation__generation_cancelled());
    expect(f.wrapper.get('[data-testid="live-diagnostics-input-name"]').text()).toBe('waiting.wav');
    expect(f.wrapper.get('[data-testid="live-diagnostics-generate"]').attributes('disabled')).toBeUndefined();
    expect(f.speech.client.stop).toHaveBeenCalledWith({ mode: 'cancel' });
    expect(f.speech.client.loadModel).toHaveBeenCalledOnce();
    expect(f.speech.client.releaseModel).not.toHaveBeenCalled();
    expect(f.speech.client.push).not.toHaveBeenCalled();
    expect(f.speech.capture).not.toHaveBeenCalled();
  });

  it('leaves live speech audio retention off until explicitly enabled', async () => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue(speechInspection);
    await using f = await fixture();
    const retainLfm = vi.spyOn(f.controller, 'retainAudio');
    const retainSpeech = vi.spyOn(f.speech.controller, 'retainAudio');
    const keep = f.page.get<HTMLInputElement>('[data-testid="live-keep-audio"]');
    expect(keep.element.checked).toBe(false);
    expect(keep.element.disabled).toBe(false);
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    await f.wrapper.get('[data-testid="live-speech-start"]').trigger('click');
    await flushPromises();
    expect(retainLfm).toHaveBeenLastCalledWith({ value: 'off' });
    expect(retainSpeech).toHaveBeenLastCalledWith({ value: 'off' });
    f.speech.pcm({ samples: new Float32Array([0.5, -0.5]) });
    f.speech.frame({ text: 'Response', samples: new Float32Array([0.25, -0.25]) });
    await f.wrapper.get('[data-testid="live-speech-stop"]').trigger('click');
    await flushPromises();
    expect(f.speech.controller.getState().sessions[0]).toMatchObject({ inputAudio: undefined, outputAudio: undefined });
    expect(f.wrapper.find('[data-testid="live-speech-retained-audio"]').exists()).toBe(false);
  });

  it.each(['en', 'ja'] as const)('replays and saves both sides of opt-in speech audio with one session ID (%s)', async locale => {
    await ensureAllStringsForTest({ locale });
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue(speechInspection);
    await using f = await fixture();
    const retainLfm = vi.spyOn(f.controller, 'retainAudio');
    const retainSpeech = vi.spyOn(f.speech.controller, 'retainAudio');
    await f.page.get('[data-testid="live-keep-audio"]').setValue(true);
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    await f.wrapper.get('[data-testid="live-speech-start"]').trigger('click');
    await flushPromises();
    expect(retainLfm).toHaveBeenLastCalledWith({ value: 'on' });
    expect(retainSpeech).toHaveBeenLastCalledWith({ value: 'on' });
    f.speech.pcm({ samples: new Float32Array([0.5, -0.5]) });
    f.speech.frame({ text: 'Response', samples: new Float32Array([0.25, -0.25]) });
    await f.wrapper.get('[data-testid="live-speech-stop"]').trigger('click');
    await flushPromises();
    const session = f.speech.controller.getState().sessions[0];
    expect(session?.id).toMatch(/^[\w-]{21}$/);
    expect(f.wrapper.get('[data-testid="live-speech-input-replay"]').attributes('src')).toBe(session?.inputAudio?.url);
    expect(f.wrapper.get('[data-testid="live-speech-output-replay"]').attributes('src')).toBe(session?.outputAudio?.url);
    expect(f.wrapper.get('[data-testid="live-speech-download-input"]').attributes('download')).toBe(`naidan-live-${session?.id}-input.wav`);
    expect(f.wrapper.get('[data-testid="live-speech-download-output"]').attributes('download')).toBe(`naidan-live-${session?.id}-response.wav`);
    const help = f.wrapper.get('[data-testid="live-speech-retention-help"]').text();
    expect(help).toContain(locale === 'ja' ? '送信が受け付けられた' : 'accepted for sending');
    expect(help).toContain(locale === 'ja' ? '処理済みとは限らず' : 'does not prove the model consumed');
    expect(help).toContain(locale === 'ja' ? '再生前' : 'before playback');
    expect(f.wrapper.get('[data-testid="live-speech-partial-audio"]').text()).toContain(locale === 'ja' ? '途中まで' : 'part of the conversation');
    await f.wrapper.get('[data-testid="live-speech-input-replay"]').trigger('play');
    await f.wrapper.get('[data-testid="live-speech-output-replay"]').trigger('play');
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    const pausesBeforeStart = vi.mocked(HTMLMediaElement.prototype.pause).mock.calls.length;
    await f.wrapper.get('[data-testid="live-speech-start"]').trigger('click');
    await flushPromises();
    expect(vi.mocked(HTMLMediaElement.prototype.pause).mock.calls.length).toBeGreaterThan(pausesBeforeStart);
    const stopCalls = vi.mocked(f.speech.client.stop).mock.calls.length;
    const muteCalls = f.speech.player.mute.mock.calls.length;
    const pausesBeforeReplay = vi.mocked(HTMLMediaElement.prototype.pause).mock.calls.length;
    expect(f.wrapper.get('[data-testid="live-speech-input-replay"]').attributes('inert')).toBeDefined();
    expect(f.wrapper.get('[data-testid="live-speech-output-replay"]').attributes('aria-disabled')).toBe('true');
    await f.wrapper.get('[data-testid="live-speech-input-replay"]').trigger('play');
    await f.wrapper.get('[data-testid="live-speech-output-replay"]').trigger('play');
    expect(vi.mocked(HTMLMediaElement.prototype.pause).mock.calls.length).toBe(pausesBeforeReplay + 2);
    expect(f.speech.player.mute).toHaveBeenCalledTimes(muteCalls);
    expect(f.speech.client.stop).toHaveBeenCalledTimes(stopCalls);
    expect(f.speech.capture).toHaveBeenCalledTimes(2);
    expect(f.speech.client.loadModel).toHaveBeenCalledOnce();
    expect(f.speech.client.releaseModel).not.toHaveBeenCalled();
  });

  it('allows turning speech audio retention off immediately and enabling it again before the next session', async () => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue(speechInspection);
    await using f = await fixture();
    await f.page.get('[data-testid="live-keep-audio"]').setValue(true);
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    await f.wrapper.get('[data-testid="live-speech-start"]').trigger('click');
    await flushPromises();
    f.speech.pcm({ samples: new Float32Array([0.5]) });
    f.speech.frame({ text: 'First response', samples: new Float32Array([0.25]) });
    await f.wrapper.get('[data-testid="live-speech-stop"]').trigger('click');
    await flushPromises();
    expect(f.wrapper.find('[data-testid="live-speech-retained-audio"]').exists()).toBe(true);
    await f.wrapper.get('[data-testid="live-speech-start"]').trigger('click');
    await flushPromises();
    await f.wrapper.get('[data-testid="live-open-settings"]').trigger('click');
    await flushPromises();
    const keep = f.page.get<HTMLInputElement>('[data-testid="live-keep-audio"]');
    expect(keep.element.disabled).toBe(false);
    await keep.setValue(false);
    expect(keep.element.disabled).toBe(true);
    expect(f.wrapper.find('[data-testid="live-speech-retained-audio"]').exists()).toBe(false);
    await f.page.get('[data-testid="live-settings-close"]').trigger('click');
    f.speech.pcm({ samples: new Float32Array([0.5]) });
    f.speech.frame({ text: 'Second response', samples: new Float32Array([0.25]) });
    await f.wrapper.get('[data-testid="live-speech-stop"]').trigger('click');
    await flushPromises();
    await f.wrapper.get('[data-testid="live-open-settings"]').trigger('click');
    await flushPromises();
    expect(keep.element.disabled).toBe(false);
    await keep.setValue(true);
    await f.page.get('[data-testid="live-settings-close"]').trigger('click');
    await f.wrapper.get('[data-testid="live-speech-start"]').trigger('click');
    await flushPromises();
    f.speech.pcm({ samples: new Float32Array([0.5]) });
    f.speech.frame({ text: 'Third response', samples: new Float32Array([0.25]) });
    await f.wrapper.get('[data-testid="live-speech-stop"]').trigger('click');
    await flushPromises();
    expect(f.speech.controller.getState().sessions.map(session => !!session.inputAudio)).toEqual([false, false, true]);
    expect(f.speech.client.loadModel).toHaveBeenCalledOnce();
    expect(f.speech.client.releaseModel).not.toHaveBeenCalled();
  });

  it('clears live audio on both controllers without discarding investigation audio', async () => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue(speechInspection);
    await using f = await fixture();
    await f.page.get('[data-testid="live-keep-audio"]').setValue(true);
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    await f.wrapper.get('[data-testid="live-speech-start"]').trigger('click');
    await flushPromises();
    f.speech.pcm({ samples: new Float32Array([0.5]) });
    f.speech.frame({ text: 'Live response', samples: new Float32Array([0.25]) });
    await f.wrapper.get('[data-testid="live-speech-stop"]').trigger('click');
    await flushPromises();
    await f.wrapper.setProps({ panel: 'diagnostics' });
    await flushPromises();
    const file = new File(['audio'], 'investigation.wav', { type: 'audio/wav' });
    await f.wrapper.get('[data-testid="live-diagnostics-input"]').trigger('drop', { dataTransfer: { files: [file], types: ['Files'] } });
    await flushPromises();
    vi.mocked(f.speech.client.push).mockImplementation(() => {
      f.speech.frame({ text: 'File response', samples: new Float32Array(3200) });
      return { kind: 'accepted' };
    });
    await f.wrapper.get('[data-testid="live-diagnostics-generate"]').trigger('click');
    await flushPromises();
    const run = f.speech.controller.getState().fileRun;
    expect(run?.input).toBeDefined();
    expect(run?.output).toBeDefined();
    const comparisonOutput = f.wrapper.get('[data-testid="live-diagnostics-download-output"]').attributes('href');
    expect(comparisonOutput).not.toBe(run?.output?.url);
    expect(f.speech.controller.getState().sessions[0]?.inputAudio).toBeDefined();
    const retainLfm = vi.spyOn(f.controller, 'retainAudio');
    const retainSpeech = vi.spyOn(f.speech.controller, 'retainAudio');
    await f.wrapper.get('[data-testid="live-open-settings"]').trigger('click');
    await flushPromises();
    await f.page.get('[data-testid="live-keep-audio"]').setValue(false);
    expect(retainLfm).toHaveBeenLastCalledWith({ value: 'off' });
    expect(retainSpeech).toHaveBeenLastCalledWith({ value: 'off' });
    expect(f.speech.controller.getState().sessions[0]).toMatchObject({ inputAudio: undefined, outputAudio: undefined });
    expect(f.speech.controller.getState().fileRun).toBe(run);
    expect(f.wrapper.get('[data-testid="live-diagnostics-download-output"]').attributes('href')).toBe(comparisonOutput);
    expect(f.speech.client.loadModel).toHaveBeenCalledOnce();
  });

  it.each(['retention-limit', 'retention-failed'] as const)('explains speech %s independently from real-time input warnings', async warning => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue(speechInspection);
    await using f = await fixture();
    f.speechState.value = { ...f.speechState.value, audioWarning: warning, warning: 'input-backpressure' };
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-speech-audio-warning"]').text()).toContain(warning === 'retention-limit' ? '64 MiB' : 'Could not keep this audio');
    expect(f.wrapper.get('[data-testid="live-speech-warning"]').text()).toContain('keep up');
  });

  it.each(['en', 'ja'] as const)('explains headphone use and waiting without stopping in the existing microphone help (%s)', async locale => {
    await ensureAllStringsForTest({ locale });
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue(speechInspection);
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    const guidance = f.wrapper.get('[data-testid="live-speech-guidance"]').text();
    expect(guidance).toContain(locale === 'ja' ? 'ヘッドホン' : 'headphones');
    expect(guidance).toContain(locale === 'ja' ? '停止せずに返答を待ってください' : 'wait for a reply without stopping');
    expect(guidance).toContain(locale === 'ja' ? '対話全体を終了します' : 'ends the whole conversation');
    await f.wrapper.get('[data-testid="live-open-settings"]').trigger('click');
    await flushPromises();
    const fullHelp = f.page.get('[data-testid="live-speech-help"]').text();
    expect(fullHelp).toContain(locale === 'ja' ? '返答を含む対話全体を終了します' : 'ends the entire conversation, including the reply');
    expect(fullHelp).toContain(locale === 'ja' ? '文字起こし' : 'transcription');
    expect(f.speech.client.start).not.toHaveBeenCalled();
    expect(f.speech.capture).not.toHaveBeenCalled();
  });

  it.each(residentPanels)('keeps the %s resident after new conversations with the same or another selection in %s', async (engine, panel) => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue(engine === 'speech' ? speechInspection : { kind: 'other' });
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    await f.wrapper.setProps({ panel });
    const reset = vi.spyOn(engine === 'speech' ? f.speech.controller : f.controller, 'reset');
    await f.wrapper.get('[data-testid="live-new-conversation"]').trigger('click');
    await flushPromises();
    expect(reset).toHaveBeenCalledOnce();
    expect(f.wrapper.get('[data-testid="live-header-model"]').attributes('title')).toBe('user/live');
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue(engine === 'speech' ? { kind: 'other' } : speechInspection);
    await selectDownloadedModel({ wrapper: f.wrapper, page: f.page, modelId: 'next/model' });
    expect(f.speech.client.releaseModel).not.toHaveBeenCalled();
    expect(f.player.close).not.toHaveBeenCalled();
    await f.wrapper.get('[data-testid="live-new-conversation"]').trigger('click');
    await flushPromises();
    expect(reset).toHaveBeenCalledTimes(2);
    expect(f.wrapper.get('[data-testid="live-header-model"]').attributes('title')).toBe('user/live');
    expect(f.speech.client.releaseModel).not.toHaveBeenCalled();
    expect(f.player.close).not.toHaveBeenCalled();
    expect(f.page.get('[data-testid="live-loaded-model"]').text()).toContain('user/live');
    expect(f.speech.client.loadModel).toHaveBeenCalledTimes(engine === 'speech' ? 1 : 0);
    expect(f.runLiveSession).toHaveBeenCalledTimes(engine === 'llama' ? 1 : 0);
    if (panel === 'diagnostics') {
      expect(f.wrapper.get('[data-testid="live-diagnostics-model"] [data-testid="model-selector-trigger"]').attributes('title')).toBe('next/model');
      expect(f.wrapper.get('[data-testid="live-diagnostics-generate"]').attributes('disabled')).toBeDefined();
      expect(f.wrapper.find('[data-testid="live-diagnostics-unavailable"]').exists()).toBe(engine !== 'speech');
      expect(f.wrapper.get('[data-testid="live-diagnostics-resident-model"]').text()).toContain('user/live');
      const file = new File(['audio'], 'resident.wav', { type: 'audio/wav' });
      await f.wrapper.get('[data-testid="live-diagnostics-input"]').trigger('drop', { dataTransfer: { files: [file], types: ['Files'] } });
      await flushPromises();
      if (engine === 'speech') {
        expect(f.wrapper.get('[data-testid="live-diagnostics-generate"]').attributes('disabled')).toBeUndefined();
        await f.wrapper.get('[data-testid="live-diagnostics-generate"]').trigger('click');
        await flushPromises();
        expect(f.speech.client.start).toHaveBeenCalledOnce();
        expect(f.speech.client.loadModel).toHaveBeenCalledOnce();
        expect(f.runLiveSession).not.toHaveBeenCalled();
      } else {
        expect(f.wrapper.get('[data-testid="live-diagnostics-generate"]').attributes('disabled')).toBeDefined();
        expect(f.speech.client.start).not.toHaveBeenCalled();
      }
    } else if (engine === 'speech') {
      expect(f.wrapper.get('[data-testid="live-speech-start"]').attributes('disabled')).toBeUndefined();
      await f.wrapper.get('[data-testid="live-speech-start"]').trigger('click');
      await flushPromises();
      expect(f.speech.client.start).toHaveBeenCalledOnce();
      expect(f.runLiveSession).not.toHaveBeenCalled();
    } else {
      await f.wrapper.get('[data-testid="live-text"]').setValue('Use the resident model');
      await f.wrapper.get('form').trigger('submit');
      await flushPromises();
      expect(f.controller.getState().entries[0]?.modelId).toBe('user/live');
    }
  });

  it('checks the selected LM runtime while keeping the speech model resident', async () => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue(speechInspection);
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    const manager = f.wrapper.findComponent(LlamaCppBrowserManager);
    manager.vm.$emit('runtime-ready', false);
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue({ kind: 'other' });
    await selectDownloadedModel({ wrapper: f.wrapper, page: f.page, modelId: 'next/lfm' });
    await f.wrapper.get('[data-testid="live-open-settings"]').trigger('click');
    await flushPromises();
    expect(manager.props('runtimeSettings')).toBe('show');
    expect(f.page.get('[data-testid="live-load-model"]').attributes('disabled')).toBeDefined();
    expect(f.wrapper.get('[data-testid="live-header-model"]').attributes('title')).toBe('user/live');
    expect(f.speech.client.releaseModel).not.toHaveBeenCalled();
    manager.vm.$emit('runtime-ready', true);
    await flushPromises();
    expect(f.page.get('[data-testid="live-load-model"]').attributes('disabled')).toBeUndefined();
    expect(f.speech.client.releaseModel).not.toHaveBeenCalled();
  });

  it('keeps resident ownership when releasing a model for an explicit switch fails', async () => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue(speechInspection);
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue({ kind: 'other' });
    await selectDownloadedModel({ wrapper: f.wrapper, page: f.page, modelId: 'next/lfm' });
    await f.wrapper.get('[data-testid="live-open-settings"]').trigger('click');
    await flushPromises();
    vi.mocked(f.speech.client.releaseModel).mockRejectedValueOnce(new Error('The resident model could not be released'));
    await f.page.get('[data-testid="live-load-model"]').trigger('click');
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-header-model"]').attributes('title')).toBe('user/live');
    expect(f.speech.controller.getState().runtime.model).toBeDefined();
    expect(f.speech.client.loadModel).toHaveBeenCalledOnce();
    expect(f.runLiveSession).not.toHaveBeenCalled();
  });

  it.each(residentPanels)('can reset the %s resident with an unavailable selection in %s', async (engine, panel) => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue(engine === 'speech' ? speechInspection : { kind: 'other' });
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    await f.wrapper.setProps({ panel });
    const reset = vi.spyOn(engine === 'speech' ? f.speech.controller : f.controller, 'reset');
    vi.mocked(inspectStoredSpeechModel).mockRejectedValue(new Error('Selected model is missing'));
    await selectDownloadedModel({ wrapper: f.wrapper, page: f.page, modelId: 'missing/model' });
    vi.mocked(listModelInventory).mockResolvedValue([{ modelId: 'user/live', size: 1, importedAt: 0 }]);
    // A disappeared candidate does not invalidate a model already held by the runtime.
    const listener = vi.mocked(llamaCppBrowserModelFiles.subscribeModelList).mock.calls[0]![0].listener;
    listener();
    await flushPromises();
    await f.wrapper.get('[data-testid="live-new-conversation"]').trigger('click');
    await flushPromises();
    expect(reset).toHaveBeenCalledOnce();
    expect(f.wrapper.get('[data-testid="live-header-model"]').attributes('title')).toBe('user/live');
    expect(f.speech.client.releaseModel).not.toHaveBeenCalled();
    expect(f.player.close).not.toHaveBeenCalled();
  });

  it.each(residentPanels.flatMap(([engine, panel]) => [
    { engine, panel, target: engine },
    { engine, panel, target: engine === 'speech' ? 'llama' as const : 'speech' as const },
  ]))('releases $engine before explicitly loading $target in $panel', async ({ engine, panel, target }) => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue(engine === 'speech' ? speechInspection : { kind: 'other' });
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    await f.wrapper.setProps({ panel });
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue(target === 'speech' ? speechInspection : { kind: 'other' });
    await selectDownloadedModel({ wrapper: f.wrapper, page: f.page, modelId: 'next/model' });
    if (panel === 'diagnostics' && target === 'llama') {
      expect(f.wrapper.get('[data-testid="live-diagnostics-load-model"]').attributes('disabled')).toBeDefined();
      expect(f.wrapper.find('[data-testid="live-investigation-model-mismatch"]').exists()).toBe(true);
      expect(f.wrapper.get('[data-testid="live-header-model"]').attributes('title')).toBe('user/live');
      expect(f.speech.client.releaseModel).not.toHaveBeenCalled();
      expect(f.player.close).not.toHaveBeenCalled();
      return;
    }
    const released = Promise.withResolvers<void>();
    using releaseGate = {
      promise: released.promise,
      [Symbol.dispose]() {
        released.resolve();
      },
    };
    const order: string[] = [];
    const release = engine === 'speech' ? f.speech.client.releaseModel : f.player.close;
    const originalRelease = vi.mocked(release).getMockImplementation()!;
    vi.mocked(release).mockImplementation(async () => {
      order.push('release');
      await releaseGate.promise;
      await originalRelease();
      order.push('released');
    });
    const load = target === 'speech' ? f.speech.client.loadModel : f.runLiveSession;
    const loadsBefore = vi.mocked(load).mock.calls.length;
    if (panel === 'conversation') {
      await f.wrapper.get('[data-testid="live-open-settings"]').trigger('click');
      await flushPromises();
      void f.page.get('[data-testid="live-load-model"]').trigger('click');
    } else {
      void f.wrapper.get('[data-testid="live-diagnostics-load-model"]').trigger('click');
    }
    await flushPromises();
    expect(order).toEqual(['release']);
    expect(vi.mocked(load).mock.calls).toHaveLength(loadsBefore);
    released.resolve();
    await flushPromises();
    expect(order).toEqual(['release', 'released']);
    expect(vi.mocked(load).mock.calls).toHaveLength(loadsBefore + 1);
    expect(f.wrapper.get('[data-testid="live-header-model"]').attributes('title')).toBe('next/model');
  });

  it.each(['en', 'ja'] as const)('explains the language instruction requirement in both settings surfaces without adding hidden instructions (%s)', async locale => {
    await ensureAllStringsForTest({ locale });
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue({ kind: 'speech', info: { name: 'model', architecture: 'haru', task: 'dialogue', bytes: 1, sampleRate: 24000, frameSamples: 3200, requiredVersion: 'test' } });
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    await f.wrapper.get('[data-testid="live-open-settings"]').trigger('click');
    await flushPromises();
    const expected = locale === 'ja'
      ? '会話の言語を指定するには、指示も入力してください。指示が空の場合、別の言語で応答することがあります。'
      : 'To set the conversation language, also enter instructions. If the instructions are empty, the model may respond in another language.';
    const normalHelp = f.page.get('[data-testid="live-speech-language-help"]');
    expect(normalHelp.text()).toBe(expected);
    expect(f.page.get('[data-testid="live-speech-language"]').attributes('aria-describedby')).toBe(normalHelp.attributes('id'));
    expect(f.page.get<HTMLTextAreaElement>('[data-testid="live-instructions"]').element.value).toBe('');
    await f.page.get('[data-testid="live-settings-close"]').trigger('click');
    await f.wrapper.setProps({ panel: 'diagnostics' });
    await flushPromises();
    const diagnosticHelp = f.wrapper.get('[data-testid="live-diagnostics-language-help"]');
    expect(diagnosticHelp.text()).toBe(expected);
    expect(f.wrapper.get('[data-testid="live-diagnostics-language"]').attributes('aria-describedby')).toBe(diagnosticHelp.attributes('id'));
    expect(diagnosticHelp.attributes('id')).not.toBe(normalHelp.attributes('id'));
    expect(f.wrapper.get<HTMLTextAreaElement>('[data-testid="live-diagnostics-instructions"]').element.value).toBe('');
    const file = new File(['audio'], 'language.wav', { type: 'audio/wav' });
    await f.wrapper.get('[data-testid="live-diagnostics-input"]').trigger('drop', { dataTransfer: { files: [file], types: ['Files'] } });
    await flushPromises();
    const run = vi.spyOn(f.speech.controller, 'runFile').mockResolvedValue(undefined);
    await f.wrapper.get('[data-testid="live-diagnostics-generate"]').trigger('click');
    await flushPromises();
    expect(run).toHaveBeenCalledWith({ file, maxSeconds: 120, language: locale, persona: undefined, name: undefined, tailSeconds: 5, seed: 0, inputPacing: 'fast', inputLevel: { kind: 'gain', gain: 1 }, maximumRetainedAudioBytes: 64 * 1024 * 1024 - file.size, investigation: expect.objectContaining({ context: expect.objectContaining({ source: 'investigation' }), observer: expect.any(Function) }) });
  });

  it('runs the same audio twice without opening the microphone or reloading the model', async () => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue({ kind: 'speech', info: { name: 'model', architecture: 'haru', task: 'dialogue', bytes: 1, sampleRate: 24000, frameSamples: 3200, requiredVersion: 'test' } });
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    await f.wrapper.setProps({ panel: 'diagnostics' });
    await flushPromises();
    expect(f.wrapper.find('[data-testid="live-speech-controls"]').exists()).toBe(false);
    expect(f.wrapper.find('[data-testid="live-composer-footer"]').exists()).toBe(false);
    const file = new File(['audio'], 'same-input.wav', { type: 'audio/wav' });
    const picker = f.wrapper.get<HTMLInputElement>('[data-testid="live-diagnostics-file"]');
    Object.defineProperty(picker.element, 'files', { configurable: true, value: [file] });
    await picker.trigger('change');
    await flushPromises();
    vi.mocked(f.speech.client.push).mockImplementation(() => {
      const samples = new Float32Array(3200);
      samples.set([0.125, -0.25]);
      f.speech.frame({ text: 'Reply ', samples });
      return { kind: 'accepted' };
    });
    await f.wrapper.get('[data-testid="live-diagnostics-generate"]').trigger('click');
    await flushPromises();
    expect(f.speech.controller.getState().fileRun?.status).toBe('complete');
    expect(f.speech.controller.getState().sessions).toHaveLength(0);
    expect(f.speech.controller.getState().fileRun?.text).toContain('Reply');
    const firstId = f.speech.controller.getState().fileRun?.id;
    expect(firstId).toMatch(/^[\w-]{21}$/);
    const firstOutputName = `naidan-same-input-${firstId}-response.wav`;
    const firstInputName = `naidan-same-input-${firstId}-input.wav`;
    expect(f.wrapper.get('[data-testid="live-diagnostics-download-output"]').attributes('download')).toBe(firstOutputName);
    expect(f.wrapper.get('[data-testid="live-diagnostics-download-input"]').attributes('download')).toBe(firstInputName);
    expect(f.wrapper.get('[data-testid="live-diagnostics-input-name"]').text()).toBe('same-input.wav');
    expect(f.wrapper.get('[data-testid="live-diagnostics-text"]').text()).toContain('Reply');
    expect(f.wrapper.get('[data-testid="live-diagnostics-prepare-time"]').text()).not.toBe('—');
    expect(f.wrapper.get('[data-testid="live-diagnostics-first-output"]').text()).not.toBe('—');
    expect(f.wrapper.get('[data-testid="live-diagnostics-generation-time"]').text()).not.toBe('—');
    expect(f.wrapper.get('[data-testid="live-diagnostics-rtf"]').text()).toContain('s/s');
    expect(f.wrapper.get('[data-testid="live-diagnostics-result-pacing"]').text()).toContain('As fast as possible');
    expect(f.wrapper.get('[data-testid="live-diagnostics-first-output-help"]').text()).toContain('before any input is sent');
    expect(f.wrapper.get('[data-testid="live-diagnostics-rtf-help"]').text()).toContain('does not measure inference speed alone');
    const pacing = f.wrapper.get('[data-testid="live-diagnostics-pacing"]');
    await pacing.trigger('click');
    await f.page.get('[data-testid="settings-select-option-real_time"]').trigger('click');
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-diagnostics-result-pacing"]').text()).toContain('As fast as possible');
    expect(f.wrapper.get('[data-testid="live-diagnostics-timing-pacing"]').text()).toBe('As fast as possible');
    expect(f.speech.client.start).toHaveBeenCalledOnce();
    await pacing.trigger('click');
    await f.page.get('[data-testid="settings-select-option-fast"]').trigger('click');
    await flushPromises();
    await f.wrapper.get('[data-testid="live-diagnostics-seed"]').setValue('7');
    expect(f.wrapper.get('[data-testid="live-diagnostics-download-output"]').attributes('download')).toBe(firstOutputName);
    expect(f.wrapper.get('[data-testid="live-diagnostics-download-input"]').attributes('download')).toBe(firstInputName);
    expect(f.speech.controller.getState().fileRun?.id).toBe(firstId);
    await f.wrapper.get('[data-testid="live-diagnostics-seed"]').setValue('0');
    await f.wrapper.get('[data-testid="live-diagnostics-generate"]').trigger('click');
    await flushPromises();
    const secondId = f.speech.controller.getState().fileRun?.id;
    expect(secondId).toMatch(/^[\w-]{21}$/);
    expect(secondId).not.toBe(firstId);
    const secondOutputName = `naidan-same-input-${secondId}-response.wav`;
    const secondInputName = `naidan-same-input-${secondId}-input.wav`;
    expect(f.wrapper.get('[data-testid="live-diagnostics-download-output"]').attributes('download')).toBe(secondOutputName);
    expect(f.wrapper.get('[data-testid="live-diagnostics-download-input"]').attributes('download')).toBe(secondInputName);
    expect(f.speech.client.start).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.speech.client.start).mock.calls.map(([request]) => request.options.seed)).toEqual([0, 0]);
    expect(f.speech.client.loadModel).toHaveBeenCalledOnce();
    expect(f.speech.capture).not.toHaveBeenCalled();
    expect(f.speech.player.activate).not.toHaveBeenCalled();
    expect(f.speech.decodeFile.mock.calls.map(([request]) => request.file)).toEqual([file, file]);
    await f.wrapper.setProps({ panel: 'conversation' });
    expect(f.speech.client.releaseModel).not.toHaveBeenCalled();
    expect(f.wrapper.find('[data-testid="live-speech-session"]').exists()).toBe(false);
    await f.wrapper.setProps({ panel: 'diagnostics' });
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-diagnostics-input-name"]').text()).toBe('same-input.wav');
    expect(f.wrapper.get('[data-testid="live-diagnostics-download-output"]').attributes('download')).toBe(secondOutputName);
    expect(f.wrapper.get('[data-testid="live-diagnostics-download-input"]').attributes('download')).toBe(secondInputName);
    expect(f.speech.client.loadModel).toHaveBeenCalledOnce();
    await f.wrapper.get('[data-testid="live-diagnostics-clear"]').trigger('click');
    await flushPromises();
    expect(f.speech.controller.getState().fileRun).toBeUndefined();
    expect(f.wrapper.find('[data-testid="live-diagnostics-result"]').exists()).toBe(false);
    expect(f.speech.controller.getState().sessions).toHaveLength(0);
  });

  it('retains the same selected audio while loading another model from investigation tools', async () => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue({ kind: 'speech', info: { name: 'model', architecture: 'haru', task: 'dialogue', bytes: 1, sampleRate: 24000, frameSamples: 3200, requiredVersion: 'test' } });
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    await f.wrapper.setProps({ panel: 'diagnostics' });
    await flushPromises();
    const file = new File(['audio'], 'comparison.wav', { type: 'audio/wav' });
    await f.wrapper.get('[data-testid="live-diagnostics-input"]').trigger('drop', { dataTransfer: { files: [file], types: ['Files'] } });
    await flushPromises();
    await selectDownloadedModel({ wrapper: f.wrapper, page: f.page, modelId: 'next/audio' });
    await f.wrapper.get('[data-testid="live-diagnostics-load-model"]').trigger('click');
    await flushPromises();
    expect(f.speech.client.loadModel).toHaveBeenCalledTimes(2);
    expect(f.speech.client.releaseModel).toHaveBeenCalledOnce();
    expect(f.wrapper.get('[data-testid="live-diagnostics-input-name"]').text()).toBe('comparison.wav');
    expect(f.wrapper.get('[data-testid="live-header-model"]').attributes('title')).toBe('next/audio');
    expect(f.wrapper.get('[data-testid="live-diagnostics-generate"]').attributes('disabled')).toBeUndefined();
  });

  it('validates an explicit investigation seed and passes the edited value to the runner', async () => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue({ kind: 'speech', info: { name: 'model', architecture: 'haru', task: 'dialogue', bytes: 1, sampleRate: 24000, frameSamples: 3200, requiredVersion: 'test' } });
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    await f.wrapper.setProps({ panel: 'diagnostics' });
    await flushPromises();
    const file = new File(['audio'], 'seed.wav', { type: 'audio/wav' });
    await f.wrapper.get('[data-testid="live-diagnostics-input"]').trigger('drop', { dataTransfer: { files: [file], types: ['Files'] } });
    await flushPromises();
    await f.wrapper.get('[data-testid="live-diagnostics-seed"]').setValue('-1');
    expect(f.wrapper.get('[data-testid="live-diagnostics-generate"]').attributes('disabled')).toBeDefined();
    expect(f.wrapper.get('[data-testid="live-diagnostics-unavailable"]').text()).toContain('seed');
    await f.wrapper.get('[data-testid="live-diagnostics-seed"]').setValue('7');
    const run = vi.spyOn(f.speech.controller, 'runFile').mockResolvedValue(undefined);
    await f.wrapper.get('[data-testid="live-diagnostics-generate"]').trigger('click');
    await flushPromises();
    expect(run).toHaveBeenCalledWith({ file, maxSeconds: 120, language: 'en', persona: undefined, name: undefined, tailSeconds: 5, seed: 7, inputPacing: 'fast', inputLevel: { kind: 'gain', gain: 1 }, maximumRetainedAudioBytes: 64 * 1024 * 1024 - file.size, investigation: expect.objectContaining({ context: expect.objectContaining({ source: 'investigation' }), observer: expect.any(Function) }) });
    expect(f.speech.capture).not.toHaveBeenCalled();
  });

  it('accepts dropped audio in investigation tools and cancels decoding without microphone permission', async () => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue({ kind: 'speech', info: { name: 'model', architecture: 'haru', task: 'dialogue', bytes: 1, sampleRate: 24000, frameSamples: 3200, requiredVersion: 'test' } });
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    await f.wrapper.setProps({ panel: 'diagnostics' });
    await flushPromises();
    const file = new File(['audio'], 'dropped.wav', { type: 'audio/wav' });
    await f.wrapper.get('[data-testid="live-diagnostics-input"]').trigger('drop', { dataTransfer: { files: [file], types: ['Files'] } });
    await flushPromises();
    const decoding = Promise.withResolvers<Float32Array<ArrayBuffer>>();
    f.speech.decodeFile.mockReturnValue(decoding.promise);
    await f.wrapper.get('[data-testid="live-diagnostics-generate"]').trigger('click');
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-diagnostics-status"]').text()).toContain('Preparing');
    await f.wrapper.get('[data-testid="live-diagnostics-cancel"]').trigger('click');
    await flushPromises();
    expect(f.speech.decodeFile.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(f.speech.capture).not.toHaveBeenCalled();
    expect(f.speech.client.start).not.toHaveBeenCalled();
    expect(f.wrapper.get('[data-testid="live-diagnostics-input-name"]').text()).toBe('dropped.wav');
    expect(f.wrapper.get('[data-testid="live-diagnostics-generate"]').attributes('disabled')).toBeUndefined();
    decoding.resolve(new Float32Array([0.5]));
  });

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
    expect(f.speech.client.start).toHaveBeenCalledWith({ options: { inputSampleRate: 24000, maxSeconds: 120, language: 'fr', persona: 'Friendly persona', name: undefined, seed: undefined } });
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
    await selectDownloadedModel({ wrapper: f.wrapper, page: f.page, modelId: 'speech/second' });
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
      await selectDownloadedModel({ wrapper: f.wrapper, page: f.page, modelId: 'speech/model' });
      await f.wrapper.get('[data-testid="live-start"]').trigger('click');
      await flushPromises();
      await f.wrapper.get('[data-testid="live-speech-start"]').trigger('click');
      await flushPromises();
      f.speech.frame({ text: 'Speech history', samples: new Float32Array() });
      await flushPromises();
    }
    async function addLfmHistory() {
      vi.mocked(inspectStoredSpeechModel).mockResolvedValue({ kind: 'other' });
      await selectDownloadedModel({ wrapper: f.wrapper, page: f.page, modelId: 'user/live' });
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
      f.speech.change({ state: { phase: 'loading_model', loadProgress: { stage: 'reading_model', readBytes: 1024 * 1024, totalBytes: 2 * 1024 * 1024 } } });
      await loading.promise;
    });
    void f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-cancel-model-loading"]').attributes('disabled')).toBeUndefined();
    expect(f.wrapper.get('[data-testid="live-load-percent"]').text()).toBe('50%');
    expect(f.wrapper.get('[data-testid="live-load-bytes"]').text()).toBe('Read 1 / 2 MiB');
    await f.wrapper.get('[data-testid="live-cancel-model-loading"]').trigger('click');
    await flushPromises();
    expect(f.speech.client.releaseModel).toHaveBeenCalledOnce();
    loading.resolve();
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-start"]').attributes('disabled')).toBeUndefined();
    expect(f.speech.client.start).not.toHaveBeenCalled();
  });

  it('shows separate Wasm progress and allows cancelling a load started from investigation tools', async () => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue({ kind: 'speech', info: { name: 'model', architecture: 'haru', task: 'dialogue', bytes: 1, sampleRate: 24000, frameSamples: 3200, requiredVersion: 'test' } });
    await using f = await fixture();
    await f.wrapper.setProps({ panel: 'diagnostics' });
    await flushPromises();
    const loading = Promise.withResolvers<void>();
    vi.mocked(f.speech.client.loadModel).mockImplementation(async () => {
      f.speech.change({ state: { phase: 'loading_model', loadProgress: { stage: 'loading_runtime', fetchedBytes: 1024 * 1024, decompressedBytes: 4 * 1024 * 1024, totalDecompressedBytes: 16 * 1024 * 1024 } } });
      await loading.promise;
    });
    void f.wrapper.get('[data-testid="live-diagnostics-load-model"]').trigger('click');
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-load-percent"]').text()).toBe('25%');
    expect(f.wrapper.get('[data-testid="live-load-stage"]').text()).toContain('Wasm');
    expect(f.wrapper.get('[data-testid="live-diagnostics-cancel-model"]').attributes('disabled')).toBeUndefined();
    await f.wrapper.get('[data-testid="live-diagnostics-cancel-model"]').trigger('click');
    await flushPromises();
    expect(f.speech.client.releaseModel).toHaveBeenCalledOnce();
    loading.resolve();
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-diagnostics-load-model"]').attributes('disabled')).toBeUndefined();
  });

  it('keeps speech errors and response history when a preselected LFM model becomes active after failure', async () => {
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue({ kind: 'speech', info: { name: 'model', architecture: 'haru', task: 'dialogue', bytes: 1, sampleRate: 24000, frameSamples: 3200, requiredVersion: 'test' } });
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    await f.wrapper.get('[data-testid="live-speech-start"]').trigger('click');
    f.speech.frame({ text: 'Previous answer', samples: new Float32Array() });
    vi.mocked(inspectStoredSpeechModel).mockResolvedValue({ kind: 'other' });
    await selectDownloadedModel({ wrapper: f.wrapper, page: f.page, modelId: 'next/lfm' });
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
    await selectDownloadedModel({ wrapper: f.wrapper, page: f.page, modelId: 'next/lfm' });
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
    expect(f.speech.client.start).toHaveBeenCalledWith({ options: { inputSampleRate: 24000, maxSeconds: 120, language: 'en', persona: undefined, name: undefined, seed: undefined } });
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

  it('keeps header and composer outside the message scroller and moves the same model selector into settings', async () => {
    await using f = await fixture();
    const scroller = f.wrapper.get('[data-testid="live-message-scroll"]').element;
    const header = f.wrapper.get('[data-testid="live-header"]').element;
    const footer = f.wrapper.get('[data-testid="live-composer-footer"]').element;
    expect(scroller.contains(header)).toBe(false);
    expect(scroller.contains(footer)).toBe(false);
    expect(header.parentElement).toBe(scroller.parentElement);
    expect(footer.parentElement).toBe(scroller.parentElement);
    const modelSelector = f.wrapper.getComponent(ModelSelector).element;
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    await f.wrapper.get('[data-testid="live-text"]').setValue('unfinished draft');
    scroller.scrollTop = 120;
    await f.wrapper.get('[data-testid="live-open-settings"]').trigger('click');
    await flushPromises();
    expect(f.page.find('[role="dialog"]').exists()).toBe(true);
    expect(f.wrapper.getComponent(ModelSelector).element).toBe(modelSelector);
    expect(f.wrapper.get('[data-testid="live-conversation-page"]').attributes('inert')).toBeDefined();
    const bounds = vi.spyOn(modelSelector, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, window.innerHeight - 84, 320, 40));
    using _restoreBounds = { [Symbol.dispose]: () => bounds.mockRestore() };
    await openCatalog({ page: f.page });
    const settings = f.page.get('[data-testid="live-settings"]');
    const picker = settings.get<HTMLDialogElement>('[data-testid="model-selector-dropdown"]');
    expect(picker.element.parentElement).toBe(settings.element);
    expect(settings.get('[data-testid="live-settings-body"]').element.contains(picker.element)).toBe(false);
    expect(picker.element.style.bottom).toBe('92px');
    expect(picker.element.style.maxHeight).toBe(`${window.innerHeight - 108}px`);
    expect(picker.get('[data-testid="model-selector-tabs"]').findAll('button').map(tab => tab.text())).toEqual(['Model catalog', 'On this device', 'Hugging Face', 'Add files']);
    expect(picker.find('[data-testid="mock-catalog"]').exists()).toBe(true);
    await picker.trigger('keydown', { key: 'Escape' });
    expect(settings.find('[data-testid="model-selector-dropdown"]').exists()).toBe(false);
    expect(settings.isVisible()).toBe(true);
    await f.page.get('[data-testid="live-settings-close"]').trigger('click');
    await flushPromises();
    expect(scroller.scrollTop).toBe(120);
    expect(f.wrapper.get<HTMLTextAreaElement>('[data-testid="live-text"]').element.value).toBe('unfinished draft');
    expect(f.runLiveSession).toHaveBeenCalledOnce();
    expect(f.wrapper.getComponent(ModelSelector).element).toBe(modelSelector);
  });

  it('shows the resident model until the selected model is explicitly loaded', async () => {
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    await selectDownloadedModel({ wrapper: f.wrapper, page: f.page, modelId: 'next/model' });
    expect(f.wrapper.get('[data-testid="live-header-model"]').attributes('title')).toBe('user/live');
    expect(f.wrapper.get('[data-testid="live-header-model"]').text()).toBe('live');
    await f.wrapper.get('[data-testid="live-new-conversation"]').trigger('click');
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-header-model"]').attributes('title')).toBe('user/live');
    expect(f.runLiveSession).toHaveBeenCalledOnce();
    await f.wrapper.get('[data-testid="live-open-settings"]').trigger('click');
    await flushPromises();
    await f.page.get('[data-testid="live-load-model"]').trigger('click');
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
    await f.wrapper.get('[data-testid="live-open-settings"]').trigger('click');
    expect(f.page.get('[data-testid="live-model"] [data-testid="model-selector-trigger"]').attributes('disabled')).toBeUndefined();
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
    await f.wrapper.get('[data-testid="live-open-settings"]').trigger('click');
    await openCatalog({ page: f.page });
    const catalog = f.wrapper.getComponent({ name: 'LiveCatalogStub' });
    expect(catalog.props('disabled')).toBe(false);
    expect(catalog.props('selectionPolicy')).toBe('installed-only');
    const listener = vi.mocked(llamaCppBrowserModelFiles.subscribeModelList).mock.calls[0]![0].listener;
    listener();
    await flushPromises();
    expect(listModelInventory).toHaveBeenCalled();
    expect(f.runLiveSession).toHaveBeenCalledOnce();
    expect(f.player.close).not.toHaveBeenCalled();
  });

  it('preselects the default online source and waits for an explicit start before downloading', async () => {
    managerInventory = [];
    const repository = 'LiquidAI/LFM3-Audio-2B-GGUF';
    const modelId = `hf.co/${repository}:Q4_K_M`;
    const downloaded = Promise.withResolvers<LocalModel>();
    vi.mocked(acquireRepositoryModel).mockReturnValue(downloaded.promise);
    await using f = await fixture();
    expect(f.wrapper.get('[data-testid="live-offline-introduction"]').text()).toBe('Your audio and messages are processed offline in your browser.');
    expect(f.wrapper.getComponent(ModelSelector).props('modelValue')).toBe(modelId);
    expect(f.wrapper.getComponent(ModelSelector).props('selectionAvailability')).toBe('download_required');
    expect(acquireRepositoryModel).not.toHaveBeenCalled();
    expect(f.runLiveSession).not.toHaveBeenCalled();
    await f.page.get('[data-testid="live-start"]').trigger('click');
    expect(f.page.find('[data-testid="live-model-download-progress"]').exists()).toBe(true);
    expect(acquireRepositoryModel).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      usage: 'live-conversation',
      selection: expect.objectContaining({ modelId, source: { kind: 'bundled', repository, variant: 'Q4_K_M', companionPath: 'mmproj-LFM3-Audio-2B-Q8_0.gguf' } }),
    }));
    expect(f.runLiveSession).not.toHaveBeenCalled();
    downloaded.resolve({ modelId, size: 1, importedAt: 0 });
    await flushPromises();
    expect(f.runLiveSession).toHaveBeenCalledOnce();
    expect(f.wrapper.get('[data-testid="live-header-model"]').attributes('title')).toBe(modelId);
    expect(f.wrapper.getComponent(ModelSelector).props('selectionAvailability')).toBeUndefined();
    expect(vi.mocked(useLiveModelPreference).mock.results[0]?.value.remember).toHaveBeenCalledExactlyOnceWith({ modelId });
  });

  it('keeps the first-use model selected when its pending load is cancelled', async () => {
    managerInventory = [];
    const downloaded = Promise.withResolvers<LocalModel>();
    vi.mocked(acquireRepositoryModel).mockReturnValue(downloaded.promise);
    await using f = await fixture();
    const selector = f.wrapper.getComponent(ModelSelector);
    const modelId = selector.props('modelValue')!;
    await f.page.get('[data-testid="live-start"]').trigger('click');
    const { signal } = vi.mocked(acquireRepositoryModel).mock.calls[0]![0];
    await f.page.get('[data-testid="live-cancel-model-loading"]').trigger('click');
    expect(signal.aborted).toBe(true);
    downloaded.resolve({ modelId, size: 1, importedAt: 0 });
    await flushPromises();
    expect(f.runLiveSession).not.toHaveBeenCalled();
    expect(selector.props('modelValue')).toBe(modelId);
    expect(f.page.find('[data-testid="live-model-download-progress"]').exists()).toBe(false);
    expect(f.page.get('[data-testid="live-start"]').attributes('disabled')).toBeUndefined();
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

  it('keeps a downloaded selection separate from conversation reset until explicit loading', async () => {
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    await selectDownloadedModel({ wrapper: f.wrapper, page: f.page, modelId: 'user/LFM3-Omni-2B' });
    expect(f.runLiveSession).toHaveBeenCalledOnce();
    expect(f.player.close).not.toHaveBeenCalled();
    expect(f.page.get('[data-testid="live-model"] [data-testid="model-selector-trigger"]').attributes('title')).toBe('user/LFM3-Omni-2B');
    await f.wrapper.get('[data-testid="live-text"]').setValue('keep this until confirmed');
    confirm.mockResolvedValueOnce(false);
    await f.wrapper.get('[data-testid="live-new-conversation"]').trigger('click');
    await flushPromises();
    expect(f.runLiveSession).toHaveBeenCalledOnce();
    await f.wrapper.get('[data-testid="live-new-conversation"]').trigger('click');
    await flushPromises();
    expect(f.runLiveSession).toHaveBeenCalledOnce();
    expect(f.player.close).not.toHaveBeenCalled();
    expect(f.state.value.entries).toEqual([]);
    expect(f.wrapper.get<HTMLTextAreaElement>('[data-testid="live-text"]').element.value).toBe('');
    await f.wrapper.get('[data-testid="live-open-settings"]').trigger('click');
    await flushPromises();
    await f.page.get('[data-testid="live-load-model"]').trigger('click');
    await flushPromises();
    expect(f.runLiveSession).toHaveBeenCalledTimes(2);
    expect(f.runLiveSession.mock.calls[1]?.[0].modelId).toBe('user/LFM3-Omni-2B');
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
