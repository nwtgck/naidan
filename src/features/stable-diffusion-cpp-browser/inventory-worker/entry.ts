import { exposeWorkerRemote } from '@/utils/worker-transport';
import { createInventoryWorker } from './impl';
import type { InventoryWorker } from './types';
exposeWorkerRemote<InventoryWorker>({ api: createInventoryWorker(), endpoint: undefined });
export const TEST_ONLY = {
};
