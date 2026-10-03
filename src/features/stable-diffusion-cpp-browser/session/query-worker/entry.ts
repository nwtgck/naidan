import { exposeWorkerRemote } from '@/utils/worker-transport';
import { createImageGenerationQueryWorker } from './impl';
import type { ImageGenerationQueryWorker } from './types';
exposeWorkerRemote<ImageGenerationQueryWorker>({ api: createImageGenerationQueryWorker(), endpoint: undefined });
export const TEST_ONLY = {
};
