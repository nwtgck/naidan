import { z } from 'zod';
import { exposeWorkerRemote, type WorkerServerApi } from '@/utils/worker-transport';
import { errorCode, LlamaCppBrowserError, modelSchema, modelsSchema } from '@/features/llama-cpp-browser/types';
import { importStoredModel, listStoredModels, removeStoredModel, withModelStoreLock } from '@/features/llama-cpp-browser/runtime/model-store';
import { generate } from './generation';
import { workerGenerateInputSchema, type LlamaCppWorkerApi } from './types';

async function guarded<T>({ operation }: { operation: () => Promise<T> }): Promise<T> {
  try {
    return await withModelStoreLock({ operation });
  } catch (error) {
    throw new LlamaCppBrowserError({ code: errorCode({ error }) });
  }
}
const api: WorkerServerApi<LlamaCppWorkerApi> = {
  listModels: () => guarded({ operation: async () => modelsSchema.parse(await listStoredModels()) }),
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Direct Comlink server signature; validate the original cloned argument below.
  importModel: (request, onProgress) => guarded({ operation: async () => {
    const { file } = z.object({ file: z.instanceof(File) }).strict().parse(request);
    return modelSchema.parse(await importStoredModel({ file, onProgress: ({ progress }) => {
      onProgress(progress);
    } }));
  } }),
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Direct Comlink server signature; validate the original cloned argument below.
  removeModel: (request) => guarded({ operation: async () => {
    const { id } = z.object({ id: z.uuid() }).strict().parse(request); await removeStoredModel({ id });
  } }),
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Direct Comlink server signature; validate the original cloned argument below.
  generate: (request, onChunk, onProgress) => guarded({ operation: async () => {
    const accepted = workerGenerateInputSchema.parse(request);
    await generate({ request: accepted, onChunk: ({ chunk }) => {
      onChunk({ text: chunk });
    }, onProgress: ({ progress }) => {
      onProgress(progress);
    } });
  } }),
};
exposeWorkerRemote<LlamaCppWorkerApi>({ api, endpoint: undefined });
export const TEST_ONLY = {
};
