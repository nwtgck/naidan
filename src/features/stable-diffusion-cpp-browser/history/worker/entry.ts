import { exposeWorkerRemote } from '@/utils/worker-transport';
import { createImageHistoryWorker } from './impl';
import type { ImageHistoryWorker } from './types';

exposeWorkerRemote<ImageHistoryWorker>({ api: createImageHistoryWorker(), endpoint: undefined });

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
