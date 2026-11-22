import { computed, ref, watch } from 'vue';
import { findModelDownloadJob, getDownloadQueue, jobIsBusy } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import type { RepositoryDownloadUsage } from '@/features/llama-cpp-browser/hugging-face/repository-row-download';
import { installedRepositoryVariant, installedSelection } from '@/features/llama-cpp-browser/hugging-face/storage';
import { llamaCppBrowserModelFiles } from '@/features/llama-cpp-browser/model-files';
import { hostModelDirectoryRegistrationChangeEvent } from '@/logic/host-model-directories';
import { isHostDestination } from '@/features/llama-cpp-browser/runtime/model-destination-types';
import { matchesRepositoryDownload, repositorySearchDownloadKey } from './acquire-repository-model';
import { repositoryModelDownloadIdentity, type RepositoryModelSelection } from './bundled-repository-target';

export function watchRepositoryDownloadHint({ selection, usage, update }: {
  selection: RepositoryModelSelection,
  usage: RepositoryDownloadUsage,
  update({ hidden }: { hidden: boolean }): void,
}): () => void {
  const { source, destination } = selection;
  const linkedFolder = isHostDestination(destination);
  const queue = getDownloadQueue();
  const identity = repositoryModelDownloadIdentity({ source });
  const defaultKey = repositorySearchDownloadKey({ selection, usage });
  const matchingJob = computed(() => findModelDownloadJob({ jobs: queue.jobs.value, destination, ...identity }));
  const matchingDefault = computed(() => {
    if (defaultKey === undefined) {
      return undefined;
    }
    const job = findModelDownloadJob({ jobs: queue.jobs.value, key: defaultKey, destination, selection: undefined });
    return matchesRepositoryDownload({ selection, files: job?.selection }) ? job : undefined;
  });
  const active = computed(() => jobIsBusy({ job: matchingJob.value }) || jobIsBusy({ job: matchingDefault.value }));
  const prepared = computed(() => identity.selection ?? [matchingJob.value, matchingDefault.value].find(job => job?.status === 'complete')?.selection);
  const inventoryRevision = ref(0);
  const storageChanged = () => {
    inventoryRevision.value++;
  };
  const unsubscribe = llamaCppBrowserModelFiles.subscribeModelList({ listener: storageChanged });
  window.addEventListener('focus', storageChanged);
  if (linkedFolder) {
    window.addEventListener(hostModelDirectoryRegistrationChangeEvent, storageChanged);
  }

  async function isInstalled({ signal }: { signal: AbortSignal }): Promise<boolean> {
    const plan = prepared.value;
    if (plan !== undefined && await installedSelection({ selection: plan, destination }) !== undefined) {
      return true;
    }
    signal.throwIfAborted();
    switch (source.kind) {
    case 'resolved': return false;
    case 'bundled': return await installedRepositoryVariant({ repository: source.repository, variant: source.variant, requireProjector: source.companionPath !== undefined, destination, expectedRoot: undefined, signal }) !== undefined;
    default: throw new Error(String(source satisfies never));
    }
  }

  const stop = watch([active, prepared, inventoryRevision, queue.changed], ([busy], _, onCleanup) => {
    if (busy) {
      update({ hidden: true });
      return;
    }
    // The queue reports progress but saved files determine readiness. Recheck
    // on completion and on file edits, even after the selector has closed.
    const check = new AbortController();
    onCleanup(() => check.abort());
    void isInstalled({ signal: check.signal }).catch(() => false).then(hidden => {
      if (!check.signal.aborted) {
        update({ hidden });
      }
    });
  }, { immediate: true });
  return () => {
    stop();
    unsubscribe();
    window.removeEventListener('focus', storageChanged);
    if (linkedFolder) {
      window.removeEventListener(hostModelDirectoryRegistrationChangeEvent, storageChanged);
    }
  };
}

export const TEST_ONLY = {
};
