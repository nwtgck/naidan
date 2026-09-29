import { exposeWorkerRemote } from '@/utils/worker-transport';
import { createDownloadWriter, type DownloadWriterApi } from './writer';
exposeWorkerRemote<DownloadWriterApi>({ api: createDownloadWriter(), endpoint: undefined });
export const TEST_ONLY = {
};
