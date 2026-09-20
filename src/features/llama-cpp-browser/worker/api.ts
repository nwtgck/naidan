import { logFailure } from '@/features/llama-cpp-browser/debug-log';
import { z } from "zod";
import type { WorkerServerApi } from "@/utils/worker-transport";
import { errorCode, generationResultSchema, LlamaCppBrowserError, modelSchema, modelsSchema } from "@/features/llama-cpp-browser/types";
import { importStoredModel, listStoredModels, removeStoredModel, withModelStoreLock } from "@/features/llama-cpp-browser/runtime/model-store";
import { invalidateStoredModel } from "./session";
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
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Direct Comlink server signature, validate the wire object before use.
    removeModel: (request) => guarded({ operation: async () => {
      const { id } = z.object({ id: modelSchema.shape.id }).strict().parse(request);
      await invalidateStoredModel({ id }); await removeStoredModel({ id });
    } }),
    // Cancellation intentionally bypasses the store lock held by generation.
    async cancelGeneration({ generationId }) {
      const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(generationId);
      if (active?.generationId === id) active.controller.abort();
    },
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Direct Comlink server signature, callbacks are top-level arguments.
    async generate(request, onChunk, onProgress) {
      const { generationId, ...accepted } = workerGenerateCallSchema.parse(request);
      if (active) throw new LlamaCppBrowserError({ code: "busy" });
      const controller = new AbortController(); active = { generationId, controller };
      const events = eventQueue();
      try {
        const result = await guarded({ operation: () => generate({ request: accepted, signal: controller.signal,
          onChunk: ({ chunk }) => {
            events.send({ operation: () => {
              if (!controller.signal.aborted) return onChunk({ text: chunk });
            } });
          },
          onProgress: ({ progress }) => {
            events.send({ operation: () => {
              if (!controller.signal.aborted) return onProgress(progress);
            } });
          },
        }) });
        return generationResultSchema.parse(result);
      } finally {
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
