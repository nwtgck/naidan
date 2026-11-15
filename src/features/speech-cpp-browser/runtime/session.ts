import { copySpeechFrame } from './audio-frame';
import { speechError, speechFailure, type SpeechDialoguePort, type SpeechModelPort, type SpeechPhase, type SpeechCompletionReason, type SpeechFailure, type SpeechStartOptions, type SpeechPushResult, type SpeechState, type SpeechLoadProgress } from '@/features/speech-cpp-browser/types';
import type { SpeechClient, SpeechObservers } from '@/features/speech-cpp-browser/worker/types';

/** One model lane. Only synchronous cancellation can bypass the lane.
 * The adapter owns C handles; this coordinator owns their ordered lifetime. */
export function createSpeechSession({ openModel, observers, maxQueuedSeconds }: {
  openModel: ({ file, signal, onProgress }: { file: File, signal: AbortSignal, onProgress: ({ progress }: { progress: SpeechLoadProgress }) => void }) => Promise<SpeechModelPort>,
  observers: SpeechObservers, maxQueuedSeconds: number,
}): SpeechClient & { waitForInput(): Promise<void> } {
  if (!Number.isFinite(maxQueuedSeconds) || maxQueuedSeconds <= 0 || maxQueuedSeconds > 10) {
    throw new RangeError('Invalid speech audio queue bound');
  }
  let phase: SpeechPhase = 'unloaded';
  let model: SpeechModelPort | undefined;
  let dialogue: SpeechDialoguePort | undefined;
  let inputSampleRate = 0, queuedSamples = 0, sequence = 0, sessionId = 0;
  let completion: SpeechCompletionReason | undefined;
  let failure: SpeechFailure | undefined;
  let loadProgress: SpeechLoadProgress | undefined;
  let callbackFailure: unknown;
  let stopMode: 'finish' | 'cancel' | undefined;
  let stopPromise: Promise<void> | undefined;
  let loadController: AbortController | undefined;
  let disposing = false;
  let lane = Promise.resolve();

  function getState(): SpeechState {
    return { phase, model: model === undefined ? undefined : { ...model.info }, queuedSamples, completion, failure, loadProgress };
  }
  function notify(): void {
    try {
      observers.onState({ state: getState() });
    } catch { /* Observers do not control native ownership. */ }
  }
  function setPhase({ value }: { value: SpeechPhase }): void {
    phase = value;
    notify();
  }
  function schedule<T>({ operation }: { operation: () => Promise<T> }): Promise<T> {
    const result = lane.then(operation);
    lane = result.then(() => undefined, () => undefined);
    return result;
  }
  async function closeDialogue(): Promise<void> {
    const current = dialogue;
    dialogue = undefined;
    if (current !== undefined) {
      try {
        await current.end();
      } finally {
        await current.release();
      }
    }
  }
  async function fail({ error }: { error: unknown }): Promise<void> {
    failure = speechFailure({ error });
    loadProgress = undefined;
    stopMode = 'cancel';
    try {
      model?.cancel();
    } catch { /* Preserve the original runtime error. */ }
    try {
      await closeDialogue();
    } catch { /* Release the model even after session cleanup failure. */ }
    const current = model;
    model = undefined;
    try {
      await current?.release();
    } catch { /* Preserve the failure that caused teardown. */ }
    setPhase({ value: 'failed' });
  }
  function requireUsable(): void {
    if (disposing || phase === 'disposed') {
      throw speechError({ code: 'invalid_state', message: 'Speech client is disposed' });
    }
  }

  async function stop({ mode }: { mode: 'finish' | 'cancel' }): Promise<void> {
    switch (mode) {
    case 'cancel': stopMode = 'cancel';
      model?.cancel();
      break;
    case 'finish': break;
    default: {
      const exhaustive: never = mode;
      throw new Error(String(exhaustive));
    }
    }
    if (stopPromise !== undefined) {
      return stopPromise;
    }
    if (phase !== 'starting' && phase !== 'running' && phase !== 'stopping') {
      await lane;
      return;
    }
    stopMode ??= mode;
    setPhase({ value: 'stopping' });
    stopPromise = schedule({
      operation: async () => {
        try {
          await closeDialogue();
          if (completion === undefined) {
            switch (stopMode) {
            case 'cancel': completion = 'cancelled';
              break;
            case 'finish': case undefined: completion = 'finished';
              break;
            default: {
              const exhaustive: never = stopMode;
              throw new Error(String(exhaustive));
            }
            }
          }
          if (failure === undefined) {
            setPhase({ value: 'completed' });
          }
        } catch (error) {
          await fail({ error });
          throw error;
        } finally {
          stopPromise = undefined;
        }
      },
    });
    return stopPromise;
  }

  async function releaseModel(): Promise<void> {
    loadController?.abort();
    await stop({ mode: 'cancel' });
    await schedule({
      operation: async () => {
        const current = model;
        model = undefined;
        try {
          await current?.release();
        } finally {
          failure = undefined;
          completion = undefined;
          loadProgress = undefined;
          setPhase({ value: disposing ? 'disposed' : 'unloaded' });
        }
      },
    });
  }

  return {
    capability: { kind: 'available' },
    waitForInput: () => lane,
    getState,
    async loadModel({ file }) {
      requireUsable();
      if (phase !== 'unloaded' && phase !== 'failed') {
        throw speechError({ code: 'invalid_state', message: 'Release the current speech model before loading another' });
      }
      failure = undefined;
      completion = undefined;
      const controller = new AbortController();
      loadController = controller;
      loadProgress = { stage: 'preparing_runtime' };
      setPhase({ value: 'loading_model' });
      await schedule({
        operation: async () => {
          try {
            const opened = await openModel({
              file,
              signal: controller.signal,
              onProgress({ progress }) {
                if (loadController === controller && !controller.signal.aborted && !disposing && phase === 'loading_model') {
                  loadProgress = progress;
                  notify();
                }
              },
            });
            if (controller.signal.aborted || disposing) {
              await opened.release();
              controller.signal.throwIfAborted();
              throw speechError({ code: 'invalid_state', message: 'Speech model load was superseded' });
            }
            model = opened;
            loadProgress = undefined;
            setPhase({ value: 'ready' });
          } catch (error) {
            if (!controller.signal.aborted) {
              await fail({ error });
            }
            throw error;
          } finally {
            if (loadController === controller) {
              loadController = undefined;
            }
          }
        },
      });
    },
    async start({ options }: { options: SpeechStartOptions }) {
      requireUsable();
      if (model === undefined || (phase !== 'ready' && phase !== 'completed')) {
        throw speechError({ code: 'invalid_state', message: 'Load a speech model before starting a session' });
      }
      if (!Number.isSafeInteger(options.inputSampleRate) || options.inputSampleRate < 8000 || options.inputSampleRate > 192000 || !Number.isFinite(options.maxSeconds) || options.maxSeconds <= 0 || options.maxSeconds > 3600 || !options.language.trim()) {
        throw speechError({ code: 'invalid_audio', message: 'Invalid speech session audio rate or duration' });
      }
      if (options.seed !== undefined && (!Number.isSafeInteger(options.seed) || options.seed < 0)) {
        throw speechError({ code: 'invalid_state', message: 'Speech seed must be a safe non-negative integer' });
      }
      const current = model;
      const id = ++sessionId;
      inputSampleRate = options.inputSampleRate;
      sequence = 0;
      completion = undefined;
      stopMode = undefined;
      callbackFailure = undefined;
      setPhase({ value: 'starting' });
      await schedule({
        operation: async () => {
          try {
            switch (stopMode) {
            case 'cancel': return;
            case 'finish': case undefined: break;
            default: {
              const exhaustive: never = stopMode;
              throw new Error(String(exhaustive));
            }
            }
            dialogue = await current.start({
              options,
              onFrame({ samples, text }) {
                if (disposing || stopMode === 'cancel' || id !== sessionId || callbackFailure !== undefined) {
                  return 'stop';
                }
                try {
                  const frame = copySpeechFrame({ samples, text, sequence: sequence++ });
                  try {
                    observers.onFrame({ frame });
                  } catch { /* Observers are independent of the model lane. */ }
                  return 'continue';
                } catch (error) {
                  callbackFailure = error;
                  return 'stop';
                }
              },
            });
            if (callbackFailure !== undefined) {
              throw callbackFailure;
            }
            if (stopMode === undefined) {
              setPhase({ value: 'running' });
            }
          } catch (error) {
            await fail({ error });
            throw error;
          }
        },
      });
    },
    push({ samples, sampleRate }): SpeechPushResult {
      requireUsable();
      switch (phase) {
      case 'running': break;
      case 'unloaded': case 'loading_model': case 'ready': case 'starting': case 'stopping': case 'completed': case 'failed': case 'disposed': return { kind: 'not_running' };
      default: {
        const exhaustive: never = phase;
        throw new Error(String(exhaustive));
      }
      }
      if (sampleRate !== inputSampleRate || samples.length === 0) {
        throw speechError({ code: 'invalid_audio', message: 'Speech input must use the session sample rate' });
      }
      if (queuedSamples + samples.length > Math.floor(inputSampleRate * maxQueuedSeconds)) {
        return { kind: 'backpressure' };
      }
      for (const sample of samples) {
        if (!Number.isFinite(sample) || sample < -1 || sample > 1) {
          throw speechError({ code: 'invalid_audio', message: 'Speech input contains an invalid sample' });
        }
      }
      const owned = new Float32Array(samples);
      queuedSamples += owned.length;
      notify();
      const id = sessionId;
      void schedule({
        operation: async () => {
          try {
            if (dialogue === undefined || id !== sessionId || stopMode === 'cancel') {
              return;
            }
            const result = await dialogue.push({ samples: owned });
            if (callbackFailure !== undefined) {
              throw callbackFailure;
            }
            switch (result.kind) {
            case 'continue': break;
            case 'completed':
              completion = result.reason;
              stopMode = 'cancel';
              await closeDialogue();
              setPhase({ value: 'completed' });
              break;
            default: {
              const exhaustive: never = result;
              throw new Error(String(exhaustive));
            }
            }
          } catch (error) {
            await fail({ error });
          } finally {
            queuedSamples -= owned.length;
            notify();
          }
        },
      });
      return { kind: 'accepted' };
    },
    stop,
    releaseModel,
    async dispose() {
      if (disposing) {
        await lane;
        return;
      }
      disposing = true;
      await releaseModel();
    },
  };
}

export const TEST_ONLY = {
};
