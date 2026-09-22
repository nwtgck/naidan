import { createWorkerBlobImageDecoder } from '@/utils/worker-blob-image';
import { IMAGE_DECODE_LIMITS } from '@/features/llama-cpp-browser/runtime/image-input';
import type { BlobContext } from '@/utils/blob-view';
import { createWorkerBlobContext, type WorkerBlobReadHost } from '@/utils/worker-blob-context';
import { probeRuntimeProfiles } from '@/features/llama-cpp-browser/runtime/detect-profile';
import { profileCapabilitiesSchema } from '@/features/llama-cpp-browser/runtime/profile-capabilities';
import { verifyStorage } from '@/features/llama-cpp-browser/runtime/shared-storage-probe';
import { deletionPlanSchema } from '@/features/llama-cpp-browser/runtime/deletion-plan';
import { importModelDirectory } from '@/features/llama-cpp-browser/runtime/model-directory';
import { logFailure, subscribeDiagnostics } from '@/features/llama-cpp-browser/debug-log';
import { z } from "zod";
import { releaseWorkerProxyArgument, type WorkerServerApi } from "@/utils/worker-transport";
import { errorCode, modelDirectoryInputSchema, generationResultSchema, generationEventSchema, LlamaCppBrowserError, modelSchema, modelsSchema, type LocalModel, type Progress } from "@/features/llama-cpp-browser/types";
import { importStoredModel, listStoredModels, removeStoredModel, withModelStoreLock } from "@/features/llama-cpp-browser/runtime/model-store";
import { invalidateStoredModel, releaseSession } from "./session";
import { generate } from "./generation";
import { workerGenerateCallSchema, type LlamaCppWorkerApi } from "./types";

async function guarded<T>({ operation }: { operation: () => Promise<T> }): Promise<T> {
  try {
    return await withModelStoreLock({ operation });
  } catch (error) {
    logFailure({ stage: 'worker-operation', error });
    throw new LlamaCppBrowserError({ code: errorCode({ error }) });
  }
}
function eventQueue() {
  const pending = new Set<Promise<void>>(); let failed = false;
  return {
    send({ operation }: { operation: () => void | Promise<void> }): Promise<void> | undefined {
      if (failed) return undefined;
      // Invoke the proxy immediately, even inside a synchronous native progress
      // callback. Deferring it through .then() would hide CPU loading progress
      // until the entire Wasm call has returned. Drain acknowledgements at RPC end.
      try {
        const event = Promise.resolve(operation()).then(() => {}, error => {
          logFailure({ stage: 'worker-callback', error });
          failed = true;
        });
        pending.add(event);
        void event.then(() => pending.delete(event));
        return event;
      } catch (error) {
        logFailure({ stage: 'worker-callback', error });
        failed = true;
        return undefined;
      }
    },
    async finish(): Promise<void> {
      await Promise.all(pending);
      if (failed) throw new LlamaCppBrowserError({ code: "worker-failed" });
    },
  };
}
/** One RPC owns its reader; resident weights and KV state never borrow it. */
async function withBlobHost<T>({ host, callbacks, operation }: {
  host: WorkerBlobReadHost | undefined,
  callbacks: object[],
  operation: ({ blobs }: { blobs: BlobContext | undefined }) => Promise<T>,
}): Promise<T> {
  const blobs = host === undefined ? undefined : createWorkerBlobContext({ host });
  try {
    return await operation({ blobs });
  } finally {
    try {
      blobs?.dispose();
    } finally {
      for (const callback of new Set(callbacks)) releaseWorkerProxyArgument({ value: callback });
    }
  }
}
export function createWorkerApi(): WorkerServerApi<LlamaCppWorkerApi> {
  let active: { generationId: number, controller: AbortController } | undefined;
  let storageBusy = false;
  async function storageOperation<T>({ host, callbacks, operation }: {
    host: WorkerBlobReadHost | undefined,
    callbacks: object[],
    operation: ({ blobs }: { blobs: BlobContext | undefined }) => Promise<T>,
  }): Promise<T> {
    return withBlobHost({ host, callbacks, operation: async ({ blobs }) => {
      if (active || storageBusy) throw new LlamaCppBrowserError({ code: 'busy' });
      storageBusy = true;
      try {
        return await guarded({ operation: () => operation({ blobs }) });
      } finally {
        storageBusy = false;
      }
    } });
  }
  // Single-file and folder imports must share this lifetime: cancellation is
  // acknowledged only after the importer has closed its streams and rolled back.
  async function importWithCancellation({ generationId, report, operation }: {
    generationId: number,
    report: ({ progress }: { progress: Progress }) => void | Promise<void>,
    operation: ({ signal, onProgress }: { signal: AbortSignal, onProgress: ({ progress }: { progress: Progress }) => void }) => Promise<LocalModel>,
  }): Promise<LocalModel> {
    if (active || storageBusy) throw new LlamaCppBrowserError({ code: 'busy' });
    const controller = new AbortController(); active = { generationId, controller };
    const events = eventQueue();
    try {
      return await guarded({ operation: async () => modelSchema.parse(await operation({ signal: controller.signal, onProgress: ({ progress }) => {
        events.send({ operation: () => {
          if (!controller.signal.aborted) return report({ progress });
        } });
      } })) });
    } finally {
      try {
        await events.finish();
      } finally {
        active = undefined;
      }
    }
  }
  return {
    verifyStorage,
    async probeProfiles() {
      if (active || storageBusy) throw new LlamaCppBrowserError({ code: 'busy' });
      return profileCapabilitiesSchema.parse(await probeRuntimeProfiles());
    },
    async release() {
      if (active || storageBusy) throw new LlamaCppBrowserError({ code: 'busy' });
      await releaseSession({ releaseRuntime: true });
    },
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Top-level reverse proxy, not a nested callback.
    listModels: (host) => storageOperation({ host, callbacks: [], operation: async ({ blobs }) => modelsSchema.parse(await listStoredModels({ blobs })) }),
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Direct Comlink server signature, callback is a top-level argument.
    importModel: (request, onProgress, host) => withBlobHost({ host, callbacks: [onProgress], operation: async ({ blobs }) => {
      const { file, generationId } = z.object({ file: z.instanceof(File), generationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict().parse(request);
      return importWithCancellation({ generationId, report: ({ progress }) => onProgress(progress), operation: ({ signal, onProgress }) => importStoredModel({ file, signal, blobs, onProgress }) });
    } }),
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Direct Comlink server signature with a top-level callback.
    importDirectory: (request, onProgress, host) => withBlobHost({ host, callbacks: [onProgress], operation: async ({ blobs }) => {
      const { directory, generationId } = z.object({ directory: modelDirectoryInputSchema, generationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict().parse(request);
      return importWithCancellation({ generationId, report: ({ progress }) => onProgress(progress), operation: ({ signal, onProgress }) => importModelDirectory({ directory, signal, blobs, onProgress }) });
    } }),
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Direct Comlink server signature, validate the wire object before use.
    removeModel: (request, host) => storageOperation({ host, callbacks: [], operation: async ({ blobs }) => {
      const { plan } = z.object({ plan: deletionPlanSchema }).strict().parse(request);
      await invalidateStoredModel({ id: plan.id }); return removeStoredModel({ plan, blobs });
    } }),
    // Cancellation intentionally bypasses the store lock held by generation or imports.
    async cancelGeneration({ generationId }) {
      const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(generationId);
      if (active?.generationId === id) active.controller.abort();
    },
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Direct Comlink server signature, callbacks are top-level arguments.
    generate: (request, onEvent, onProgress, onDiagnostic, host, imageDecodeHost) => {
      const imageDecoder = imageDecodeHost === undefined ? undefined : createWorkerBlobImageDecoder({ host: imageDecodeHost, limits: IMAGE_DECODE_LIMITS });
      return withBlobHost({ host, callbacks: [onEvent, onProgress, ...(onDiagnostic ? [onDiagnostic] : [])], operation: async ({ blobs }) => {
        const { generationId, ...accepted } = workerGenerateCallSchema.parse(request);
        if (active || storageBusy) throw new LlamaCppBrowserError({ code: "busy" });
        const controller = new AbortController(); active = { generationId, controller };
        const events = eventQueue();
        const unsubscribe = subscribeDiagnostics({ debug: accepted.debug ?? 'off', listener: ({ diagnostic }) => {
          if (onDiagnostic && (diagnostic.event === 'operation-start' || diagnostic.event === 'operation-complete' || diagnostic.event === 'native-error' || diagnostic.event === 'native-node-start' || diagnostic.event === 'native-node-complete' || (diagnostic.event === 'native-info' && diagnostic.nativeOperation !== undefined))) {
            return events.send({ operation: async () => {
            // Keep diagnostics best-effort, but retain their proxy until already
            // emitted acknowledgements settle, just like progress and chunks.
              try {
                await onDiagnostic({ diagnostic });
              } catch { /* Diagnostic delivery does not fail inference. */ }
            } });
          }
          return undefined;
        } });
        try {
          const result = await guarded({ operation: () => generate({ request: accepted, blobs, imageDecoder, signal: controller.signal,
            onEvent: async ({ event }) => {
              // Preserve the message-parts ACK boundary: already accepted content
              // drains on Stop; consumer abandonment rejects the acknowledgement.
              const acceptedEvent = generationEventSchema.parse(event);
              try {
                await onEvent({ event: acceptedEvent });
              } catch {
                throw new LlamaCppBrowserError({ code: 'worker-failed' });
              }
            },
            onProgress: ({ progress }) => {
              events.send({ operation: () => {
                if (!controller.signal.aborted) return onProgress(progress);
              } });
            },
          }) });
          return generationResultSchema.parse(result);
        } finally {
          unsubscribe();
          // Finish proxy callbacks before resolving RPC; otherwise an old progress
          // callback could overwrite the next request or the service's idle state.
          try {
            await events.finish();
          } finally {
            active = undefined;
          }
        }
      } }).finally(() => imageDecoder?.dispose());
    },
  };
}
export const TEST_ONLY = {
};
