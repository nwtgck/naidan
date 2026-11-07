import { FILE_SYSTEM_HANDLE_CLONING_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION } from '@/utils/worker-transport-capabilities';
import type { WorkerProxy, WorkerCapability } from '@/utils/worker-transport';
import type { HuggingFaceDownloadRequest } from '@/logic/hugging-face-download/acquire';
import type { DownloadStreamFetch } from '@/logic/hugging-face-download/fetch-types';
import type { FileDownloadProgress } from '@/logic/hugging-face-download/progress';
export type FileDownloadRequest = {
  files: HuggingFaceDownloadRequest['files'],
  destination: HuggingFaceDownloadRequest['destination'],
  expectedRoot: FileSystemDirectoryHandle | undefined,
  validation: 'model-weight' | 'none',
};
export type FileDownloadWorker = {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Worker transport callbacks are separate proxied arguments.
  download(input: WorkerCapability<FileDownloadRequest, typeof FILE_SYSTEM_HANDLE_CLONING_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION>, onProgress: WorkerProxy<({ progress }: { progress: FileDownloadProgress }) => void>, fetch: WorkerProxy<DownloadStreamFetch>): Promise<void>,
  cancel(): void,
  verifyStorage: ({ probeId }: { probeId: string }) => Promise<boolean>,
};
export const TEST_ONLY = {
};
