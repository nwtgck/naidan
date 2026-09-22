import type { WorkerBlobImageHost } from '../../../src/utils/worker-blob-image';
import type { DownloadWriterApi } from '../../../src/features/llama-cpp-browser/hugging-face/writer';
import type { LlamaCppWorkerApi } from '../../../src/features/llama-cpp-browser/worker/types';
import type { IWeshWorker } from '../../../src/features/wesh/worker/types';
import type { Endpoint } from 'comlink';
import type { BlobView } from '../../../src/utils/blob-view';
import type { WorkerBlobReadHost } from '../../../src/utils/worker-blob-context';
import { wrapWorkerRemote, type WorkerProxy } from '../../../src/utils/worker-transport';

declare const endpoint: Endpoint;
interface GoodApi {
  prepare(host: WorkerProxy<WorkerBlobReadHost>, images?: WorkerProxy<WorkerBlobImageHost>): Promise<void>,
  read(): Promise<Blob>,
}
interface NestedHostApi {
  prepare(options: { host: WorkerProxy<WorkerBlobReadHost> }): Promise<void>,
}
interface IncorrectViewApi {
  read(): Promise<BlobView>,
}
wrapWorkerRemote<GoodApi>({ endpoint });
wrapWorkerRemote<NestedHostApi>({ endpoint });
wrapWorkerRemote<IncorrectViewApi>({ endpoint });
wrapWorkerRemote<IWeshWorker>({ endpoint });
wrapWorkerRemote<LlamaCppWorkerApi>({ endpoint });
wrapWorkerRemote<DownloadWriterApi>({ endpoint });
