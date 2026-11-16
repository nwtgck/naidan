import { onScopeDispose, shallowRef } from 'vue';
import { createSpeechRecognitionController, initialSpeechRecognitionViewState } from '@/features/speech-cpp-browser/recognition/controller';
import { createSpeechRecognitionClient } from '@/features/speech-cpp-browser/recognition/worker/client';
import { decodeLiveAudioFile } from '@/features/live-conversation/logic/audio-file';
import { openLiveCapture } from '@/features/live-conversation/logic/audio-capture';
import { createSpeechRecognitionRecording, initialSpeechRecordingState } from '@/features/live-conversation/logic/speech-recognition-recording';
import type { SpeechInvestigationBinding } from '@/features/speech-cpp-browser/worker/investigation-context';

export function useSpeechRecognition() {
  const state = shallowRef(initialSpeechRecognitionViewState());
  const engine = createSpeechRecognitionController({
    createClient: createSpeechRecognitionClient,
    decodeFile: decodeLiveAudioFile,
    now: () => performance.now(),
    onChange({ state: next }) {
      state.value = next;
    },
  });
  const recordingState = shallowRef(initialSpeechRecordingState());
  let pendingCancellation: Promise<void> | undefined;
  let recordingAttempt: { investigation: SpeechInvestigationBinding | undefined } | undefined;
  const recorder = createSpeechRecognitionRecording({
    capture: openLiveCapture,
    now: () => performance.now(),
    onChange({ state: next }) {
      recordingState.value = next;
    },
    async onRecorded({ samples, sampleRate, file, language }) {
      const target = recordingAttempt;
      const investigation = target?.investigation;
      if (target === undefined || recordingAttempt !== target || recordingState.value.clip?.file !== file) {
        return;
      }
      await pendingCancellation;
      if (target === undefined || recordingAttempt !== target || recordingState.value.clip?.file !== file) {
        return;
      }
      // A model-free recording still leaves a reusable source File for later.
      const phase = engine.getState().runtime.phase;
      try {
        switch (phase) {
        case 'ready': await engine.runAudio({ samples, sampleRate, inputName: file.name, language, ...(investigation === undefined ? {} : { investigation }) });
          break;
        case 'unloaded': case 'loading_model': case 'recognizing': case 'cancelling': case 'failed': case 'disposed': break;
        default: {
          const exhaustive: never = phase;
          throw new Error(String(exhaustive));
        }
        }
      } finally {
        if (recordingAttempt === target) {
          recordingAttempt = undefined;
        }
      }
    },
  });
  const controller = {
    ...engine,
    async load({ file, investigation }: { file: File, investigation?: SpeechInvestigationBinding }): Promise<void> {
      // Capture/source ownership is independent of the resident model. Keep
      // ongoing capture eligible, but invalidate old pending automatic runs.
      const phase = recordingState.value.phase;
      switch (phase) {
      case 'opening': case 'recording': recordingAttempt = { investigation: undefined };
        break;
      case 'idle': case 'stopping': case 'ready': case 'failed': recordingAttempt = undefined;
        break;
      default: {
        const exhaustive: never = phase;
        throw new Error(String(exhaustive));
      }
      }
      await engine.load({ file, ...(investigation === undefined ? {} : { investigation }) });
    },
    async runFile({ file, language, investigation }: { file: File, language: string | undefined, investigation?: SpeechInvestigationBinding }): Promise<void> {
      recordingAttempt = undefined;
      await recorder.discard();
      await engine.runFile({ file, language, ...(investigation === undefined ? {} : { investigation }) });
    },
    async runAudio({ samples, sampleRate, inputName, language, investigation }: { samples: Float32Array<ArrayBuffer>, sampleRate: number, inputName: string, language: string | undefined, investigation?: SpeechInvestigationBinding }): Promise<void> {
      recordingAttempt = undefined;
      await recorder.discard();
      await engine.runAudio({ samples, sampleRate, inputName, language, ...(investigation === undefined ? {} : { investigation }) });
    },
    async cancel(): Promise<void> {
      recordingAttempt = undefined;
      await recorder.discard();
      await engine.cancel();
    },
    async clearRun(): Promise<void> {
      recordingAttempt = undefined;
      await recorder.discard();
      await engine.clearRun();
    },
    async release(): Promise<void> {
      recordingAttempt = undefined;
      await recorder.discard();
      await engine.release();
    },
    async dispose(): Promise<void> {
      recordingAttempt = undefined;
      await recorder.dispose();
      await engine.dispose();
    },
  };
  const recording = {
    async start({ language, investigation }: { language: string | undefined, investigation?: SpeechInvestigationBinding }): Promise<void> {
      recordingAttempt = { investigation };
      const cancelled = engine.cancelRun();
      pendingCancellation = cancelled;
      // Open capture in the user gesture, without awaiting native cancellation.
      try {
        await recorder.start({ language });
        await cancelled;
      } finally {
        if (pendingCancellation === cancelled) {
          pendingCancellation = undefined;
        }
      }
    },
    stop: recorder.stop,
    async discard(): Promise<void> {
      recordingAttempt = undefined;
      await recorder.discard();
      await engine.cancelRun();
    },
  };
  state.value = engine.getState();
  onScopeDispose(() => {
    void controller.dispose().catch(() => {});
  });
  return { state, controller, recordingState, recording, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}

export const TEST_ONLY = {
};
