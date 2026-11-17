import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, nextTick, ref, shallowRef } from 'vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { useAudioTranscriptionModels } from '@/features/audio-transcription/composables/useAudioTranscriptionModels';
import type { useAudioTranscriptionWorkflow } from '@/features/audio-transcription/composables/useAudioTranscriptionWorkflow';
import type { useAudioTranscriptionPreferences } from '@/features/audio-transcription/composables/useAudioTranscriptionPreferences';
import { initialAudioTranscriptionState } from '@/features/audio-transcription/logic/transcription-controller';
import AudioTranscriptionWorkspace from './AudioTranscriptionWorkspace.vue';

type Workflow = ReturnType<typeof useAudioTranscriptionWorkflow>;
type Phase = Workflow['phase']['value'];
type Preferences = ReturnType<typeof useAudioTranscriptionPreferences>;
// The selector's own tests exercise its slots and model-management dependencies.
type WorkspaceModels = Pick<ReturnType<typeof useAudioTranscriptionModels>, 'models' | 'selectedId' | 'selectedQuantizationId' | 'openSelected' | 'refreshing' | 'progress'>;

const mocks = vi.hoisted(() => ({
  models: vi.fn<() => WorkspaceModels>(),
  workflow: vi.fn<typeof useAudioTranscriptionWorkflow>(),
  preferences: vi.fn<typeof useAudioTranscriptionPreferences>(),
}));
vi.mock('@/features/audio-transcription/composables/useAudioTranscriptionModels', () => ({ useAudioTranscriptionModels: mocks.models }));
vi.mock('@/features/audio-transcription/composables/useAudioTranscriptionWorkflow', () => ({ useAudioTranscriptionWorkflow: mocks.workflow }));
vi.mock('@/features/audio-transcription/composables/useAudioTranscriptionPreferences', () => ({ useAudioTranscriptionPreferences: mocks.preferences }));
vi.mock('@/components/ModelSelectorV2.vue', () => ({ default: { name: 'ModelSelectorV2', inheritAttrs: false, render: () => null } }));
vi.mock('@/features/audio-transcription/components/AudioTranscriptionModelSources.vue', () => ({ default: { name: 'AudioTranscriptionModelSources', inheritAttrs: false, render: () => null } }));
vi.mock('@/features/audio-transcription/components/AudioTranscriptionModelDetails.vue', () => ({ default: { name: 'AudioTranscriptionModelDetails', inheritAttrs: false, render: () => null } }));
vi.mock('@/features/llama-cpp-browser/components/LlamaCppBrowserDownloadDestination.vue', () => ({ default: { name: 'LlamaCppBrowserDownloadDestination', inheritAttrs: false, render: () => null } }));
vi.mock('@/features/live-conversation/components/LiveModelLoadProgress.vue', () => ({ default: { name: 'LiveModelLoadProgress', inheritAttrs: false, render: () => null } }));
vi.mock('@/features/llama-cpp-browser/components/LlamaCppBrowserDownloadProgress.vue', () => ({ default: { name: 'LlamaCppBrowserDownloadProgress', inheritAttrs: false, render: () => null } }));

function fixture({ source, phase: initialPhase }: { source: 'microphone' | 'file', phase: Phase }) {
  const phase = ref<Phase>(initialPhase);
  const provisional = ref('');
  const state = shallowRef(initialAudioTranscriptionState());
  const workflow: Workflow = {
    phase: computed(() => phase.value),
    pending: computed(() => phase.value === 'preparing' || phase.value === 'finishing'),
    state,
    runtimeState: computed(() => state.value.runtime),
    provisionalText: computed(() => provisional.value),
    failureDetails: computed(() => undefined),
    clipboardError: computed(() => undefined),
    clearClipboardError: vi.fn<Workflow['clearClipboardError']>(),
    start: vi.fn<Workflow['start']>(async () => {}),
    stop: vi.fn<Workflow['stop']>(async () => {}),
    pauseOrResume: vi.fn<Workflow['pauseOrResume']>(async () => {}),
    transcribeFile: vi.fn<Workflow['transcribeFile']>(async () => {}),
    cancelPreparation: vi.fn<Workflow['cancelPreparation']>(async () => {}),
    TEST_ONLY: {},
  };
  const autoCopy = ref<'enabled' | 'disabled'>('disabled');
  const saving = ref(false);
  const preferences: Preferences = {
    autoCopy: computed(() => autoCopy.value),
    saving,
    updateAutoCopy: vi.fn<Preferences['updateAutoCopy']>(async ({ value }) => {
      autoCopy.value = value;
    }),
    TEST_ONLY: {},
  };
  mocks.models.mockReturnValue({
    models: computed(() => []),
    selectedId: computed(() => undefined),
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
  const wrapper = mount(AudioTranscriptionWorkspace, { props: { source } });
  const input = mocks.workflow.mock.calls[0]?.[0];
  if (input === undefined) {
    throw new Error('Workspace did not create its transcription workflow');
  }
  return {
    wrapper,
    input,
    phase,
    provisional,
    workflow,
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
});
