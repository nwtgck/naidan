import { wrapWorkerRemote } from '@/utils/worker-transport';
import { createStandaloneWorker } from 'virtual:file-protocol-standalone/worker/image-generation-query';
import { createLazyImageQuerySession } from '@/features/image-generation/workers/lazy-query-session';
import { generationQueryResultSchema, generationQueryToWire, type ImageGenerationQueryClient, type ImageGenerationQueryWorker } from './types';

export function createImageGenerationQueryClient(): ImageGenerationQueryClient {
  const session = createLazyImageQuerySession<ImageGenerationQueryWorker>({ createWorker: createStandaloneWorker, createRemote: ({ worker }) => wrapWorkerRemote<ImageGenerationQueryWorker>({ endpoint: worker }) });
  return { query: ({ store, sessionId, query }) => session.invoke({ run: async ({ remote }) => generationQueryResultSchema.parse(await remote.query({ request: generationQueryToWire({ value: { store, sessionId, query } }) })) }), dispose: session.dispose };
}

export const TEST_ONLY = {
};
