import { readCommit } from './commits';
import type { GitFiles } from './files';
import type { GitRepository } from './repository';

export async function isAncestor({ files, repository, ancestorObjectId, descendantObjectId }: {
  files: GitFiles,
  repository: GitRepository,
  ancestorObjectId: string,
  descendantObjectId: string,
}): Promise<boolean> {
  if (ancestorObjectId === descendantObjectId) return true;
  const pending = [descendantObjectId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const objectId = pending.pop()!;
    if (visited.has(objectId)) continue;
    visited.add(objectId);
    const commit = await readCommit({ files, repository, objectId });
    for (const parentObjectId of commit.parentObjectIds) {
      if (parentObjectId === ancestorObjectId) return true;
      if (!visited.has(parentObjectId)) pending.push(parentObjectId);
    }
  }
  return false;
}

async function collectAncestors({ files, repository, objectId }: {
  files: GitFiles,
  repository: GitRepository,
  objectId: string,
}): Promise<Set<string>> {
  const result = new Set<string>();
  const pending = [objectId];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (result.has(current)) continue;
    result.add(current);
    const commit = await readCommit({ files, repository, objectId: current });
    for (const parent of commit.parentObjectIds) {
      if (!result.has(parent)) pending.push(parent);
    }
  }
  return result;
}

export async function findMergeBases({ files, repository, leftObjectId, rightObjectId }: {
  files: GitFiles,
  repository: GitRepository,
  leftObjectId: string,
  rightObjectId: string,
}): Promise<string[]> {
  const leftAncestors = await collectAncestors({ files, repository, objectId: leftObjectId });
  const rightAncestors = await collectAncestors({ files, repository, objectId: rightObjectId });
  const common = [...leftAncestors].filter(objectId => rightAncestors.has(objectId));
  const best: string[] = [];
  for (const candidate of common) {
    let dominated = false;
    for (const other of common) {
      if (candidate === other) continue;
      if (await isAncestor({ files, repository, ancestorObjectId: candidate, descendantObjectId: other })) {
        dominated = true;
        break;
      }
    }
    if (!dominated) best.push(candidate);
  }
  return best.sort();
}


export async function collectRebaseCommits({ files, repository, upstreamObjectId, descendantObjectId }: {
  files: GitFiles,
  repository: GitRepository,
  upstreamObjectId: string,
  descendantObjectId: string,
}): Promise<string[]> {
  const excluded = await collectAncestors({ files, repository, objectId: upstreamObjectId });
  const visited = new Set<string>();
  const result: string[] = [];
  const visit = async ({ objectId }: { objectId: string }): Promise<void> => {
    if (excluded.has(objectId) || visited.has(objectId)) return;
    visited.add(objectId);
    const commit = await readCommit({ files, repository, objectId });
    for (const parentObjectId of commit.parentObjectIds) await visit({ objectId: parentObjectId });
    if (commit.parentObjectIds.length <= 1) result.push(objectId);
  };
  await visit({ objectId: descendantObjectId });
  return result;
}

export const TEST_ONLY = {
};
