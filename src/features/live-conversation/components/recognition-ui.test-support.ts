import { vi } from 'vitest';
import { createSpeechRecognitionController } from '@/features/speech-cpp-browser/recognition/controller';
import { initialSpeechRecognitionState, type SpeechRecognitionClient, type SpeechRecognitionObservers, type SpeechRecognitionState } from '@/features/speech-cpp-browser/recognition/types';
import { createSpeechRecognitionRecording } from '@/features/live-conversation/logic/speech-recognition-recording';
import type { SpeechInvestigationBinding, SpeechInvestigationContext } from '@/features/speech-cpp-browser/worker/investigation-context';
import type { SpeechInvestigationEvent } from '@/features/speech-cpp-browser/investigation/types';
import type { openLiveCapture } from '@/features/live-conversation/logic/audio-capture';

export function createRecognitionUiFixture() {
  let runtime = initialSpeechRecognitionState();
  let observers: SpeechRecognitionObservers | undefined;
  let recordingInvestigation: SpeechInvestigationBinding | undefined;
  function change({ state }: { state: Partial<SpeechRecognitionState> }): void {
    runtime = { ...runtime, ...state };
    observers?.onState({ state: runtime });
  }
  const client: SpeechRecognitionClient = {
    capability: { kind: 'available' },
    getState: () => runtime,
    loadModel: vi.fn(async () => {
      change({ state: { phase: 'ready', model: { name: 'ASR test model', bytes: 1, architecture: 'qwen3-asr', task: 'recognition', sampleRate: 16000, requiredVersion: 'test', languages: ['ja', 'en'], languageSelection: 'supported' }, failure: undefined } });
    }),
    transcribe: vi.fn<SpeechRecognitionClient['transcribe']>(async () => {
      change({ state: { phase: 'recognizing' } });
      change({ state: { phase: 'ready' } });
      return { text: 'こんにちは。', languages: ['ja'], status: 'complete' };
    }),
    cancel: vi.fn(async () => {}),
    releaseModel: vi.fn(async () => {
      change({ state: { phase: 'unloaded', model: undefined, loadProgress: undefined } });
    }),
    dispose: vi.fn(async () => {
      change({ state: { phase: 'disposed', model: undefined } });
    }),
  };
  const decodeFile = vi.fn<Parameters<typeof createSpeechRecognitionController>[0]['decodeFile']>(async () => new Float32Array([0.25, -0.25]));
  const onChange = vi.fn<Parameters<typeof createSpeechRecognitionController>[0]['onChange']>();
  const controller = createSpeechRecognitionController({
    createClient({ observers: next }) {
      observers = next;
      return client;
    },
    decodeFile,
    now: () => performance.now(),
    onChange,
  });
  const finishCapture = vi.fn(async () => {});
  const capture = vi.fn<typeof openLiveCapture>(async () => ({ finish: finishCapture }));
  const onRecordingChange = vi.fn<Parameters<typeof createSpeechRecognitionRecording>[0]['onChange']>();
  const recorder = createSpeechRecognitionRecording({
    capture,
    now: () => performance.now(),
    onChange: onRecordingChange,
    async onRecorded({ samples, sampleRate, file, language }) {
      const phase = controller.getState().runtime.phase;
      switch (phase) {
      case 'ready': await controller.runAudio({ samples, sampleRate, inputName: file.name, language, ...(recordingInvestigation ? { investigation: recordingInvestigation } : {}) });
        break;
      case 'unloaded': case 'loading_model': case 'recognizing': case 'cancelling': case 'failed': case 'disposed': break;
      default: {
        const exhaustive: never = phase;
        throw new Error(String(exhaustive));
      }
      }
    },
  });
  const recording = {
    start({ language, investigation }: { language: string | undefined, investigation?: SpeechInvestigationBinding }) {
      recordingInvestigation = investigation;
      return recorder.start({ language });
    },
    stop: recorder.stop,
    discard: recorder.discard,
  };
  return {
    controller,
    client,
    decodeFile,
    change,
    onChange,
    recorder,
    recording,
    onRecordingChange,
    capture,
    observe({ context, event }: { context: SpeechInvestigationContext, event: SpeechInvestigationEvent }): void {
      observers?.onInvestigation?.({ context, event });
    },
    pcm({ samples }: { samples: Float32Array<ArrayBuffer> }) {
      capture.mock.calls.at(-1)?.[0].onPcm({ pcm: samples });
    },
  };
}

export const TEST_ONLY = {
};
