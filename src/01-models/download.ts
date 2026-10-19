/** Session-only download state. These are not persisted settings or history DTOs. */
export type DownloadDestination = { kind: 'opfs' } | { kind: 'host', directoryId: string };
export type DownloadFileState = 'queued' | 'checking' | 'transferring' | 'verifying' | 'complete';
export type DownloadFile = {
  name: string,
  url: string,
  destination: string,
  size: number | undefined,
  completed: number,
  state: DownloadFileState,
};
export type ManagedDownloadStatus = 'queued' | 'resolving' | 'downloading' | 'pausing' | 'paused' | 'failed' | 'complete' | 'cancelling' | 'cancelled';
export type ManagedDownload = {
  id: number,
  key: string,
  title: string,
  category: 'language-model' | 'image-model' | 'file',
  destination: DownloadDestination,
  status: ManagedDownloadStatus,
  files: readonly DownloadFile[],
  error: string | undefined,
};

export const TEST_ONLY = {
};
