import { probeRuntimeProfiles } from '@/features/llama-cpp-browser/runtime/detect-profile';
import { profileCapabilitiesSchema } from '@/features/llama-cpp-browser/runtime/profile-capabilities';
import { verifyStorage } from '@/features/llama-cpp-browser/runtime/shared-storage-probe';
import { deletionPlanSchema } from '@/features/llama-cpp-browser/runtime/deletion-plan';
import { importModelDirectory } from '@/features/llama-cpp-browser/runtime/model-directory';
import { logFailure, subscribeDiagnostics } from '@/features/llama-cpp-browser/debug-log';
import { z } from "zod";
import type { WorkerServerApi } from "@/utils/worker-transport";
import { errorCode, modelDirectoryInputSchema, generationResultSchema, generationEventSchema, LlamaCppBrowserError, modelSchema, modelsSchema } from "@/features/llama-cpp-browser/types";
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
    send({ operation }: { operation: () => void | Promise<void> }): void {
      if (failed) return;
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
      } catch (error) {
        logFailure({ stage: 'worker-callback', error });
        failed = true;
      }
    },
    async finish(): Promise<void> {
      await Promise.all(pending);
      if (failed) throw new LlamaCppBrowserError({ code: "worker-failed" });
    },
  };
}
export function createWorkerApi(): WorkerServerApi<LlamaCppWorkerApi> {
  let active: { generationId: number, controller: AbortController } | undefined;
  return {
    verifyStorage,
    async probeProfiles() {
      if (active) throw new LlamaCppBrowserError({ code: 'busy' });
      return profileCapabilitiesSchema.parse(await probeRuntimeProfiles());
    },
    async release() {
      if (active) throw new LlamaCppBrowserError({ code: 'busy' });
      await releaseSession({ releaseRuntime: true });
    },
    listModels: () => guarded({ operation: async () => modelsSchema.parse(await listStoredModels()) }),
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Direct Comlink server signature, callback is a top-level argument.
    importModel: (request, onProgress) => guarded({ operation: async () => {
      const { file } = z.object({ file: z.instanceof(File) }).strict().parse(request);
      const events = eventQueue();
      try {
        return modelSchema.parse(await importStoredModel({ file, onProgress: ({ progress }) => {
          events.send({ operation: () => onProgress(progress) });
        } }));
      } finally {
        await events.finish();
      }
    } }),
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Direct Comlink server signature with a top-level callback.
    importDirectory: async (request, onProgress) => {
      const { directory, generationId } = z.object({ directory: modelDirectoryInputSchema, generationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict().parse(request);
      if (active) throw new LlamaCppBrowserError({ code: 'busy' });
      const controller = new AbortController(); active = { generationId, controller };
      const events = eventQueue();
      try {
        return await guarded({ operation: async () => modelSchema.parse(await importModelDirectory({ directory, signal: controller.signal, onProgress: ({ progress }) => {
          events.send({ operation: () => {
            if (!controller.signal.aborted) return onProgress(progress);
          } });
        } })) });
      } finally {
        try {
          await events.finish();
        } finally {
          active = undefined;
        }
      }
    },
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Direct Comlink server signature, validate the wire object before use.
    removeModel: (request) => guarded({ operation: async () => {
      const { plan } = z.object({ plan: deletionPlanSchema }).strict().parse(request);
      await invalidateStoredModel({ id: plan.id }); return removeStoredModel({ plan });
    } }),
    // Cancellation intentionally bypasses the store lock held by generation.
    async cancelGeneration({ generationId }) {
      const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(generationId);
      if (active?.generationId === id) active.controller.abort();
    },
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Direct Comlink server signature, callbacks are top-level arguments.
    async generate(request, onEvent, onProgress, onDiagnostic) {
      const { generationId, ...accepted } = workerGenerateCallSchema.parse(request);
      if (active) throw new LlamaCppBrowserError({ code: "busy" });
      const controller = new AbortController(); active = { generationId, controller };
      const events = eventQueue();
      const unsubscribe = subscribeDiagnostics({ debug: accepted.debug ?? 'off', listener: ({ diagnostic }) => {
        if (onDiagnostic && (diagnostic.event === 'operation-start' || diagnostic.event === 'operation-complete' || diagnostic.event === 'native-error' || diagnostic.event === 'native-node-start' || diagnostic.event === 'native-node-complete' || (diagnostic.event === 'native-info' && diagnostic.nativeOperation !== undefined))) return Promise.resolve(onDiagnostic({ diagnostic }));
        return undefined;
      } });
      try {
        const result = await guarded({ operation: () => generate({ request: accepted, signal: controller.signal,
          onEvent: async ({ event }) => {
            // Already accepted content is drained on Stop; consumer abandonment rejects the ACK.
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
    },
  };
}
export const TEST_ONLY = {
};
