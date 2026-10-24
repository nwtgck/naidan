import { exactObject } from '@/utils/exact-object';

/** Storage selected for a download or a page-local model launch operation. */
export type DownloadDestination = { kind: 'opfs' } | { kind: 'host', directoryId: string };

export function cloneDownloadDestination({ destination }: { destination: DownloadDestination }): DownloadDestination {
  switch (destination.kind) {
  case 'opfs': {
    const { kind, ...unhandled } = destination;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<DownloadDestination, { kind: 'opfs' }>>()({ kind });
  }
  case 'host': {
    const { kind, directoryId, ...unhandled } = destination;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<DownloadDestination, { kind: 'host' }>>()({ kind, directoryId });
  }
  default: {
    const exhaustive: never = destination;
    throw new Error(String(exhaustive));
  }
  }
}

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
