import { findModelDownloadJob, getDownloadQueue, jobIsBusy } from './download-queue';
import type { DownloadDestination } from '@/01-models/download';
import type { RepositoryCatalog } from './catalog';
import { selectionKey } from './download-plan';
import { getMetadataSession } from './metadata-session';
import type { DownloadSelection } from './types';

export type RepositoryModelDownloadRequest = {
  key: string,
  repository: string,
  source: 'suggestion' | 'repository',
  destination: DownloadDestination,
  prepared?: DownloadSelection | undefined,
  prepare({ signal }: { signal: AbortSignal }): Promise<DownloadSelection>,
};

export type RepositoryDownloadUsage = 'chat' | 'transcription' | 'audio-generation' | 'live-conversation' | 'translation';

export function repositoryDefaultDownloadKey({ repository, usage }: { repository: string, usage: RepositoryDownloadUsage }): string {
  return `repository-default:${usage}:${repository.toLowerCase()}`;
}

export function hasActiveRepositoryDefaultDownload({ repository, usage, destination }: { repository: string, usage: RepositoryDownloadUsage, destination: DownloadDestination }): boolean {
  const key = repositoryDefaultDownloadKey({ repository, usage });
  return jobIsBusy({ job: findModelDownloadJob({ jobs: getDownloadQueue().jobs.value, key, destination, selection: undefined }) });
}

export function repositoryRowDownload({ repository, destination, usage, selection, defaultSelection }: {
  repository: string,
  destination: DownloadDestination,
  usage: RepositoryDownloadUsage,
  selection: DownloadSelection | undefined,
  defaultSelection({ catalog }: { catalog: RepositoryCatalog }): DownloadSelection,
}): RepositoryModelDownloadRequest {
  return {
    key: selection === undefined ? repositoryDefaultDownloadKey({ repository, usage }) : selectionKey({ selection }),
    repository,
    destination,
    source: 'repository' as const,
    prepared: selection,
    async prepare({ signal }: { signal: AbortSignal }) {
      if (selection !== undefined) {
        return selection;
      }
      const catalog = await getMetadataSession().inspect({ input: repository, signal, freshness: 'reuse' });
      signal.throwIfAborted();
      return defaultSelection({ catalog });
    },
  };
}

export const TEST_ONLY = {
};
