import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, nextTick, ref, shallowRef } from 'vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { useAudioTranscriptionModels } from '@/features/audio-transcription/composables/useAudioTranscriptionModels';
import type { useAudioTranscriptionWorkflow } from '@/features/audio-transcription/composables/useAudioTranscriptionWorkflow';
import type { useAudioTranscriptionPreferences } from '@/features/audio-transcription/composables/useAudioTranscriptionPreferences';
import { initialAudioTranscriptionState } from '@/features/audio-transcription/logic/transcription-controller';
import { transcriptionRegionSeconds } from '@/features/audio-transcription/logic/continuous-transcription';
import AudioTranscriptionWorkspace from './AudioTranscriptionWorkspace.vue';

type Workflow = ReturnType<typeof useAudioTranscriptionWorkflow>;
type Phase = Workflow['phase']['value'];
type Preferences = ReturnType<typeof useAudioTranscriptionPreferences>;
type WorkspaceModels = Pick<ReturnType<typeof useAudioTranscriptionModels>, 'models' | 'pickerModels' | 'selectedId' | 'selectedModelId' | 'selectedQuantizationId' | 'openSelected' | 'refreshing' | 'progress'>;

const mocks = vi.hoisted(() => ({
  models: vi.fn<() => WorkspaceModels>(),
  workflow: vi.fn<typeof useAudioTranscriptionWorkflow>(),
  preferences: vi.fn<typeof useAudioTranscriptionPreferences>(),
}));
vi.mock('@/features/audio-transcription/composables/useAudioTranscriptionModels', () => ({ useAudioTranscriptionModels: mocks.models }));
vi.mock('@/features/audio-transcription/composables/useAudioTranscriptionWorkflow', () => ({ useAudioTranscriptionWorkflow: mocks.workflow }));
vi.mock('@/features/audio-transcription/composables/useAudioTranscriptionPreferences', () => ({ useAudioTranscriptionPreferences: mocks.preferences }));
vi.mock('@/features/audio-transcription/components/AudioTranscriptionModelSelector.vue', () => ({ default: { name: 'AudioTranscriptionModelSelector', inheritAttrs: false, render: () => null } }));
vi.mock('@/features/live-conversation/components/LiveModelLoadProgress.vue', () => ({ default: { name: 'LiveModelLoadProgress', inheritAttrs: false, render: () => null } }));
vi.mock('@/features/llama-cpp-browser/components/LlamaCppBrowserDownloadProgress.vue', () => ({ default: { name: 'LlamaCppBrowserDownloadProgress', inheritAttrs: false, render: () => null } }));

function fixture({ source, phase: initialPhase, file, saveText }: { source: 'microphone' | 'file', phase: Phase, file?: File, saveText?: ({ text }: { text: string }) => Promise<void> }) {
  const phase = ref<Phase>(initialPhase);
  const provisional = ref('');
  const clipboardError = ref<Workflow['clipboardError']['value']>();
  const copiedText = ref('');
  const state = shallowRef(initialAudioTranscriptionState());
  const workflow: Workflow = {
    phase: computed(() => phase.value),
    pending: computed(() => phase.value === 'preparing' || phase.value === 'finishing'),
    preloading: computed(() => false),
    state,
    runtimeState: computed(() => state.value.runtime),
    provisionalText: computed(() => provisional.value),
    failureDetails: computed(() => undefined),
    clipboardError,
    visibleText: computed(() => [mocks.workflow.mock.calls[0]?.[0].text.value, provisional.value].filter(Boolean).join('\n')),
    autoCopyCurrent: computed(() => copiedText.value !== '' && copiedText.value === workflow.visibleText.value),
    clearText: vi.fn<Workflow['clearText']>(() => {
      const input = mocks.workflow.mock.calls[0]?.[0];
      if (input !== undefined) {
        input.text.value = '';
      }
      provisional.value = '';
    }),
    copyOnEnable: vi.fn<Workflow['copyOnEnable']>(),
    retryClipboardAfterInteraction: vi.fn<Workflow['retryClipboardAfterInteraction']>(),
    recordClipboardWrite: vi.fn<Workflow['recordClipboardWrite']>(({ value }) => {
      copiedText.value = value;
    }),
    preload: vi.fn<Workflow['preload']>(async () => {}),
    start: vi.fn<Workflow['start']>(async () => {}),
    stop: vi.fn<Workflow['stop']>(async () => {}),
    pauseOrResume: vi.fn<Workflow['pauseOrResume']>(async () => {}),
    transcribeFile: vi.fn<Workflow['transcribeFile']>(async () => {}),
    cancelPreparation: vi.fn<Workflow['cancelPreparation']>(async () => {}),
    TEST_ONLY: {},
  };
  const autoCopy = ref<'enabled' | 'disabled'>('disabled');
  const recognitionLanguage = ref<Preferences['recognitionLanguage']['value']>('auto');
  const saving = ref(false);
  const preferences: Preferences = {
    autoCopy: computed(() => autoCopy.value),
    saving,
    modelId: computed(() => undefined),
    modelAutoLoad: computed(() => 'enabled'),
    microphoneSegmentMaxSeconds: computed(() => transcriptionRegionSeconds),
    recognitionLanguage: computed(() => recognitionLanguage.value),
    rememberModel: vi.fn<Preferences['rememberModel']>(async () => {}),
    updateRecognitionLanguage: vi.fn<Preferences['updateRecognitionLanguage']>(async ({ value }) => {
      recognitionLanguage.value = value;
    }),
    updateModelAutoLoad: vi.fn<Preferences['updateModelAutoLoad']>(async () => {}),
    updateMicrophoneSegmentMaxSeconds: vi.fn<Preferences['updateMicrophoneSegmentMaxSeconds']>(async () => {}),
    updateAutoCopy: vi.fn<Preferences['updateAutoCopy']>(async ({ value }) => {
      autoCopy.value = value;
    }),
    TEST_ONLY: {},
  };
  mocks.models.mockReturnValue({
    models: computed(() => []),
    pickerModels: computed(() => []),
    selectedId: computed(() => undefined),
    selectedModelId: computed(() => undefined),
    selectedQuantizationId: computed(() => undefined),
    openSelected: vi.fn<ReturnType<typeof useAudioTranscriptionModels>['openSelected']>(async () => ({ modelId: 'fixture-asr', file: new File(['model fixture'], 'recognizer.gguf') })),
    refreshing: ref(false),
    progress: computed(() => undefined),
  });
  mocks.workflow.mockReturnValue(workflow);
  mocks.preferences.mockReturnValue(preferences);
  const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const wrapper = mount(AudioTranscriptionWorkspace, { props: { source, ...(file === undefined ? {} : { file }), saveText } });
  const input = mocks.workflow.mock.calls[0]?.[0];
  if (input === undefined) {
    throw new Error('Workspace did not create its transcription workflow');
  }
  return {
    wrapper,
    input,
    phase,
    state,
    provisional,
    workflow,
    clipboardError,
    preferences,
    saving,
    writeText,
    [Symbol.dispose]() {
      wrapper.unmount();
      if (clipboardDescriptor === undefined) {
        Reflect.deleteProperty(navigator, 'clipboard');
      } else {
        Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
      }
    },
  };
}

beforeEach(async () => {
  vi.resetAllMocks();
  await ensureAllStringsForTest({ locale: 'en' });
});

describe('Audio transcription workspace workflow bindings', () => {
  it('defaults to automatic language detection and forwards an explicit language choice', async () => {
    using value = fixture({ source: 'microphone', phase: 'idle' });
    expect(value.input.language.value).toBeUndefined();
    await value.wrapper.get('select').setValue('en');
    expect(value.input.language.value).toBe('en');
  });

  it('shows a disabled floating-window button when the browser has no Document PiP API', () => {
    using value = fixture({ source: 'microphone', phase: 'idle' });
    const button = value.wrapper.get('[data-testid="audio-transcription-open-floating"]');
    expect(button.attributes('disabled')).toBeDefined();
    expect(button.attributes('title')).toBe('The floating window is unavailable in this browser.');
  });

  it('shows a waveform on the action button and expands it for a received signal', async () => {
    using value = fixture({ source: 'microphone', phase: 'recording' });
    const button = value.wrapper.get('[data-testid="audio-transcription-input-toggle"]');
    const activity = button.get<SVGElement>('[data-testid="audio-transcription-microphone-activity"]');
    const restingScale = Number(activity.element.style.getPropertyValue('--mic-waveform-scale'));
    expect(restingScale).toBeGreaterThan(0);
    expect(restingScale).toBeLessThan(1);
    expect(button.attributes('aria-description')).toBe('Microphone active');
    value.state.value = { ...value.state.value, microphoneLevel: 0.002 };
    await nextTick();
    expect(Number(activity.element.style.getPropertyValue('--mic-waveform-scale'))).toBe(restingScale);
    value.state.value = { ...value.state.value, microphoneLevel: 0.1 };
    await nextTick();
    expect(Number(activity.element.style.getPropertyValue('--mic-waveform-scale'))).toBeGreaterThan(restingScale);
    value.phase.value = 'paused';
    await nextTick();
    expect(button.find('[data-testid="audio-transcription-microphone-activity"]').exists()).toBe(false);
  });

  it('saves a valid microphone segment length and restores the field after an invalid entry', async () => {
    using value = fixture({ source: 'microphone', phase: 'idle' });
    const input = value.wrapper.get<HTMLInputElement>('[data-testid="audio-transcription-segment-length"]');
    expect(input.element.valueAsNumber).toBe(transcriptionRegionSeconds);
    await input.setValue(90);
    expect(input.element.valueAsNumber).toBe(transcriptionRegionSeconds);
    expect(value.preferences.updateMicrophoneSegmentMaxSeconds).not.toHaveBeenCalled();
    await input.setValue(20);
    expect(value.preferences.updateMicrophoneSegmentMaxSeconds).toHaveBeenCalledExactlyOnceWith({ seconds: 20 });
  });

  it('keeps progress and clipboard warnings in the existing editor status row', async () => {
    using value = fixture({ source: 'microphone', phase: 'idle' });
    const status = value.wrapper.get('[data-testid="audio-transcription-editor-status"]');
    const editor = value.wrapper.get('[data-testid="audio-transcription-editor"]').element;
    expect(status.find('[data-testid="audio-transcription-preparation"]').exists()).toBe(false);
    value.phase.value = 'preparing';
    value.clipboardError.value = 'interaction';
    await nextTick();
    expect(status.find('[data-testid="audio-transcription-preparation"]').exists()).toBe(true);
    expect(status.get('[data-testid="audio-transcription-copy-status"]').text()).toContain('Click or tap');
    expect(value.wrapper.get('[data-testid="audio-transcription-editor"]').element).toBe(editor);
  });

  it('shares editing and clearing the transcript with a floating document', async () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const pip = frame.contentWindow;
    if (pip === null) {
      throw new Error('Missing test document');
    }
    const api = { requestWindow: vi.fn(async () => pip) };
    vi.stubGlobal('documentPictureInPicture', api);
    using cleanup = {
      [Symbol.dispose]() {
        vi.unstubAllGlobals();
        frame.remove();
      },
    };
    using value = fixture({ source: 'microphone', phase: 'recording' });
    const editor = value.wrapper.get<HTMLTextAreaElement>('[data-testid="audio-transcription-editor"]');
    await editor.setValue('Shared transcript');
    await value.wrapper.get('[data-testid="audio-transcription-open-floating"]').trigger('click');
    await flushPromises();
    expect(api.requestWindow).toHaveBeenCalledOnce();
    const pane = pip.document.querySelector('[data-testid="audio-transcription-floating"]');
    expect(pane?.textContent).toContain('Naidan');
    expect(pane?.querySelector('[data-testid="audio-transcription-floating-input-toggle"] [data-testid="audio-transcription-microphone-activity"]')).not.toBeNull();
    const floatingEditor = pane?.querySelector<HTMLTextAreaElement>('[data-testid="audio-transcription-floating-editor"]');
    expect(floatingEditor?.value).toBe('Shared transcript');
    if (floatingEditor === undefined || floatingEditor === null) {
      throw new Error('Missing floating editor');
    }
    floatingEditor.value = 'Edited in the floating window';
    floatingEditor.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    expect(editor.element.value).toBe('Edited in the floating window');
    const clear = pane?.querySelector<HTMLButtonElement>('[data-testid="audio-transcription-floating-clear"]');
    clear?.click();
    await nextTick();
    expect(value.workflow.clearText).toHaveBeenCalledOnce();
    expect(value.workflow.stop).not.toHaveBeenCalled();
    expect(editor.element.value).toBe('');
    expect(floatingEditor.value).toBe('');
    pip.dispatchEvent(new Event('pagehide'));
    await nextTick();
    expect(pip.document.querySelector('[data-testid="audio-transcription-floating"]')).toBeNull();
    expect(value.workflow.stop).not.toHaveBeenCalled();
    void cleanup;
  });

  it.each([
    { phase: 'idle', action: 'start' },
    { phase: 'recording', action: 'stop' },
    { phase: 'paused', action: 'stop' },
    { phase: 'preparing', action: 'cancelPreparation' },
    { phase: 'finishing', action: 'cancelPreparation' },
  ] as const)('routes the microphone action in $phase to $action', async ({ phase, action }) => {
    using value = fixture({ source: 'microphone', phase });
    await value.wrapper.get('[data-testid="audio-transcription-input-toggle"]').trigger('click');
    expect(value.workflow[action]).toHaveBeenCalledExactlyOnceWith();
    for (const other of ['start', 'stop', 'cancelPreparation'] as const) {
      if (other !== action) {
        expect(value.workflow[other]).not.toHaveBeenCalled();
      }
    }
  });

  it.each(['recording', 'paused'] as const)('delegates pause or resume while %s', async phase => {
    using value = fixture({ source: 'microphone', phase });
    const button = value.wrapper.get('[data-testid="audio-transcription-input-pause"]');
    expect(button.attributes('disabled')).toBeUndefined();
    await button.trigger('click');
    expect(value.workflow.pauseOrResume).toHaveBeenCalledExactlyOnceWith();
    expect(value.workflow.stop).not.toHaveBeenCalled();
  });

  it('keeps pause unavailable outside active microphone input', async () => {
    using value = fixture({ source: 'microphone', phase: 'idle' });
    for (const phase of ['idle', 'preparing', 'finishing'] as const) {
      value.phase.value = phase;
      await nextTick();
      const button = value.wrapper.get('[data-testid="audio-transcription-input-pause"]');
      expect(button.attributes('disabled')).toBeDefined();
      expect(button.attributes('aria-hidden')).toBe('true');
      await button.trigger('click');
    }
    expect(value.workflow.pauseOrResume).not.toHaveBeenCalled();
  });

  it('passes the selected source File to transcription without starting microphone input', async () => {
    using value = fixture({ source: 'file', phase: 'idle' });
    expect(value.wrapper.find('[data-testid="audio-transcription-file-run"]').exists()).toBe(false);
    const file = new File(['audio fixture'], 'recording.wav', { type: 'audio/wav' });
    const input = value.wrapper.get<HTMLInputElement>('input[type="file"]');
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] });
    await input.trigger('change');
    await value.wrapper.get('[data-testid="audio-transcription-file-run"]').trigger('click');
    expect(value.workflow.transcribeFile).toHaveBeenCalledExactlyOnceWith({ file });
    expect(vi.mocked(value.workflow.transcribeFile).mock.calls[0]?.[0].file).toBe(file);
    expect(value.workflow.start).not.toHaveBeenCalled();
  });

  it('opens the explorer file ready to transcribe and waits for the user to start', async () => {
    const file = new File(['audio fixture'], 'explorer-recording.wav', { type: 'audio/wav' });
    using value = fixture({ source: 'file', phase: 'idle', file });
    expect(value.wrapper.get('[data-testid="audio-transcription-file-name"]').text()).toBe(file.name);
    expect(value.wrapper.find('input[type="file"]').exists()).toBe(false);
    expect(value.workflow.transcribeFile).not.toHaveBeenCalled();
    await value.wrapper.get('[data-testid="audio-transcription-file-run"]').trigger('click');
    expect(value.workflow.transcribeFile).toHaveBeenCalledExactlyOnceWith({ file });
    expect(value.workflow.start).not.toHaveBeenCalled();
  });

  it('saves the current edited text without the provisional recognition and waits for the save', async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const saveText = vi.fn(() => promise);
    using value = fixture({ source: 'file', phase: 'idle', saveText });
    const button = value.wrapper.get('[data-testid="audio-transcription-save"]');
    expect(button.attributes('disabled')).toBeDefined();
    await value.wrapper.get('[data-testid="audio-transcription-editor"]').setValue('Edited text');
    value.provisional.value = 'Provisional recognition';
    await nextTick();
    await button.trigger('click');
    expect(button.attributes('disabled')).toBeDefined();
    expect(saveText).toHaveBeenCalledExactlyOnceWith({ text: 'Edited text' });
    resolve();
    await flushPromises();
    expect(button.attributes('disabled')).toBeUndefined();
  });

  it('keeps edited text available for a retry when the save fails', async () => {
    const saveText = vi.fn<({ text }: { text: string }) => Promise<void>>().mockRejectedValueOnce(new Error('Save failed')).mockResolvedValue(undefined);
    using value = fixture({ source: 'file', phase: 'idle', saveText });
    const editor = value.wrapper.get<HTMLTextAreaElement>('[data-testid="audio-transcription-editor"]');
    await editor.setValue('Edited text');
    const button = value.wrapper.get('[data-testid="audio-transcription-save"]');
    await button.trigger('click');
    await flushPromises();
    expect(value.wrapper.get('[data-testid="audio-transcription-save-error"]').text()).toBe('Could not save the transcript.');
    expect(editor.element.value).toBe('Edited text');
    await button.trigger('click');
    await flushPromises();
    expect(value.wrapper.find('[data-testid="audio-transcription-save-error"]').exists()).toBe(false);
    expect(saveText).toHaveBeenCalledTimes(2);
  });

  it.each(['preparing', 'finishing'] as const)('keeps file cancellation available after removing the selected File during %s', async phase => {
    using value = fixture({ source: 'file', phase: 'idle' });
    const file = new File(['audio fixture'], 'recording.wav', { type: 'audio/wav' });
    const input = value.wrapper.get<HTMLInputElement>('input[type="file"]');
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] });
    await input.trigger('change');
    value.phase.value = phase;
    await nextTick();
    await value.wrapper.get('[data-testid="audio-transcription-remove-file"]').trigger('click');
    expect(value.wrapper.find('[data-testid="audio-transcription-choose-file"]').exists()).toBe(true);
    const cancel = value.wrapper.get('[data-testid="audio-transcription-file-run"]');
    await cancel.trigger('click');
    expect(value.workflow.cancelPreparation).toHaveBeenCalledExactlyOnceWith();
    expect(value.workflow.transcribeFile).not.toHaveBeenCalled();
  });

  it('binds manual edits to the workflow text ref while rendering provisional text separately', async () => {
    using value = fixture({ source: 'microphone', phase: 'recording' });
    const editor = value.wrapper.get<HTMLTextAreaElement>('[data-testid="audio-transcription-editor"]');
    await editor.setValue('Edited document');
    expect(value.input.text.value).toBe('Edited document');
    value.provisional.value = 'Unconfirmed recognition';
    await nextTick();
    expect(value.wrapper.get('[data-testid="audio-transcription-provisional"]').text()).toBe('Unconfirmed recognition');
    expect(editor.element.value).toBe('Edited document');
    value.provisional.value = '';
    await nextTick();
    expect(value.wrapper.find('[data-testid="audio-transcription-provisional"]').exists()).toBe(false);
    expect(editor.element.value).toBe('Edited document');
  });

  it('saves automatic-copy toggles without copying manual editor input itself', async () => {
    using value = fixture({ source: 'microphone', phase: 'recording' });
    const toggle = value.wrapper.get('button[role="switch"]');
    await toggle.trigger('click');
    expect(value.preferences.updateAutoCopy).toHaveBeenCalledExactlyOnceWith({ value: 'enabled' });
    expect(value.workflow.copyOnEnable).toHaveBeenCalledOnce();
    expect(value.input.autoCopy.value).toBe('enabled');
    expect(toggle.attributes('aria-checked')).toBe('true');
    await value.wrapper.get('[data-testid="audio-transcription-editor"]').setValue('Manually edited text');
    await flushPromises();
    expect(value.input.text.value).toBe('Manually edited text');
    expect(value.writeText).not.toHaveBeenCalled();
    await toggle.trigger('click');
    expect(value.preferences.updateAutoCopy).toHaveBeenLastCalledWith({ value: 'disabled' });
  });

  it('does not submit another preference update while saving', async () => {
    using value = fixture({ source: 'microphone', phase: 'idle' });
    value.saving.value = true;
    await nextTick();
    const toggle = value.wrapper.get('button[role="switch"]');
    expect(toggle.attributes('disabled')).toBeDefined();
    await toggle.trigger('click');
    expect(value.preferences.updateAutoCopy).not.toHaveBeenCalled();
  });

  it('manually copies the editor document without including provisional recognition', async () => {
    using value = fixture({ source: 'microphone', phase: 'recording' });
    const button = value.wrapper.get('[data-testid="audio-transcription-copy"]');
    expect(button.attributes('disabled')).toBeDefined();
    await value.wrapper.get('[data-testid="audio-transcription-editor"]').setValue('Edited document');
    value.provisional.value = 'Unconfirmed recognition';
    await nextTick();
    await button.trigger('click');
    await flushPromises();
    expect(value.writeText).toHaveBeenCalledExactlyOnceWith('Edited document');
  });

  it('reports when the current text has been copied in full and clears it from the separate action', async () => {
    using value = fixture({ source: 'microphone', phase: 'recording' });
    const editor = value.wrapper.get<HTMLTextAreaElement>('[data-testid="audio-transcription-editor"]');
    const status = value.wrapper.get('[data-testid="audio-transcription-full-copy-status"]');
    await editor.setValue('Hello');
    expect(status.text()).toContain('full text not copied');
    const copy = value.wrapper.get('[data-testid="audio-transcription-copy"]');
    await copy.trigger('click');
    await flushPromises();
    expect(status.text()).toBe('5 characters copied in full');
    await value.wrapper.get('[data-testid="audio-transcription-clear"]').trigger('click');
    expect(editor.element.value).toBe('');
    expect(status.text()).toBe('');
    expect(value.workflow.stop).not.toHaveBeenCalled();
    expect(value.writeText).toHaveBeenCalledOnce();
  });
});
