import { exposeWorkerRemote } from '@/utils/worker-transport';
import { createFileDownloadWorker } from './impl';
import type { FileDownloadWorker } from './types';
exposeWorkerRemote<FileDownloadWorker>({ api: createFileDownloadWorker(), endpoint: undefined });
export const TEST_ONLY = {
};
