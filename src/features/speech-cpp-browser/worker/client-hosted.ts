import configuration from 'virtual:speech-cpp-browser/config';
import { releaseWorkerRemote, postWorkerNotification, subscribeWorkerNotifications, wrapWorkerRemote, type WorkerRemote } from '@/utils/worker-transport';
import { SpeechRuntimeError, speechError, speechFailure, type SpeechState, type SpeechPushResult, type SpeechFailure } from '@/features/speech-cpp-browser/types';
import { speechFrameEnvelopeSchema, speechStateEnvelopeSchema, speechStopSchema, decodeSpeechState, type SpeechWorker } from './protocol';
import { createUnavailableSpeechClient } from './client-unavailable';
import type { SpeechClient, SpeechObservers } from './types';
import { speechInvestigationEnvelopeSchema } from './investigation-protocol';

type WorkerState = { worker: Worker, remote: WorkerRemote<SpeechWorker>, controller: AbortController, unsubscribe: (() => void)[], investigationCleanup?: () => void };

/** Lazy hosted Worker; microphone PCM is bounded before it reaches Comlink. */
export function createSpeechClient({ observers }: { observers: SpeechObservers }): SpeechClient {
  switch (configuration.kind) {
  case 'unavailable': return createUnavailableSpeechClient({ reason: configuration.reason, observers });
  case 'available': break;
  default: {
    const exhaustive: never = configuration;
    throw new Error(String(exhaustive));
  }
  }
  if (typeof Worker === 'undefined') {
    return createUnavailableSpeechClient({ reason: 'worker_unavailable', observers });
  }
  if (typeof navigator === 'undefined' || !('gpu' in navigator) || navigator.gpu === undefined) {
    return createUnavailableSpeechClient({ reason: 'webgpu_unavailable', observers });
  }
  if (typeof WebAssembly === 'undefined' || !WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 1]))) {
    return createUnavailableSpeechClient({ reason: 'memory64_unavailable', observers });
  }
  const wasm = WebAssembly;
  if (!('Suspending' in wasm) || typeof wasm.Suspending !== 'function' || !('promising' in wasm) || typeof wasm.promising !== 'function') {
    return createUnavailableSpeechClient({ reason: 'jspi_unavailable', observers });
  }
  const artifact = configuration.artifact;
  let state: SpeechState = { phase: 'unloaded', model: undefined, queuedSamples: 0, completion: undefined, failure: undefined, loadProgress: undefined };
  let workerState: WorkerState | undefined;
  let disposed = false, stopping = false, pumping: Promise<void> | undefined;
  let inputSampleRate = 0, retainedSamples = 0, generation = 0;
  let queuedSamples = 0, inputFrameNumerator = 0, inputFrameDenominator = 1, inputFrameIndex = 0;
  let finishingInput = false;
  const queue: Float32Array<ArrayBuffer>[] = [];
  function notify(): void {
    try {
      observers.onState({ state: { ...state, queuedSamples: retainedSamples } });
    } catch { /* Observational only. */ }
  }
  function observeInvestigation({ current }: { current: WorkerState }): (() => void) | undefined {
    if (observers.onInvestigation === undefined) {
      return undefined;
    }
    current.investigationCleanup?.();
    const unsubscribe = subscribeWorkerNotifications({
      endpoint: current.worker,
      schema: speechInvestigationEnvelopeSchema,
      listener({ value }) {
        if (workerState === current && !disposed) {
          try {
            observers.onInvestigation?.({ context: value.context, event: value.event });
          } catch { /* Observational only. */ }
        }
      },
    });
    const cleanup = () => {
      unsubscribe();
      if (current.investigationCleanup === cleanup) {
        current.investigationCleanup = undefined;
      }
    };
    current.investigationCleanup = cleanup;
    return cleanup;
  }
  function retire({ target, failure }: { target: WorkerState | undefined, failure: SpeechFailure | undefined }): void {
    if (target === undefined || target.controller.signal.aborted) {
      return;
    }
    target.controller.abort(failure === undefined ? speechError({ code: 'runtime_failed', message: 'Speech worker was released' }) : new SpeechRuntimeError({ details: failure }));
    target.investigationCleanup?.();
    for (const unsubscribe of target.unsubscribe) {
      unsubscribe();
    }
    try {
      Promise.resolve(releaseWorkerRemote({ remote: target.remote })).catch(() => undefined);
    } catch { /* Physical termination always follows. */ }
    target.worker.terminate();
    if (workerState === target) {
      workerState = undefined;
      queue.length = 0;
      queuedSamples = 0;
      retainedSamples = 0;
      finishingInput = false;
      pumping = undefined;
      state = { phase: disposed ? 'disposed' : failure === undefined ? 'unloaded' : 'failed', model: undefined, queuedSamples: 0, completion: undefined, failure: disposed ? undefined : failure, loadProgress: undefined };
      notify();
    }
  }
  function requireWorker(): WorkerState {
    if (disposed || workerState === undefined) {
      throw speechError({ code: 'invalid_state', message: 'Speech model is not loaded' });
    }
    return workerState;
  }
  function operation<T>({ target, task }: { target: WorkerState, task: Promise<T> }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      function aborted(): void {
        reject(target.controller.signal.reason);
      }
      target.controller.signal.addEventListener('abort', aborted, { once: true });
      if (target.controller.signal.aborted) {
        aborted();
      }
      void task.then(resolve, reject).finally(() => target.controller.signal.removeEventListener('abort', aborted));
    });
  }
  async function boundedShutdown({ target, task }: { target: WorkerState, task: Promise<void> }): Promise<void> {
    const timer = setTimeout(() => retire({ target, failure: { code: 'runtime_failed', message: 'Speech worker shutdown timed out', nativeStatus: undefined, nativeInput: undefined } }), 3000);
    try {
      await operation({ target, task });
    } finally {
      clearTimeout(timer);
    }
  }
  function pump(): void {
    if (pumping !== undefined || queuedSamples === 0 || (!finishingInput && queuedSamples < nextBatchLength())) {
      return;
    }
    const target = requireWorker();
    const pumpTask = Promise.resolve().then(async () => {
      try {
        while (queuedSamples !== 0 && !target.controller.signal.aborted) {
          const frameLength = nextBatchLength();
          if (!finishingInput && queuedSamples < frameLength) {
            break;
          }
          const length = Math.min(frameLength, queuedSamples);
          const samples = new Float32Array(length);
          let copied = 0;
          while (copied < length) {
            const head = queue[0]!;
            const count = Math.min(head.length, length - copied);
            samples.set(head.subarray(0, count), copied);
            copied += count;
            if (count === head.length) {
              queue.shift();
            } else {
              queue[0] = head.subarray(count);
            }
          }
          queuedSamples -= length;
          if (length === frameLength) {
            inputFrameIndex++;
          }
          await operation({ target, task: target.remote.push({ samples, sampleRate: inputSampleRate }) });
          if (workerState !== target) {
            break;
          }
          retainedSamples = Math.max(0, retainedSamples - samples.length);
          notify();
          if (state.completion !== undefined || state.failure !== undefined) {
            discardQueued();
            break;
          }
        }
      } catch (error) {
        if (!disposed && workerState === target) {
          retire({ target, failure: state.failure ?? speechFailure({ error }) });
        }
      } finally {
        if (pumping === pumpTask) {
          pumping = undefined;
        }
      }
    });
    pumping = pumpTask;
  }
  function nextBatchLength(): number {
    // Cumulative boundaries avoid drift when input/model rates have a
    // fractional frame ratio (for example 16 kHz into a 24 kHz model).
    return Math.ceil((inputFrameIndex + 1) * inputFrameNumerator / inputFrameDenominator) - Math.ceil(inputFrameIndex * inputFrameNumerator / inputFrameDenominator);
  }
  function discardQueued(): void {
    retainedSamples = Math.max(0, retainedSamples - queuedSamples);
    queuedSamples = 0;
    queue.length = 0;
    notify();
  }
  async function releaseCurrentModel(): Promise<void> {
    stopping = true;
    finishingInput = false;
    discardQueued();
    const target = workerState;
    try {
      if (target !== undefined) {
        postWorkerNotification({ endpoint: target.worker, schema: speechStopSchema, value: { mode: 'cancel' } });
        await boundedShutdown({ target, task: target.remote.releaseModel() });
      }
    } finally {
      retire({ target, failure: undefined });
      if (workerState === undefined || workerState === target) {
        state = { phase: disposed ? 'disposed' : 'unloaded', model: undefined, queuedSamples: 0, completion: undefined, failure: undefined, loadProgress: undefined };
        notify();
      }
    }
  }

  return {
    capability: { kind: 'available' },
    getState: () => ({ ...state, queuedSamples: retainedSamples }),
    async loadModel({ file, investigation }) {
      const ownGeneration = ++generation;
      if (disposed) {
        throw speechError({ code: 'invalid_state', message: 'Speech client is disposed' });
      }
      try {
        await releaseCurrentModel();
      } catch { /* The old worker was physically retired. */ }
      if (disposed || ownGeneration !== generation) {
        throw speechError({ code: 'invalid_state', message: 'Speech client is disposed' });
      }
      state = { phase: 'loading_model', model: undefined, queuedSamples: 0, completion: undefined, failure: undefined, loadProgress: { stage: 'preparing_runtime' } };
      notify();
      let worker: Worker;
      try {
        worker = new Worker(new URL('./entry.ts', import.meta.url), { type: 'module', name: 'speech-cpp-browser' });
      } catch (error) {
        state = { ...state, phase: 'failed', failure: speechFailure({ error }), loadProgress: undefined };
        notify();
        throw error;
      }
      let remote: WorkerRemote<SpeechWorker>;
      try {
        remote = wrapWorkerRemote<SpeechWorker>({ endpoint: worker });
      } catch (error) {
        worker.terminate();
        state = { ...state, phase: 'failed', failure: speechFailure({ error }), loadProgress: undefined };
        notify();
        throw error;
      }
      const target: WorkerState = { worker, remote, controller: new AbortController(), unsubscribe: [] };
      workerState = target;
      try {

        target.unsubscribe.push(subscribeWorkerNotifications({
          endpoint: worker,
          schema: speechStateEnvelopeSchema,
          listener: ({ value }) => {
            if (workerState !== target) {
              return;
            }
            const next = decodeSpeechState({ value: value.state });
            if (next.failure !== undefined) {
              retire({ target, failure: next.failure });
              return;
            }
            if (next.completion !== undefined) {
              target.investigationCleanup?.();
            }
            state = next;
            notify();
          },
        }));
        target.unsubscribe.push(subscribeWorkerNotifications({
          endpoint: worker,
          schema: speechFrameEnvelopeSchema,
          listener: ({ value }) => {
            if (workerState !== target || disposed) {
              return;
            }
            try {
              observers.onFrame({ frame: value.frame });
            } catch { /* Observational only. */ }
          },
        }));
        const crashed = () => {
          if (workerState === target) {
            retire({ target, failure: { code: 'runtime_failed', message: 'Speech worker failed', nativeStatus: undefined, nativeInput: undefined } });
          }
        };
        worker.addEventListener('error', crashed);
        worker.addEventListener('messageerror', crashed);
        target.unsubscribe.push(() => {
          worker.removeEventListener('error', crashed);
          worker.removeEventListener('messageerror', crashed);
        });
        const unobserve = investigation === undefined ? undefined : observeInvestigation({ current: target });
        try {
          await operation({ target, task: target.remote.loadModel({ file, artifact, baseUrl: new URL(import.meta.env.BASE_URL, location.href).href, ...(investigation === undefined ? {} : { investigation }) }) });
        } finally {
          unobserve?.();
        }

        if (disposed || ownGeneration !== generation || workerState !== target) {
          retire({ target, failure: undefined });
          throw speechError({ code: 'invalid_state', message: 'Speech model load was superseded' });
        }
      } catch (error) {
        retire({ target, failure: state.failure ?? speechFailure({ error }) });
        throw error;
      }
    },
    async start({ options, investigation }) {
      const target = requireWorker();
      switch (state.phase) {
      case 'ready': case 'completed': break;
      case 'unloaded': case 'loading_model': case 'starting': case 'running': case 'stopping': case 'failed': case 'disposed': throw speechError({ code: 'invalid_state', message: 'Speech model is not ready for a new session' });
      default: {
        const exhaustive: never = state.phase;
        throw new Error(String(exhaustive));
      }
      }
      if (state.model === undefined || !Number.isSafeInteger(options.inputSampleRate) || options.inputSampleRate < 8000 || options.inputSampleRate > 192000) {
        throw speechError({ code: 'invalid_audio', message: 'Invalid speech input sample rate or model frame metadata' });
      }
      if (investigation !== undefined) {
        observeInvestigation({ current: target });
      }
      stopping = false;
      finishingInput = false;
      inputSampleRate = options.inputSampleRate;
      inputFrameNumerator = inputSampleRate * state.model.frameSamples;
      inputFrameDenominator = state.model.sampleRate;
      inputFrameIndex = 0;
      try {
        await operation({ target, task: target.remote.start({ options, ...(investigation === undefined ? {} : { investigation }) }) });
      } catch (error) {
        retire({ target, failure: state.failure ?? speechFailure({ error }) });
        throw error;
      }
    },
    push({ samples, sampleRate }): SpeechPushResult {
      if (stopping || disposed || workerState === undefined || state.phase !== 'running') {
        return { kind: 'not_running' };
      }
      if (sampleRate !== inputSampleRate || !samples.length || samples.some(value => !Number.isFinite(value) || value < -1 || value > 1)) {
        throw speechError({ code: 'invalid_audio', message: 'Invalid microphone PCM for speech session' });
      }
      if (retainedSamples + samples.length > inputSampleRate * 2) {
        return { kind: 'backpressure' };
      }
      queue.push(new Float32Array(samples));
      queuedSamples += samples.length;
      retainedSamples += samples.length;
      notify();
      pump();
      return { kind: 'accepted' };
    },
    async stop({ mode }) {
      stopping = true;
      const target = workerState;
      if (target === undefined) {
        return;
      }
      switch (mode) {
      case 'cancel':
        finishingInput = false;
        discardQueued();
        postWorkerNotification({ endpoint: target.worker, schema: speechStopSchema, value: { mode } });
        break;
      case 'finish':
        finishingInput = true;
        pump();
        break;
      default: {
        const exhaustive: never = mode;
        throw new Error(String(exhaustive));
      }
      }
      try {
        await boundedShutdown({
          target,
          task: (async () => {
            await pumping;
            await target.remote.stop({ mode });
          })(),
        });
      } finally {
        target.investigationCleanup?.();
      }
    },
    async releaseModel() {
      generation++;
      await releaseCurrentModel();
    },
    async dispose() {
      disposed = true;
      generation++;
      try {
        await releaseCurrentModel();
      } finally {
        retire({ target: workerState, failure: undefined });
      }
    },
  };
}

export const TEST_ONLY = {
};
