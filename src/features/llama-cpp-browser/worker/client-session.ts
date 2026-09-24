import { audioGenerationResultSchema } from '@/features/audio-generation/types';
import { profileCapabilitiesSchema } from '@/features/llama-cpp-browser/runtime/profile-capabilities';
import { deletionPlanSchema, deletionResultSchema } from '@/features/llama-cpp-browser/runtime/deletion-plan';
import { classifyFailure, diagnosticSchema, dispatchLimitDetails, logDiagnostic, logFailure, type Diagnostic } from '@/features/llama-cpp-browser/debug-log';
import { workerProxy, type WorkerProxy, type WorkerRemote } from '@/utils/worker-transport';
import { errorCode, generationEventSchema, generationResultSchema, LlamaCppBrowserError, modelSchema, modelsSchema, progressSchema, type LocalModel, type Progress } from '@/features/llama-cpp-browser/types';
import { workerAudioCallSchema, workerGenerateCallSchema, type LlamaCppWorkerApi, type LlamaCppWorkerClient } from './types';

// Both transports share cancellation, validation and callback lifetime rules.
export function createLlamaCppWorkerSessionClient({ worker, remote, disposeTransport, getAssetBaseURL }: {
  worker: Worker,
  remote: WorkerRemote<LlamaCppWorkerApi>,
  disposeTransport: ({ active }: { active: boolean }) => void,
  getAssetBaseURL: () => string | undefined,
}): LlamaCppWorkerClient {
  let disposed = false;
  const disposeListeners = new Set<() => void>();
  let lastOperation: Diagnostic | undefined;
  let lastNativeFailure: Diagnostic | undefined;
  const pendingOperations = new Map<Diagnostic['stage'], { diagnostic: Diagnostic, started: number }>();
  let debugEnabled = false;
  let waitingTimer: ReturnType<typeof setTimeout> | undefined;
  const stopWaiting = (): void => {
    if (waitingTimer !== undefined) clearTimeout(waitingTimer); waitingTimer = undefined;
  };
  const waitForOperation = ({ diagnostic, started }: { diagnostic: Diagnostic, started: number }): void => {
    if (!debugEnabled) return;
    const report = (): void => {
      if (disposed) return;
      logDiagnostic({ diagnostic: { ...diagnostic, ...lastOperation, stage: diagnostic.stage, event: 'operation-waiting', lastStage: lastOperation?.stage, lastEvent: lastOperation?.event, elapsedMs: performance.now() - started } });
      waitingTimer = setTimeout(report, 30000);
    };
    waitingTimer = setTimeout(report, 15000);
  };
  const recordOperation = ({ diagnostic }: { diagnostic: Diagnostic & { event: 'operation-start' | 'operation-complete' } }): void => {
    stopWaiting(); lastOperation = diagnostic;
    switch (diagnostic.event) {
    case 'operation-complete': {
      pendingOperations.delete(diagnostic.stage);
      // A native completion can leave its enclosing helper still running.
      const pending = Array.from(pendingOperations.values()).at(-1);
      if (pending) waitForOperation(pending);
      return;
    }
    case 'operation-start': {
      const operation = { diagnostic, started: performance.now() };
      pendingOperations.set(diagnostic.stage, operation);
      waitForOperation(operation);
      return;
    }
    default: { const exhaustive: never = diagnostic.event; throw new Error(`Unknown operation event: ${exhaustive}`); }
    }
  };
  let nextGenerationId = 0;
  let rejectActive: (() => void) | undefined;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true; debugEnabled = false; stopWaiting(); pendingOperations.clear();
    const active = rejectActive !== undefined;
    rejectActive?.();
    worker.removeEventListener('error', onError);
    worker.removeEventListener('messageerror', onMessageError);
    disposeTransport({ active });
    for (const listener of disposeListeners) {
      try {
        listener();
      } catch { /* Disposal observers cannot interrupt cleanup. */ }
    }
    disposeListeners.clear();
  };
  // eslint-disable-next-line local-rules-named-args/require-named-args -- DOM Worker error listener signature.
  const onError = (event: ErrorEvent): void => {
    const failureKind = lastNativeFailure?.failureKind ?? classifyFailure({ error: event.error instanceof Error ? event.error : event.message });
    logDiagnostic({ diagnostic: { ...lastOperation, ...dispatchLimitDetails({ message: event.message }), ...lastNativeFailure, event: 'failed', stage: 'worker-error', failureKind,
      lastStage: lastOperation?.stage, lastEvent: lastOperation?.event } });
    event.preventDefault(); dispose();
  };
  const onMessageError = (): void => {
    logDiagnostic({ diagnostic: { ...lastOperation, event: 'failed', stage: 'worker-messageerror', lastStage: lastOperation?.stage, lastEvent: lastOperation?.event } }); dispose();
  };
  worker.addEventListener('error', onError);
  worker.addEventListener('messageerror', onMessageError);
  async function invoke<T>({ call, signal, onAbort, abortTimeoutMs }: { call: () => Promise<T>, signal: AbortSignal | undefined, onAbort: (() => void) | undefined, abortTimeoutMs: number | undefined }): Promise<T> {
    if (signal?.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
    if (disposed) throw new LlamaCppBrowserError({ code: 'worker-failed' });
    if (rejectActive) throw new LlamaCppBrowserError({ code: 'busy' });
    stopWaiting(); pendingOperations.clear(); lastOperation = undefined; lastNativeFailure = undefined;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = (): void => {
      if (!onAbort) {
        dispose(); return;
      }
      // Native generation needs a bounded escape hatch. Local imports use async
      // streams and must be allowed to finish rollback, even on slow storage:
      // terminating them here leaves hidden partial directories that block retry.
      if (abortTimeoutMs !== undefined) abortTimer = setTimeout(dispose, abortTimeoutMs);
      onAbort();
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await new Promise<T>((resolve, reject) => {
        rejectActive = () => reject(new LlamaCppBrowserError({ code: signal?.aborted ? 'aborted' : 'worker-failed' }));
        void call().then(resolve, reject);
      });
      if (signal?.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
      return result;
    } catch (error) {
      if (!disposed) logFailure({ stage: 'worker-rpc', error });
      const code = errorCode({ error });
      if (signal?.aborted && (code === 'runtime-error' || code === 'worker-failed')) dispose();
      throw new LlamaCppBrowserError({ code: signal?.aborted ? 'aborted' : errorCode({ error }) });
    } finally {
      stopWaiting(); debugEnabled = false; pendingOperations.clear();
      if (abortTimer !== undefined) clearTimeout(abortTimer);
      signal?.removeEventListener('abort', abort);
      rejectActive = undefined;
    }
  }
  async function importWithCancellation({ call, onProgress, signal }: {
    call: ({ generationId, report }: { generationId: number, report: WorkerProxy<({ phase, completed, total }: Progress) => void> }) => Promise<LocalModel>,
    onProgress: ({ progress }: { progress: Progress }) => void,
    signal: AbortSignal | undefined,
  }): Promise<LocalModel> {
    const generationId = ++nextGenerationId;
    let acceptingProgress = true;
    try {
      return modelSchema.parse(await invoke({
        call: () => call({ generationId, report: workerProxy({ value: ({ ...event }: Progress) => {
          if (acceptingProgress && !disposed && !signal?.aborted) onProgress({ progress: progressSchema.parse(event) });
        } }) }), signal, onAbort: () => {
          void remote.cancelGeneration({ generationId }).catch(dispose);
        }, abortTimeoutMs: undefined,
      }));
    } finally {
      acceptingProgress = false;
    }
  }
  return {
    subscribeDisposed({ listener }) {
      if (disposed) {
        listener(); return () => {};
      }
      disposeListeners.add(listener); return () => {
        disposeListeners.delete(listener);
      };
    },
    probeProfiles: async ({ signal }) => profileCapabilitiesSchema.parse(await invoke({ call: () => remote.probeProfiles(), signal, onAbort: undefined, abortTimeoutMs: undefined })),
    listModels: async ({ signal }) => modelsSchema.parse(await invoke({ call: () => remote.listModels(), signal, onAbort: undefined, abortTimeoutMs: undefined })),
    importModel: ({ file, onProgress, signal }) => importWithCancellation({ signal, onProgress,
      call: ({ generationId, report }) => remote.importModel({ file, generationId }, report),
    }),
    importDirectory: ({ directory, onProgress, signal }) => importWithCancellation({ signal, onProgress,
      call: ({ generationId, report }) => remote.importDirectory({ directory, generationId }, report),
    }),
    removeModel: async ({ plan, signal }) => {
      return deletionResultSchema.parse(await invoke({ call: () => remote.removeModel({ plan: deletionPlanSchema.parse(plan) }), signal, onAbort: undefined, abortTimeoutMs: undefined }));
    },
    generate: async ({ request, onEvent, onProgress, signal }) => {
      const accepted = workerGenerateCallSchema.parse({ ...request, generationId: ++nextGenerationId,
        assetBaseURL: getAssetBaseURL(),
      });
      let acceptingEvents = true;
      try {
        const result = await invoke({ call: () => remote.generate(accepted,
          workerProxy({ value: async ({ event }) => {
            if (acceptingEvents && !disposed) await onEvent({ event: generationEventSchema.parse(event) });
          } }),
          workerProxy({ value: ({ ...event }) => {
            if (acceptingEvents && !disposed && !signal?.aborted) onProgress({ progress: progressSchema.parse(event) });
          } }),
          workerProxy({ value: ({ diagnostic }: { diagnostic: unknown }) => {
            if (!acceptingEvents || disposed || signal?.aborted) return;
            debugEnabled = accepted.debug === 'on';
            const checkpoint = diagnosticSchema.parse(diagnostic);
            if (checkpoint.event === 'operation-start' || checkpoint.event === 'operation-complete') recordOperation({ diagnostic: { ...checkpoint, event: checkpoint.event } });
            if (checkpoint.event === 'native-info' && checkpoint.nativeOperation !== undefined) lastOperation = { ...lastOperation, ...checkpoint };
            if (checkpoint.event === 'native-node-start' || checkpoint.event === 'native-node-complete') lastOperation = checkpoint;
            if (checkpoint.event === 'native-error' && (!lastNativeFailure || checkpoint.failureKind === 'webgpu-dispatch-limit')) lastNativeFailure = checkpoint;
          } })), signal, onAbort: () => {
          void remote.cancelGeneration({ generationId: accepted.generationId }).catch(dispose);
        }, abortTimeoutMs: 5000 });
        return generationResultSchema.parse(result);
      } finally {
        acceptingEvents = false;
      }
    },
    generateAudio: async ({ request, onProgress, signal, finishSignal }) => {
      const accepted = workerAudioCallSchema.parse({ ...request, generationId: ++nextGenerationId, assetBaseURL: getAssetBaseURL() });
      let acceptingEvents = true; let started = false;
      const finish = (): void => {
        if (started && acceptingEvents && !disposed && !signal?.aborted) {
          void remote.finishAudioGeneration({ generationId: accepted.generationId }).catch(() => {
            if (acceptingEvents && !disposed) dispose();
          });
        }
      };
      // This signal requests a normal partial result. It never arms the abort
      // timeout, terminates the Worker, or reaches the native abort callback.
      finishSignal?.addEventListener('abort', finish, { once: true });
      try {
        const result = await invoke({ call: () => {
          const pending = remote.generateAudio(accepted,
            workerProxy({ value: ({ ...event }) => {
              if (acceptingEvents && !disposed && !signal?.aborted) onProgress({ progress: progressSchema.parse(event) });
            } }),
            workerProxy({ value: ({ diagnostic }: { diagnostic: unknown }) => {
              if (!acceptingEvents || disposed || signal?.aborted) return;
              debugEnabled = accepted.debug === 'on';
              const checkpoint = diagnosticSchema.parse(diagnostic);
              if (checkpoint.event === 'operation-start' || checkpoint.event === 'operation-complete') recordOperation({ diagnostic: { ...checkpoint, event: checkpoint.event } });
              if (checkpoint.event === 'native-info' && checkpoint.nativeOperation !== undefined) lastOperation = { ...lastOperation, ...checkpoint };
              if (checkpoint.event === 'native-node-start' || checkpoint.event === 'native-node-complete') lastOperation = checkpoint;
              if (checkpoint.event === 'native-error' && (!lastNativeFailure || checkpoint.failureKind === 'webgpu-dispatch-limit')) lastNativeFailure = checkpoint;
            } }));
          started = true;
          if (finishSignal?.aborted) finish();
          return pending;
        }, signal, onAbort: () => {
          void remote.cancelGeneration({ generationId: accepted.generationId }).catch(dispose);
        }, abortTimeoutMs: 5000 });
        return audioGenerationResultSchema.parse(result);
      } finally {
        acceptingEvents = false;
        finishSignal?.removeEventListener('abort', finish);
      }
    },
    canReuse: () => !disposed,
    dispose,
  };
}
export const TEST_ONLY = {
};
