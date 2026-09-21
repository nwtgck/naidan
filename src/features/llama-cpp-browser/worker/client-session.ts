import { deletionPlanSchema, deletionResultSchema } from '@/features/llama-cpp-browser/runtime/deletion-plan';
import { classifyFailure, diagnosticSchema, dispatchLimitDetails, logDiagnostic, logFailure, type Diagnostic } from '@/features/llama-cpp-browser/debug-log';
import { z } from 'zod';
import { workerProxy, type WorkerRemote } from '@/utils/worker-transport';
import { errorCode, generationResultSchema, LlamaCppBrowserError, modelSchema, modelsSchema, progressSchema } from '@/features/llama-cpp-browser/types';
import { workerGenerateCallSchema, type LlamaCppWorkerApi, type LlamaCppWorkerClient } from './types';

// Both transports share cancellation, validation and callback lifetime rules.
export function createLlamaCppWorkerSessionClient({ worker, remote, disposeTransport, getAssetBaseURL }: {
  worker: Worker,
  remote: WorkerRemote<LlamaCppWorkerApi>,
  disposeTransport: ({ active }: { active: boolean }) => void,
  getAssetBaseURL: () => string | undefined,
}): LlamaCppWorkerClient {
  let disposed = false;
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
  async function invoke<T>({ call, signal, onAbort }: { call: () => Promise<T>, signal: AbortSignal | undefined, onAbort: (() => void) | undefined }): Promise<T> {
    if (signal?.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
    if (disposed) throw new LlamaCppBrowserError({ code: 'worker-failed' });
    if (rejectActive) throw new LlamaCppBrowserError({ code: 'busy' });
    stopWaiting(); pendingOperations.clear(); lastOperation = undefined; lastNativeFailure = undefined;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = (): void => {
      if (!onAbort) {
        dispose(); return;
      }
      // Cooperative generation cancellation normally preserves resident weights.
      // A stuck native call still has a bounded escape hatch; imports always
      // terminate because a sync OPFS operation cannot reliably service messages.
      abortTimer = setTimeout(dispose, 5000);
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
  return {
    listModels: async ({ signal }) => modelsSchema.parse(await invoke({ call: () => remote.listModels(), signal, onAbort: undefined })),
    importModel: async ({ file, onProgress, signal }) => modelSchema.parse(await invoke({
      call: () => remote.importModel({ file }, workerProxy({ value: ({ ...event }) => {
        if (!disposed) onProgress({ progress: progressSchema.parse(event) });
      } })), signal, onAbort: undefined,
    })),
    importDirectory: async ({ directory, onProgress, signal }) => {
      const generationId = ++nextGenerationId;
      return modelSchema.parse(await invoke({
        call: () => remote.importDirectory({ directory, generationId }, workerProxy({ value: ({ ...event }) => {
          if (!disposed && !signal?.aborted) onProgress({ progress: progressSchema.parse(event) });
        } })), signal, onAbort: () => {
          void remote.cancelGeneration({ generationId }).catch(dispose);
        },
      }));
    },
    removeModel: async ({ plan, signal }) => {
      return deletionResultSchema.parse(await invoke({ call: () => remote.removeModel({ plan: deletionPlanSchema.parse(plan) }), signal, onAbort: undefined }));
    },
    generate: async ({ request, onChunk, onProgress, signal }) => {
      const accepted = workerGenerateCallSchema.parse({ ...request, generationId: ++nextGenerationId,
        assetBaseURL: getAssetBaseURL(),
      });
      let acceptingEvents = true;
      try {
        const result = await invoke({ call: () => remote.generate(accepted,
          workerProxy({ value: ({ ...event }) => {
            if (acceptingEvents && !disposed && !signal?.aborted) onChunk({ chunk: z.object({ text: z.string() }).strict().parse(event).text });
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
        } });
        return generationResultSchema.parse(result);
      } finally {
        acceptingEvents = false;
      }
    },
    canReuse: () => !disposed,
    dispose,
  };
}
export const TEST_ONLY = {
};
