import { applyCheckoutTreePlan, planCheckoutTree } from './checkout';
import type { GitCheckoutConflict } from './checkout';
import { readCommit } from './commits';
import type { GitObjectReadCache } from './objects';
import type { GitWorktreeContentConfig } from './config';
import type { GitFiles } from './files';
import { readIndex, writeIndex } from './index-file';
import type { GitReflogUpdate } from './refs';
import { readHead, updateHead, writeOrigHead } from './refs';
import type { GitRepository } from './repository';
import { readTreeIntoIndex } from './tree';

export type GitFastForwardResult =
  | { type: 'updated', oldObjectId: string, newObjectId: string }
  | { type: 'checkout-conflict', conflicts: readonly GitCheckoutConflict[] };

export async function fastForwardHead({ files, repository, targetObjectId, reflog, contentConfig, objectReadCache }: {
  files: GitFiles,
  repository: GitRepository,
  targetObjectId: string,
  reflog: GitReflogUpdate,
  contentConfig: GitWorktreeContentConfig,
  objectReadCache?: GitObjectReadCache,
}): Promise<GitFastForwardResult> {
  const head = await readHead({ files, repository });
  if (head.objectId === undefined) throw new Error('cannot fast-forward an unborn HEAD');
  const currentCommit = await readCommit({ files, repository, objectId: head.objectId, objectReadCache });
  const targetCommit = await readCommit({ files, repository, objectId: targetObjectId, objectReadCache });
  const currentHeadEntries = await readTreeIntoIndex({
    files,
    repository,
    treeObjectId: currentCommit.treeObjectId,
    objectReadCache,
  });
  const currentIndexEntries = await readIndex({ files, repository });
  const targetEntries = await readTreeIntoIndex({
    files,
    repository,
    treeObjectId: targetCommit.treeObjectId,
    objectReadCache,
  });
  const plan = await planCheckoutTree({
    files,
    repository,
    currentHeadEntries,
    currentIndexEntries,
    targetEntries,
    contentConfig,
  });
  if (plan.conflicts.length > 0) return { type: 'checkout-conflict', conflicts: plan.conflicts };
  await writeOrigHead({ files, repository, objectId: head.objectId });
  await applyCheckoutTreePlan({ files, repository, currentIndexEntries, plan, contentConfig });
  await writeIndex({ files, repository, entries: plan.nextIndexEntries });
  await updateHead({ files, repository, objectId: targetObjectId, reflog });
  return { type: 'updated', oldObjectId: head.objectId, newObjectId: targetObjectId };
}

export const TEST_ONLY = {
};
