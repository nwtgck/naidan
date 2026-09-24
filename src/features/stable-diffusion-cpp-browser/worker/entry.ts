import { exposeWorkerRemote } from '@/utils/worker-transport';
import { createImageWorker } from './impl';
import type { ImageWorker } from './types';
exposeWorkerRemote<ImageWorker>({ api: createImageWorker(), endpoint: undefined });
export const TEST_ONLY = {
};
