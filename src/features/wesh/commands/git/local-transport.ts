import { normalizePath } from '@/features/wesh/path';
import { getConfigValue } from './config';
import type { GitConfig } from './config';
import type { GitFiles } from './files';
import { replaceTextViaLock } from './files';
import { transferReachableObjects } from './object-transfer';
import { isAncestor } from './graph';
import { deleteRef, listRefs, readHead, readRef, writeRef } from './refs';
import type { GitRepository } from './repository';
import { discoverRepositoryAtPath, joinPath } from './repository';

export interface GitLocalRemoteBranchUpdate {
  branchName: string,
  oldObjectId: string | undefined,
  newObjectId: string,
}

export interface GitLocalRemotePrunedBranch {
  branchName: string,
  oldObjectId: string,
}

interface GitLocalRefMutation {
  repository: GitRepository,
  refName: string,
  objectId: string | undefined,
}

interface GitLocalRefState extends GitLocalRefMutation {
  objectId: string | undefined,
}

function transportErrorMessage({ error }: { error: unknown }): string {
  return error instanceof Error ? error.message : String(error);
}

async function restoreLocalRefState({ files, state }: {
  files: GitFiles,
  state: GitLocalRefState,
}): Promise<void> {
  if (state.objectId === undefined) {
    await deleteRef({ files, repository: state.repository, refName: state.refName });
    return;
  }
  await writeRef({ files, repository: state.repository, refName: state.refName, objectId: state.objectId });
}

async function applyLocalRefMutationsWithRollback({ files, mutations, finalize }: {
  files: GitFiles,
  mutations: readonly GitLocalRefMutation[],
  finalize?: () => Promise<void>,
}): Promise<void> {
  const seen = new Set<string>();
  const previousStates: GitLocalRefState[] = [];
  for (const mutation of mutations) {
    const key = `${mutation.repository.commonDirPath}\0${mutation.refName}`;
    if (seen.has(key)) throw new Error(`duplicate local ref transaction target: ${mutation.refName}`);
    seen.add(key);
    previousStates.push({
      ...mutation,
      objectId: await readRef({ files, repository: mutation.repository, refName: mutation.refName }),
    });
  }

  let appliedCount = 0;
  try {
    for (const mutation of mutations) {
      if (mutation.objectId === undefined) {
        await deleteRef({ files, repository: mutation.repository, refName: mutation.refName });
      } else {
        await writeRef({ files, repository: mutation.repository, refName: mutation.refName, objectId: mutation.objectId });
      }
      appliedCount += 1;
    }
    if (finalize !== undefined) await finalize();
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (let index = appliedCount - 1; index >= 0; index -= 1) {
      const state = previousStates[index]!;
      try {
        await restoreLocalRefState({ files, state });
      } catch (rollbackError) {
        rollbackErrors.push(`${state.refName}: ${transportErrorMessage({ error: rollbackError })}`);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(`${transportErrorMessage({ error })}; local ref rollback also failed: ${rollbackErrors.join('; ')}`);
    }
    throw error;
  }
}

export interface GitLocalFetchResult {
  remoteName: string,
  sourcePath: string,
  branchUpdates: GitLocalRemoteBranchUpdate[],
  prunedBranches: GitLocalRemotePrunedBranch[],
}

export function assertLocalRepositoryLocation({ location }: { location: string }): void {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(location)
    || /^[^/]+@[^:]+:/u.test(location)
    || (!location.startsWith('./') && !location.startsWith('../') && /^[^/]+:/u.test(location))) {
    throw new Error(`network repository access is disabled: ${location}`);
  }
}

export async function resolveLocalRemote({ files, repository, remoteName, config }: {
  files: GitFiles,
  repository: GitRepository,
  remoteName: string,
  config: GitConfig,
}): Promise<{ remotePath: string, remoteRepository: GitRepository, bare: boolean }> {
  const location = getConfigValue({ config, key: `remote.${remoteName}.url` });
  if (location === undefined) throw new Error(`'${remoteName}' does not appear to be a git repository`);
  assertLocalRepositoryLocation({ location });
  const remotePath = normalizePath({ cwd: repository.worktreePath, path: location });
  const { repository: remoteRepository, bare } = await discoverRepositoryAtPath({ files, path: remotePath });
  return { remotePath, remoteRepository, bare };
}

export async function fetchLocalRemote({ files, repository, remoteName, prune = false, config }: {
  files: GitFiles,
  repository: GitRepository,
  remoteName: string,
  prune?: boolean,
  config: GitConfig,
}): Promise<GitLocalFetchResult> {
  const { remotePath: sourcePath, remoteRepository } = await resolveLocalRemote({ files, repository, remoteName, config });
  const sourceHeads = await listRefs({ files, repository: remoteRepository, prefix: 'refs/heads' });
  const sourceTags = await listRefs({ files, repository: remoteRepository, prefix: 'refs/tags' });
  for (const tag of sourceTags) {
    const current = await readRef({ files, repository, refName: tag.refName });
    if (current !== undefined && current !== tag.objectId) {
      throw new Error(`would clobber existing tag '${tag.refName.slice('refs/tags/'.length)}'`);
    }
  }
  await transferReachableObjects({
    files,
    sourceRepository: remoteRepository,
    destinationRepository: repository,
    rootObjectIds: [...sourceHeads, ...sourceTags].map(ref => ref.objectId),
  });

  const branchUpdates: GitLocalRemoteBranchUpdate[] = [];
  const mutations: GitLocalRefMutation[] = [];
  for (const ref of sourceHeads) {
    const branchName = ref.refName.slice('refs/heads/'.length);
    const trackingRefName = `refs/remotes/${remoteName}/${branchName}`;
    const oldObjectId = await readRef({ files, repository, refName: trackingRefName });
    mutations.push({ repository, refName: trackingRefName, objectId: ref.objectId });
    branchUpdates.push({ branchName, oldObjectId, newObjectId: ref.objectId });
  }
  for (const tag of sourceTags) {
    if (await readRef({ files, repository, refName: tag.refName }) === undefined) {
      mutations.push({ repository, refName: tag.refName, objectId: tag.objectId });
    }
  }

  const prunedBranches: GitLocalRemotePrunedBranch[] = [];
  if (prune) {
    const sourceBranchNames = new Set(sourceHeads.map(ref => ref.refName.slice('refs/heads/'.length)));
    const trackingPrefix = `refs/remotes/${remoteName}`;
    for (const ref of await listRefs({ files, repository, prefix: trackingPrefix })) {
      if (ref.symbolicTargetRefName !== undefined) continue;
      const branchName = ref.refName.slice(`${trackingPrefix}/`.length);
      if (branchName === 'HEAD' || sourceBranchNames.has(branchName)) continue;
      mutations.push({ repository, refName: ref.refName, objectId: undefined });
      prunedBranches.push({ branchName, oldObjectId: ref.objectId });
    }
  }

  const fetchHead = sourceHeads
    .map(ref => `${ref.objectId}\tnot-for-merge\tbranch '${ref.refName.slice('refs/heads/'.length)}' of ${sourcePath}\n`)
    .join('');
  await applyLocalRefMutationsWithRollback({
    files,
    mutations,
    finalize: () => replaceTextViaLock({
      files,
      path: joinPath({ base: repository.gitDirPath, child: 'FETCH_HEAD' }),
      text: fetchHead,
    }),
  });
  return { remoteName, sourcePath, branchUpdates, prunedBranches };
}

export interface GitLocalPushResult {
  remoteName: string,
  remotePath: string,
  branchName: string,
  oldObjectId: string | undefined,
  newObjectId: string,
  forced: boolean,
}

export async function pushLocalBranch({ files, repository, remoteName, sourceBranch, destinationBranch, forceWithLease, config }: {
  files: GitFiles,
  repository: GitRepository,
  remoteName: string,
  sourceBranch: string,
  destinationBranch: string,
  forceWithLease: boolean,
  config: GitConfig,
}): Promise<GitLocalPushResult> {
  const sourceObjectId = await readRef({ files, repository, refName: `refs/heads/${sourceBranch}` });
  if (sourceObjectId === undefined) throw new Error(`src refspec ${sourceBranch} does not match any`);
  const { remotePath, remoteRepository, bare } = await resolveLocalRemote({ files, repository, remoteName, config });
  const destinationRefName = `refs/heads/${destinationBranch}`;
  if (!bare) {
    const remoteHead = await readHead({ files, repository: remoteRepository });
    if (remoteHead.symbolicRef === destinationRefName) {
      throw new Error(`refusing to update checked out branch: ${destinationRefName}`);
    }
  }
  const oldObjectId = await readRef({ files, repository: remoteRepository, refName: destinationRefName });
  const expectedLease = await readRef({
    files,
    repository,
    refName: `refs/remotes/${remoteName}/${destinationBranch}`,
  });
  if (forceWithLease && oldObjectId !== expectedLease) {
    throw new Error(`stale info: ${destinationRefName}`);
  }

  let forced = false;
  if (oldObjectId !== undefined && oldObjectId !== sourceObjectId) {
    const fastForward = await isAncestor({
      files,
      repository,
      cache: undefined,
      ancestorObjectId: oldObjectId,
      descendantObjectId: sourceObjectId,
    });
    if (!fastForward) {
      if (!forceWithLease) throw new Error(`non-fast-forward update rejected for ${destinationRefName}`);
      forced = true;
    }
  }

  await transferReachableObjects({
    files,
    sourceRepository: repository,
    destinationRepository: remoteRepository,
    rootObjectIds: [sourceObjectId],
  });
  await applyLocalRefMutationsWithRollback({
    files,
    mutations: [
      { repository: remoteRepository, refName: destinationRefName, objectId: sourceObjectId },
      {
        repository,
        refName: `refs/remotes/${remoteName}/${destinationBranch}`,
        objectId: sourceObjectId,
      },
    ],
  });
  return {
    remoteName,
    remotePath,
    branchName: destinationBranch,
    oldObjectId,
    newObjectId: sourceObjectId,
    forced,
  };
}

export async function deleteLocalRemoteBranch({ files, repository, remoteName, branchName, forceWithLease, config }: {
  files: GitFiles,
  repository: GitRepository,
  remoteName: string,
  branchName: string,
  forceWithLease: boolean,
  config: GitConfig,
}): Promise<{ remotePath: string, oldObjectId: string }> {
  const { remotePath, remoteRepository, bare } = await resolveLocalRemote({ files, repository, remoteName, config });
  const refName = `refs/heads/${branchName}`;
  if (!bare) {
    const remoteHead = await readHead({ files, repository: remoteRepository });
    if (remoteHead.symbolicRef === refName) throw new Error(`refusing to delete the current branch: ${refName}`);
  }
  const oldObjectId = await readRef({ files, repository: remoteRepository, refName });
  if (oldObjectId === undefined) throw new Error(`remote ref does not exist: ${branchName}`);
  if (forceWithLease) {
    const expectedLease = await readRef({
      files,
      repository,
      refName: `refs/remotes/${remoteName}/${branchName}`,
    });
    if (oldObjectId !== expectedLease) throw new Error(`stale info: ${refName}`);
  }
  await applyLocalRefMutationsWithRollback({
    files,
    mutations: [
      { repository: remoteRepository, refName, objectId: undefined },
      { repository, refName: `refs/remotes/${remoteName}/${branchName}`, objectId: undefined },
    ],
  });
  return { remotePath, oldObjectId };
}

export const TEST_ONLY = {
  applyLocalRefMutationsWithRollback,
};
