import configuration from 'virtual:speech-cpp-browser/config';
import { releaseWorkerRemote, postWorkerNotification, subscribeWorkerNotifications, workerTransfer, wrapWorkerRemote, type WorkerRemote } from '@/utils/worker-transport';
import { SpeechRuntimeError, speechError, speechFailure, type SpeechFailure } from '@/features/speech-cpp-browser/types';
import { initialSpeechRecognitionState, type SpeechRecognitionClient, type SpeechRecognitionObservers } from '@/features/speech-cpp-browser/recognition/types';
import { recognitionCancelSchema, recognitionLoadProgressSchema, recognitionProgressSchema, recognitionLoadResultSchema, recognitionTranscribeResultSchema, type SpeechRecognitionWorker } from './protocol';
import { createUnavailableSpeechRecognitionClient } from './client-unavailable';
import { speechInvestigationEnvelopeSchema } from '@/features/speech-cpp-browser/worker/investigation-protocol';

type WorkerState = { worker: Worker, remote: WorkerRemote<SpeechRecognitionWorker>, lifetime: AbortController, unsubscribe: (() => void)[], investigationCleanup?: () => void };

export function createSpeechRecognitionClient({ observers }: { observers: SpeechRecognitionObservers }): SpeechRecognitionClient {
  switch (configuration.kind) {
  case 'unavailable': return createUnavailableSpeechRecognitionClient({ reason: configuration.reason, observers });
  case 'available': break;
  default: {
    const exhaustive: never = configuration;
    throw new Error(String(exhaustive));
  }
  }
  if (typeof Worker === 'undefined') {
    return createUnavailableSpeechRecognitionClient({ reason: 'worker_unavailable', observers });
  }
  if (typeof navigator === 'undefined' || !('gpu' in navigator) || navigator.gpu === undefined) {
    return createUnavailableSpeechRecognitionClient({ reason: 'webgpu_unavailable', observers });
  }
  if (configuration.artifact.profile === 'webgpu-wasm64-jspi' && (typeof WebAssembly === 'undefined' || !WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 1])))) {
    return createUnavailableSpeechRecognitionClient({ reason: 'memory64_unavailable', observers });
  }
  const wasm = typeof WebAssembly === 'undefined' ? undefined : WebAssembly;
  if (wasm === undefined || !('Suspending' in wasm) || typeof wasm.Suspending !== 'function' || !('promising' in wasm) || typeof wasm.promising !== 'function') {
    return createUnavailableSpeechRecognitionClient({ reason: 'jspi_unavailable', observers });
  }
  const artifact = configuration.artifact;
  let state = initialSpeechRecognitionState();
  let target: WorkerState | undefined;
  let active: Promise<unknown> | undefined;
  let disposed = false, generation = 0;
  function notify(): void {
    try {
      observers.onState({ state });
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
        if (target === current && !disposed) {
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
  function retire({ workerState, failure }: { workerState: WorkerState | undefined, failure: SpeechFailure | undefined }): void {
    if (workerState === undefined || workerState.lifetime.signal.aborted) {
      return;
    }
    workerState.lifetime.abort(failure === undefined ? new DOMException('Recognition Worker was released', 'AbortError') : new SpeechRuntimeError({ details: failure }));
    workerState.investigationCleanup?.();
    for (const unsubscribe of workerState.unsubscribe) {
      unsubscribe();
    }
    try {
      Promise.resolve(releaseWorkerRemote({ remote: workerState.remote })).catch(() => undefined);
    } catch { /* Physical termination always follows. */ }
    workerState.worker.terminate();
    if (target === workerState) {
      target = undefined;
      active = undefined;
      state = { ...initialSpeechRecognitionState(), phase: disposed ? 'disposed' : failure === undefined ? 'unloaded' : 'failed', failure };
      notify();
    }
  }
  function operation<T>({ workerState, task }: { workerState: WorkerState, task: Promise<T> }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      function aborted(): void {
        reject(workerState.lifetime.signal.reason);
      }
      workerState.lifetime.signal.addEventListener('abort', aborted, { once: true });
      if (workerState.lifetime.signal.aborted) {
        aborted();
      }
      void task.then(resolve, reject).finally(() => workerState.lifetime.signal.removeEventListener('abort', aborted));
    });
  }
  async function bounded({ workerState, task }: { workerState: WorkerState, task: Promise<unknown> }): Promise<void> {
    const timer = setTimeout(() => retire({ workerState, failure: undefined }), 3000);
    try {
      await operation({ workerState, task });
    } finally {
      clearTimeout(timer);
    }
  }
  async function release(): Promise<void> {
    const previous = target;
    if (previous === undefined) {
      return;
    }
    try {
      postWorkerNotification({ endpoint: previous.worker, schema: recognitionCancelSchema, value: { type: 'naidan_recognition_cancel_v1' } });
      await bounded({ workerState: previous, task: previous.remote.releaseModel() });
    } finally {
      // model_free cannot shrink an already-grown Wasm memory.
      retire({ workerState: previous, failure: undefined });
    }
  }
  return {
    capability: { kind: 'available' },
    getState: () => state,
    async loadModel({ file, investigation }) {
      if (disposed) {
        throw speechError({ code: 'invalid_state', message: 'Recognition client is disposed' });
      }
      const ownGeneration = ++generation;
      try {
        await release();
      } catch { /* The previous Worker is terminated. */ }
      if (disposed || ownGeneration !== generation) {
        throw speechError({ code: 'invalid_state', message: 'Recognition model load was superseded' });
      }
      state = { ...initialSpeechRecognitionState(), phase: 'loading_model', loadProgress: { stage: 'preparing_runtime' } };
      notify();
      let workerState: WorkerState | undefined;
      try {
        const worker = new Worker(new URL('./entry.ts', import.meta.url), { type: 'module', name: 'speech-recognition' });
        let remote: WorkerRemote<SpeechRecognitionWorker>;
        try {
          remote = wrapWorkerRemote<SpeechRecognitionWorker>({ endpoint: worker });
        } catch (error) {
          worker.terminate();
          throw error;
        }
        const current: WorkerState = { worker, remote, lifetime: new AbortController(), unsubscribe: [] };
        workerState = current;
        target = current;

        current.unsubscribe.push(subscribeWorkerNotifications({
          endpoint: worker,
          schema: recognitionLoadProgressSchema,
          listener({ value }) {
            if (target === current && state.phase === 'loading_model') {
              state = { ...state, loadProgress: value.progress };
              notify();
            }
          },
        }));
        current.unsubscribe.push(subscribeWorkerNotifications({
          endpoint: worker,
          schema: recognitionProgressSchema,
          listener({ value }) {
            if (target === current && state.phase === 'recognizing') {
              state = { ...state, progress: value.progress };
              notify();
            }
          },
        }));
        const crashed = () => retire({ workerState: current, failure: { code: 'runtime_failed', message: 'Recognition Worker failed', nativeStatus: undefined, nativeInput: undefined } });
        worker.addEventListener('error', crashed);
        worker.addEventListener('messageerror', crashed);
        current.unsubscribe.push(() => {
          worker.removeEventListener('error', crashed);
          worker.removeEventListener('messageerror', crashed);
        });
        const unobserve = investigation === undefined ? undefined : observeInvestigation({ current });
        const loading = operation<Awaited<ReturnType<SpeechRecognitionWorker['loadModel']>>>({ workerState: current, task: remote.loadModel({ file, artifact, baseUrl: new URL(import.meta.env.BASE_URL, location.href).href, ...(investigation === undefined ? {} : { investigation }) }) });
        active = loading;
        let wire: Awaited<ReturnType<SpeechRecognitionWorker['loadModel']>>;
        try {
          wire = await loading;
        } finally {
          unobserve?.();
        }
        const result = recognitionLoadResultSchema.parse(wire);
        switch (result.kind) {
        case 'failed': throw new SpeechRuntimeError({ details: { ...result.failure, nativeStatus: result.failure.nativeStatus, nativeInput: result.failure.nativeInput } });
        case 'loaded': break;
        default: {
          const exhaustive: never = result;
          throw new Error(String(exhaustive));
        }
        }
        if (disposed || ownGeneration !== generation || target !== current) {
          throw speechError({ code: 'invalid_state', message: 'Recognition model load was superseded' });
        }
        state = { ...state, phase: 'ready', model: result.model, loadProgress: undefined, failure: undefined };
        notify();
      } catch (error) {
        if (ownGeneration === generation && !disposed) {
          const failure = speechFailure({ error });
          retire({ workerState, failure });
          state = { ...initialSpeechRecognitionState(), phase: 'failed', failure };
          notify();
        }
        throw error;
      } finally {
        if (ownGeneration === generation) {
          active = undefined;
        }
      }
    },
    async transcribe({ samples, sampleRate, language, investigation }) {
      const current = target;
      if (disposed || current === undefined || state.phase !== 'ready' || active !== undefined) {
        throw speechError({ code: 'invalid_state', message: 'Recognition model is not ready' });
      }
      state = { ...state, phase: 'recognizing', progress: undefined, failure: undefined };
      notify();
      const unobserve = investigation === undefined ? undefined : observeInvestigation({ current });
      let recognizing: Promise<Awaited<ReturnType<SpeechRecognitionWorker['transcribe']>>> | undefined;
      try {
        recognizing = operation<Awaited<ReturnType<SpeechRecognitionWorker['transcribe']>>>({ workerState: current, task: current.remote.transcribe(workerTransfer({ value: { samples, sampleRate, language, ...(investigation === undefined ? {} : { investigation }) }, transferables: [samples.buffer] })) });
        active = recognizing;
        const result = recognitionTranscribeResultSchema.parse(await recognizing);
        switch (result.kind) {
        case 'failed': throw new SpeechRuntimeError({ details: { ...result.failure, nativeStatus: result.failure.nativeStatus, nativeInput: result.failure.nativeInput } });
        case 'recognized': break;
        default: {
          const exhaustive: never = result;
          throw new Error(String(exhaustive));
        }
        }
        if (target === current) {
          state = { ...state, phase: 'ready', progress: undefined };
          notify();
        }
        return result.result;
      } catch (error) {
        if (target === current) {
          retire({ workerState: current, failure: speechFailure({ error }) });
        }
        throw error;
      } finally {
        unobserve?.();
        if (active === recognizing) {
          active = undefined;
        }
      }
    },
    async cancel() {
      const current = target;
      if (current === undefined || active === undefined) {
        return;
      }
      switch (state.phase) {
      case 'loading_model':
        // Model loading has no request cancellation leaf. Retire its whole
        // lifetime instead of publishing a late ready model after cancellation.
        generation++;
        retire({ workerState: current, failure: undefined });
        return;
      case 'unloaded': case 'ready': case 'recognizing': case 'cancelling': case 'failed': case 'disposed': break;
      default: {
        const exhaustive: never = state.phase;
        throw new Error(String(exhaustive));
      }
      }
      state = { ...state, phase: 'cancelling' };
      notify();
      postWorkerNotification({ endpoint: current.worker, schema: recognitionCancelSchema, value: { type: 'naidan_recognition_cancel_v1' } });
      try {
        await bounded({ workerState: current, task: active });
      } catch { /* Caller observes the operation result. */ }
    },
    async releaseModel() {
      generation++;
      await release();
    },
    async dispose() {
      disposed = true;
      generation++;
      try {
        await release();
      } finally {
        state = { ...initialSpeechRecognitionState(), phase: 'disposed' };
        notify();
      }
    },
  };
}

export const TEST_ONLY = {
};
