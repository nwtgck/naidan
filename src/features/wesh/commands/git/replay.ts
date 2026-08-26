import { parseCommitAuthor, readCommit } from './commits';
import type { GitCommitAuthor, ParsedCommit } from './commits';
import type { GitFiles } from './files';
import type { GitIndexEntry } from './index-file';
import { autoMergeTextConflicts } from './text-merge';
import type { GitTreeMergeConflict } from './merge-tree';
import { mergeThreeTrees } from './merge-tree';
import type { GitRepository } from './repository';
import type { GitReplayKind } from './replay-state';
import { readTreeIntoIndex } from './tree';

export interface GitPreparedReplay {
  kind: GitReplayKind,
  sourceObjectId: string,
  sourceCommit: ParsedCommit,
  message: string,
  authorOverride: GitCommitAuthor | undefined,
  currentHeadEntries: GitIndexEntry[],
  mergedEntries: GitIndexEntry[],
  conflicts: GitTreeMergeConflict[],
  autoMergedPaths: string[],
  theirsLabel: string,
}

function revertMessage({ sourceObjectId, sourceCommit }: {
  sourceObjectId: string,
  sourceCommit: ParsedCommit,
}): string {
  const subject = sourceCommit.message.split('\n', 1)[0] ?? '';
  return `Revert "${subject}"\n\nThis reverts commit ${sourceObjectId}.\n`;
}

async function commitEntries({ files, repository, objectId }: {
  files: GitFiles,
  repository: GitRepository,
  objectId: string,
}): Promise<{ commit: ParsedCommit, entries: GitIndexEntry[] }> {
  const commit = await readCommit({ files, repository, objectId });
  return {
    commit,
    entries: await readTreeIntoIndex({ files, repository, treeObjectId: commit.treeObjectId }),
  };
}

export async function prepareCommitReplay({ files, repository, kind, sourceObjectId, currentHeadObjectId, mainlineParentNumber }: {
  files: GitFiles,
  repository: GitRepository,
  kind: GitReplayKind,
  sourceObjectId: string,
  currentHeadObjectId: string,
  mainlineParentNumber?: number,
}): Promise<GitPreparedReplay> {
  const source = await commitEntries({ files, repository, objectId: sourceObjectId });
  let parentObjectId: string | undefined;
  if (source.commit.parentObjectIds.length > 1) {
    if (mainlineParentNumber === undefined) {
      throw new Error(`commit ${sourceObjectId} is a merge but no -m option was given.`);
    }
    parentObjectId = source.commit.parentObjectIds[mainlineParentNumber - 1];
    if (parentObjectId === undefined) {
      throw new Error(`commit ${sourceObjectId} does not have parent ${mainlineParentNumber}`);
    }
  } else {
    parentObjectId = source.commit.parentObjectIds[0];
  }
  const current = await commitEntries({ files, repository, objectId: currentHeadObjectId });
  const parentEntries = parentObjectId === undefined
    ? []
    : (await commitEntries({ files, repository, objectId: parentObjectId })).entries;

  let baseEntries: readonly GitIndexEntry[];
  let theirsEntries: readonly GitIndexEntry[];
  let message: string;
  let authorOverride: GitCommitAuthor | undefined;
  let theirsLabel: string;
  const subject = source.commit.message.split('\n', 1)[0] ?? '';
  switch (kind) {
  case 'cherry-pick':
    baseEntries = parentEntries;
    theirsEntries = source.entries;
    message = source.commit.message;
    authorOverride = parseCommitAuthor({ value: source.commit.author });
    theirsLabel = `${sourceObjectId.slice(0, 7)} (${subject})`;
    break;
  case 'revert':
    baseEntries = source.entries;
    theirsEntries = parentEntries;
    message = revertMessage({ sourceObjectId, sourceCommit: source.commit });
    authorOverride = undefined;
    theirsLabel = `parent of ${sourceObjectId.slice(0, 7)} (${subject})`;
    break;
  default: {
    const _ex: never = kind;
    throw new Error(`Unhandled replay kind: ${_ex}`);
  }
  }

  const merged = mergeThreeTrees({
    baseEntries,
    oursEntries: current.entries,
    theirsEntries,
  });
  const autoMerged = await autoMergeTextConflicts({ files, repository, conflicts: merged.conflicts });
  return {
    kind,
    sourceObjectId,
    sourceCommit: source.commit,
    message,
    authorOverride,
    currentHeadEntries: current.entries,
    mergedEntries: [...merged.entries, ...autoMerged.entries],
    conflicts: autoMerged.conflicts,
    autoMergedPaths: autoMerged.entries.map(entry => entry.path),
    theirsLabel,
  };
}

export const TEST_ONLY = {
  revertMessage,
};
