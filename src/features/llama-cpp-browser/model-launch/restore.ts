import { storageService } from '@/00-storage/service';
import type { HostModelDirectoryHandle } from '@/00-storage/service/host-model-handles';
import type { ModelLaunchTarget } from '@/01-models/llama-cpp-browser-model-launch';
import type { DownloadDestination } from '@/01-models/download';
import { isMissing, readJournal, repositoryFolder } from '@/features/llama-cpp-browser/hugging-face/storage';
import type { DownloadJournal } from '@/features/llama-cpp-browser/hugging-face/types';
import { formatHostModelId, resolveHostModelLocation } from '@/features/llama-cpp-browser/runtime/host-model-aliases';
import { hostModelRoot } from '@/features/llama-cpp-browser/runtime/model-destination';
import { targetForSelection } from './target';
import { readModelLaunchReference } from './reference';

/** A legacy aggregate journal observation, without Start/group/defaults authority.
 * Current per-file sidecars cannot prove a full model selection after reload.
 */
export type ObservedLegacyModelDownload = {
  effectiveModelId: string,
  target: ModelLaunchTarget,
  destination: DownloadDestination,
  expectedRoot: HostModelDirectoryHandle | undefined,
  journal: DownloadJournal,
};

/** Read one legacy aggregate journal for the currently resolved binding, without
 * remote metadata or new file permission. Modern per-file-only downloads and
 * installed files use ordinary Chat recovery with an explicit new Review;
 * neither sidecars nor history reconstruct a full selection or Start receipt.
 */
export async function observeLegacyModelDownload({ modelId, signal }: { modelId: string, signal: AbortSignal }): Promise<ObservedLegacyModelDownload | undefined> {
  signal.throwIfAborted();
  let repository: string;
  let destination: DownloadDestination;
  let expectedRoot: HostModelDirectoryHandle | undefined;
  let publicModelId: ({ target }: { target: ModelLaunchTarget }) => string;
  if (modelId.startsWith('host/')) {
    const directories = await storageService.loadHostModelDirectories();
    signal.throwIfAborted();
    const location = resolveHostModelLocation({ modelId, directories });
    repository = location.repository;
    destination = { kind: 'host', directoryId: location.directoryId };
    expectedRoot = await hostModelRoot({ destination, mode: 'read' });
    publicModelId = ({ target }) => formatHostModelId({ directoryId: location.directoryId, repository, primaryRelativePath: target.mainFilePath, directories });
  } else {
    const reference = readModelLaunchReference({ modelId });
    if (reference === undefined) {
      return undefined;
    }
    repository = reference.repository;
    destination = { kind: 'opfs' };
    publicModelId = ({ target }) => target.modelId;
  }
  signal.throwIfAborted();
  try {
    const folder = await repositoryFolder({ repository, create: false, destination });
    const journal = await readJournal({ folder });
    signal.throwIfAborted();
    if (journal.selection.repository !== repository) {
      return undefined;
    }
    const target = targetForSelection({ selection: journal.selection });
    return publicModelId({ target }) === modelId ? { effectiveModelId: modelId, target, destination, expectedRoot, journal } : undefined;
  } catch (error) {
    signal.throwIfAborted();
    if (isMissing({ error })) {
      return undefined;
    }
    throw error;
  }
}

export const TEST_ONLY = {
};
