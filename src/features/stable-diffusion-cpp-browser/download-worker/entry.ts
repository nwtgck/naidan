import { exposeWorkerRemote } from '@/utils/worker-transport';
import { createImageDownloadWorker } from './impl';
import type { ImageDownloadWorker } from './types';
exposeWorkerRemote<ImageDownloadWorker>({ api: createImageDownloadWorker(), endpoint: undefined });
export const TEST_ONLY = {
};
