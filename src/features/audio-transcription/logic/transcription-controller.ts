import { createSpeechRecognitionController } from '@/features/speech-cpp-browser/recognition/controller';
import { initialSpeechRecognitionState, type SpeechRecognitionState } from '@/features/speech-cpp-browser/recognition/types';
import { SpeechRuntimeError, speechFailure, speechError } from '@/features/speech-cpp-browser/types';
import type { openLiveCapture, LiveCapture } from '@/features/live-conversation/logic/audio-capture';
import { createContinuousAudioTranscription, initialContinuousAudioTranscriptionState, type ContinuousAudioTranscriptionState } from './continuous-transcription';

export type AudioTranscriptionState = ContinuousAudioTranscriptionState & {
  runtime: SpeechRecognitionState,
  phase: 'idle' | 'opening' | 'recording' | 'finishing' | 'paused' | 'complete' | 'failed',
};

export function initialAudioTranscriptionState(): AudioTranscriptionState {
  return { ...initialContinuousAudioTranscriptionState(), runtime: initialSpeechRecognitionState(), phase: 'idle' };
}

/** Own one resident recognizer across microphone/file runs. Nothing here is
 * persisted: decoded PCM, microphone regions and text belong to this owner. */
export function createAudioTranscriptionController({ createClient, decodeFile, capture, now, onChange }: {
  createClient: Parameters<typeof createSpeechRecognitionController>[0]['createClient'],
  decodeFile: Parameters<typeof createSpeechRecognitionController>[0]['decodeFile'],
  capture: typeof openLiveCapture,
  now: () => number,
  onChange: ({ state }: { state: AudioTranscriptionState }) => void,
}) {
  type Recording = { lifetime: AbortController, capture: LiveCapture | undefined, scheduler: ReturnType<typeof createContinuousAudioTranscription>, stopping: Promise<void> | undefined };
  let state = initialAudioTranscriptionState();
  let disposed = false, generation = 0, pendingCommands = 0;
  let recording: Recording | undefined;
  function publish({ change }: { change: Partial<AudioTranscriptionState> }): void {
    state = { ...state, ...change };
    if (!disposed) {
      onChange({ state });
    }
  }
  const engine = createSpeechRecognitionController({
    createClient,
    decodeFile,
    now,
    onChange({ state: next }) {
      publish({ change: { runtime: next.runtime } });
    },
  });
  state = { ...state, runtime: engine.getState().runtime };

  function fail({ target, error }: { target: Recording, error: unknown }): void {
    if (recording !== target) {
      return;
    }
    target.lifetime.abort();
    void target.capture?.finish({ action: 'discard' }).catch(() => {});
    // Invalidate scheduler callbacks before cancelling the native request.
    target.scheduler.discard();
    recording = undefined;
    generation++;
    publish({ change: { phase: 'failed', failure: speechFailure({ error }), bufferedSeconds: 0, pendingRegionCount: 0 } });
    void engine.cancelRun().catch(() => {});
  }
  async function finish({ phase }: { phase: 'paused' | 'complete' }): Promise<void> {
    const target = recording;
    if (target === undefined) {
      return;
    }
    if (target.stopping !== undefined) {
      await target.stopping;
      return;
    }
    target.scheduler.prepareFinish();
    publish({ change: { phase: 'finishing' } });
    target.stopping = (async () => {
      try {
        if (target.capture === undefined) {
          target.lifetime.abort();
        } else {
          // Accept the worklet and resampler's final PCM before closing the
          // final region. Ordinary stop never cancels an in-flight ASR run.
          await target.capture.finish({ action: 'send' });
        }
        if (recording !== target) {
          return;
        }
        await target.scheduler.finish();
        if (recording !== target) {
          return;
        }
        recording = undefined;
        target.lifetime.abort();
        const final = target.scheduler.getState();
        target.scheduler.discard();
        publish({ change: { ...final, phase: final.failure === undefined ? phase : 'failed' } });
      } catch (error) {
        fail({ target, error });
      }
    })();
    await target.stopping;
  }
  async function discard(): Promise<number> {
    pendingCommands++;
    const attempt = ++generation;
    const previous = recording;
    recording = undefined;
    previous?.scheduler.discard();
    previous?.lifetime.abort();
    try {
      if (previous?.capture !== undefined) {
        await previous.capture.finish({ action: 'discard' }).catch(() => {});
      }
      // Starts stay disabled throughout cleanup, so this cancellation can
      // never target a subsequent microphone session.
      if (generation === attempt) {
        await engine.cancelRun();
      }
      if (generation === attempt) {
        publish({ change: { ...initialContinuousAudioTranscriptionState(), phase: 'idle' } });
      }
      return attempt;
    } finally {
      pendingCommands--;
    }
  }
  async function start({ language, maxRegionSeconds }: { language: string | undefined, maxRegionSeconds: number }): Promise<void> {
    if (disposed || pendingCommands > 0 || recording !== undefined || state.phase === 'finishing') {
      return;
    }
    const model = engine.getState().runtime.model;
    if (engine.getState().runtime.phase !== 'ready' || model === undefined) {
      publish({ change: { phase: 'failed', failure: speechFailure({ error: speechError({ code: 'invalid_state', message: 'Load a recognition model before starting voice input' }) }) } });
      return;
    }
    const attempt = ++generation;
    const target: Recording = {
      lifetime: new AbortController(),
      capture: undefined,
      stopping: undefined,
      scheduler: createContinuousAudioTranscription({
        sampleRate: model.sampleRate,
        language,
        maxRegionSeconds,
        initial: { confirmedText: state.confirmedText, confirmedRevision: state.confirmedRevision, recordedSeconds: state.recordedSeconds },
        recognize: ({ samples, sampleRate, language }) => engine.runAudio({ samples, sampleRate, language, inputName: 'microphone' }),
        onChange({ state: next }) {
          if (recording !== target || generation !== attempt) {
            return;
          }
          publish({ change: next });
          if (next.failure !== undefined) {
            fail({ target, error: new SpeechRuntimeError({ details: next.failure }) });
          }
        },
        onStopRequested() {
          if (recording === target && generation === attempt) {
            void finish({ phase: 'complete' });
          }
        },
      }),
    };
    recording = target;
    publish({ change: { phase: 'opening', failure: undefined, stopReason: undefined, provisionalText: '', pendingRegionCount: 0, bufferedSeconds: 0, microphoneLevel: 0 } });
    try {
      const opening = capture({
        sampleRate: model.sampleRate,
        signal: target.lifetime.signal,
        onPcm({ pcm }) {
          if (recording === target && generation === attempt) {
            target.scheduler.append({ pcm });
          }
        },
        onError: ({ error }) => fail({ target, error }),
      });
      void opening.then(value => {
        if (recording !== target || target.lifetime.signal.aborted) {
          void value.finish({ action: 'discard' }).catch(() => {});
        }
      }, () => {});
      const opened = await new Promise<LiveCapture>((resolve, reject) => {
        const aborted = () => reject(target.lifetime.signal.reason);
        target.lifetime.signal.addEventListener('abort', aborted, { once: true });
        if (target.lifetime.signal.aborted) {
          aborted();
        }
        void opening.then(resolve, reject).finally(() => target.lifetime.signal.removeEventListener('abort', aborted));
      });
      if (recording !== target || target.lifetime.signal.aborted) {
        return;
      }
      target.capture = opened;
      if (target.stopping === undefined) {
        publish({ change: { phase: 'recording' } });
      }
    } catch (error) {
      // A normal stop/discard may abort pending microphone permission.
      if (recording === target && target.stopping === undefined) {
        fail({ target, error });
      }
    }
  }
  return {
    capability: engine.capability,
    getState: () => state,
    start,
    resume: start,
    stop: () => finish({ phase: 'complete' }),
    pause: () => finish({ phase: 'paused' }),
    clearText(): void {
      if (recording !== undefined) {
        recording.scheduler.clearText();
      } else {
        publish({ change: { confirmedText: '', confirmedRevision: 0, provisionalText: '' } });
      }
    },
    async discard(): Promise<void> {
      await discard();
    },
    async load({ file }: { file: File }): Promise<void> {
      pendingCommands++;
      try {
        const attempt = await discard();
        if (disposed || generation !== attempt) {
          return;
        }
        await engine.load({ file });
        if (generation === attempt) {
          publish({ change: { failure: engine.getState().failure } });
        }
      } finally {
        pendingCommands--;
      }
    },
    async runFile({ file, language }: { file: File, language: string | undefined }): Promise<void> {
      pendingCommands++;
      try {
        const attempt = await discard();
        if (disposed || generation !== attempt) {
          return;
        }
        publish({ change: { phase: 'finishing', failure: undefined } });
        const result = await engine.runFile({ file, language });
        if (generation !== attempt || disposed) {
          return;
        }
        if (result === undefined) {
          publish({ change: { phase: 'failed', failure: speechFailure({ error: speechError({ code: 'invalid_state', message: 'Load a recognition model before transcribing a file' }) }) } });
          return;
        }
        const complete = result.status === 'complete';
        publish({
          change: {
            phase: complete ? 'complete' : 'failed',
            confirmedText: complete ? result.text : '',
            provisionalText: complete ? '' : result.text,
            confirmedRevision: complete ? 1 : 0,
            recordedSeconds: result.inputSeconds ?? 0,
            failure: result.failure ?? (complete ? undefined : speechFailure({ error: new Error(`Recognition ended with ${result.status}; the file is not fully transcribed`) })),
          },
        });
      } finally {
        pendingCommands--;
      }
    },
    async release(): Promise<void> {
      pendingCommands++;
      try {
        const attempt = await discard();
        if (generation === attempt) {
          await engine.release();
        }
      } finally {
        pendingCommands--;
      }
    },
    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      await discard();
      await engine.dispose();
    },
  };
}

export const TEST_ONLY = {
};
