import { createGitCommitCache, readCachedCommit } from './commits';
import type { GitCommitCache } from './commits';
import type { GitFiles } from './files';
import type { GitRepository } from './repository';

export type GitCommitGraphCache = GitCommitCache;

export function createGitCommitGraphCache(): GitCommitGraphCache {
  return createGitCommitCache();
}

export async function isAncestor({ files, repository, ancestorObjectId, descendantObjectId, cache }: {
  files: GitFiles,
  repository: GitRepository,
  ancestorObjectId: string,
  descendantObjectId: string,
  cache: GitCommitGraphCache | undefined,
}): Promise<boolean> {
  if (ancestorObjectId === descendantObjectId) return true;
  const pending = [descendantObjectId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const objectId = pending.pop()!;
    if (visited.has(objectId)) continue;
    visited.add(objectId);
    const commit = await readCachedCommit({ files, repository, objectId, cache });
    for (const parentObjectId of commit.parentObjectIds) {
      if (parentObjectId === ancestorObjectId) return true;
      if (!visited.has(parentObjectId)) pending.push(parentObjectId);
    }
  }
  return false;
}

async function collectAncestors({ files, repository, objectId, cache }: {
  files: GitFiles,
  repository: GitRepository,
  objectId: string,
  cache: GitCommitGraphCache,
}): Promise<Set<string>> {
  const result = new Set<string>();
  const pending = [objectId];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (result.has(current)) continue;
    result.add(current);
    const commit = await readCachedCommit({ files, repository, objectId: current, cache });
    for (const parent of commit.parentObjectIds) {
      if (!result.has(parent)) pending.push(parent);
    }
  }
  return result;
}

export async function findMergeBases({ files, repository, leftObjectId, rightObjectId, cache }: {
  files: GitFiles,
  repository: GitRepository,
  leftObjectId: string,
  rightObjectId: string,
  cache: GitCommitGraphCache | undefined,
}): Promise<string[]> {
  const graphCache = cache ?? createGitCommitGraphCache();
  const leftAncestors = await collectAncestors({ files, repository, objectId: leftObjectId, cache: graphCache });
  const rightAncestors = await collectAncestors({ files, repository, objectId: rightObjectId, cache: graphCache });
  const [smallerAncestors, largerAncestors] = leftAncestors.size <= rightAncestors.size
    ? [leftAncestors, rightAncestors]
    : [rightAncestors, leftAncestors];
  const common = new Set<string>();
  for (const objectId of smallerAncestors) {
    if (largerAncestors.has(objectId)) common.add(objectId);
  }
  const dominated = new Set<string>();
  for (const objectId of common) {
    const commit = graphCache.get(objectId)!;
    for (const parentObjectId of commit.parentObjectIds) {
      if (common.has(parentObjectId)) dominated.add(parentObjectId);
    }
  }
  const best: string[] = [];
  for (const objectId of common) {
    if (!dominated.has(objectId)) best.push(objectId);
  }
  return best.sort();
}


export async function collectRebaseCommits({ files, repository, upstreamObjectId, descendantObjectId, cache }: {
  files: GitFiles,
  repository: GitRepository,
  upstreamObjectId: string,
  descendantObjectId: string,
  cache: GitCommitGraphCache | undefined,
}): Promise<string[]> {
  const graphCache = cache ?? createGitCommitGraphCache();
  const excluded = await collectAncestors({ files, repository, objectId: upstreamObjectId, cache: graphCache });
  const visited = new Set<string>();
  const result: string[] = [];
  const visit = async ({ objectId }: { objectId: string }): Promise<void> => {
    if (excluded.has(objectId) || visited.has(objectId)) return;
    visited.add(objectId);
    const commit = await readCachedCommit({ files, repository, objectId, cache: graphCache });
    for (const parentObjectId of commit.parentObjectIds) await visit({ objectId: parentObjectId });
    if (commit.parentObjectIds.length <= 1) result.push(objectId);
  };
  await visit({ objectId: descendantObjectId });
  return result;
}

export const TEST_ONLY = {
};
