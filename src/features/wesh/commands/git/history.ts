import { commitSubject, parseCommitAuthor, readCommit } from './commits';
import type { ParsedCommit } from './commits';
import type { GitFiles } from './files';
import type { GitRepository } from './repository';
import { peelToCommitObjectId } from './revision';
import { matchRepositoryPaths } from './pathspec';
import { readTreeRecursively } from './tree';

export interface GitHistoryCommit {
  objectId: string,
  commit: ParsedCommit,
}

async function loadClosure({ files, repository, roots }: {
  files: GitFiles,
  repository: GitRepository,
  roots: readonly string[],
}): Promise<Map<string, ParsedCommit>> {
  const commits = new Map<string, ParsedCommit>();
  const pending = [...roots];
  while (pending.length > 0) {
    const rawObjectId = pending.pop()!;
    const objectId = await peelToCommitObjectId({ files, repository, objectId: rawObjectId });
    if (commits.has(objectId)) continue;
    const commit = await readCommit({ files, repository, objectId });
    commits.set(objectId, commit);
    pending.push(...commit.parentObjectIds);
  }
  return commits;
}

function committerEpoch({ commit }: { commit: ParsedCommit }): number {
  const timestamp = parseCommitAuthor({ value: commit.committer }).timestamp;
  const value = Number.parseInt(timestamp.split(' ', 1)[0]!, 10);
  if (!Number.isSafeInteger(value)) throw new Error(`invalid commit timestamp: ${timestamp}`);
  return value;
}

export async function collectCommitHistory({ files, repository, includeObjectIds, excludeObjectIds }: {
  files: GitFiles,
  repository: GitRepository,
  includeObjectIds: readonly string[],
  excludeObjectIds: readonly string[],
}): Promise<GitHistoryCommit[]> {
  const included = await loadClosure({ files, repository, roots: includeObjectIds });
  const excluded = await loadClosure({ files, repository, roots: excludeObjectIds });
  for (const objectId of excluded.keys()) included.delete(objectId);

  const childCounts = new Map<string, number>();
  for (const objectId of included.keys()) childCounts.set(objectId, 0);
  for (const commit of included.values()) {
    for (const parentObjectId of commit.parentObjectIds) {
      if (included.has(parentObjectId)) childCounts.set(parentObjectId, childCounts.get(parentObjectId)! + 1);
    }
  }

  const ready = [...included.keys()].filter(objectId => childCounts.get(objectId) === 0);
  const result: GitHistoryCommit[] = [];
  const sortReady = () => ready.sort((left, right) => {
    const timeDifference = committerEpoch({ commit: included.get(right)! }) - committerEpoch({ commit: included.get(left)! });
    return timeDifference || left.localeCompare(right);
  });
  sortReady();
  while (ready.length > 0) {
    const objectId = ready.shift()!;
    const commit = included.get(objectId)!;
    result.push({ objectId, commit });
    for (const parentObjectId of commit.parentObjectIds) {
      if (!included.has(parentObjectId)) continue;
      const remainingChildren = childCounts.get(parentObjectId)! - 1;
      childCounts.set(parentObjectId, remainingChildren);
      if (remainingChildren === 0) ready.push(parentObjectId);
    }
    sortReady();
  }
  if (result.length !== included.size) throw new Error('commit graph contains a cycle');
  return result;
}

export async function collectGraphCommitHistory({ files, repository, includeObjectIds, excludeObjectIds }: {
  files: GitFiles,
  repository: GitRepository,
  includeObjectIds: readonly string[],
  excludeObjectIds: readonly string[],
}): Promise<GitHistoryCommit[]> {
  const included = await loadClosure({ files, repository, roots: includeObjectIds });
  const excluded = await loadClosure({ files, repository, roots: excludeObjectIds });
  for (const objectId of excluded.keys()) included.delete(objectId);

  const childCounts = new Map<string, number>();
  for (const objectId of included.keys()) childCounts.set(objectId, 0);
  for (const commit of included.values()) {
    for (const parentObjectId of commit.parentObjectIds) {
      if (included.has(parentObjectId)) childCounts.set(parentObjectId, childCounts.get(parentObjectId)! + 1);
    }
  }

  const ready = [...included.keys()].filter(objectId => childCounts.get(objectId) === 0);
  ready.sort((left, right) => {
    const timeDifference = committerEpoch({ commit: included.get(right)! }) - committerEpoch({ commit: included.get(left)! });
    return timeDifference || left.localeCompare(right);
  });
  const result: GitHistoryCommit[] = [];
  while (ready.length > 0) {
    const objectId = ready.shift()!;
    const commit = included.get(objectId)!;
    result.push({ objectId, commit });
    const newlyReadyParents: string[] = [];
    for (const parentObjectId of commit.parentObjectIds) {
      if (!included.has(parentObjectId)) continue;
      const remainingChildren = childCounts.get(parentObjectId)! - 1;
      childCounts.set(parentObjectId, remainingChildren);
      if (remainingChildren === 0) newlyReadyParents.push(parentObjectId);
    }
    for (const parentObjectId of newlyReadyParents) ready.unshift(parentObjectId);
  }
  if (result.length !== included.size) throw new Error('commit graph contains a cycle');
  return result;
}


interface PathTreeEntry {
  objectId: string,
  mode: number,
}

type PathTree = Map<string, PathTreeEntry>;

async function readPathTree({ files, repository, treeObjectId, cache }: {
  files: GitFiles,
  repository: GitRepository,
  treeObjectId: string,
  cache: Map<string, PathTree>,
}): Promise<PathTree> {
  const cached = cache.get(treeObjectId);
  if (cached !== undefined) return cached;
  const tree = new Map<string, PathTreeEntry>();
  for (const entry of await readTreeRecursively({ files, repository, treeObjectId })) {
    tree.set(entry.path, { objectId: entry.objectId, mode: entry.mode });
  }
  cache.set(treeObjectId, tree);
  return tree;
}

function pathTreesEqual({ left, right, paths }: {
  left: PathTree,
  right: PathTree,
  paths: ReadonlySet<string>,
}): boolean {
  for (const path of paths) {
    const a = left.get(path);
    const b = right.get(path);
    if (a?.objectId !== b?.objectId || a?.mode !== b?.mode) return false;
  }
  return true;
}

export async function collectPathLimitedHistory({
  files,
  repository,
  includeObjectIds,
  excludeObjectIds,
  cwd,
  pathOperands,
}: {
  files: GitFiles,
  repository: GitRepository,
  includeObjectIds: readonly string[],
  excludeObjectIds: readonly string[],
  cwd: string,
  pathOperands: readonly string[],
}): Promise<GitHistoryCommit[]> {
  if (pathOperands.length === 0) {
    return collectCommitHistory({ files, repository, includeObjectIds, excludeObjectIds });
  }

  const excludedHistory = excludeObjectIds.length === 0
    ? []
    : await collectCommitHistory({ files, repository, includeObjectIds: excludeObjectIds, excludeObjectIds: [] });
  const excluded = new Set(excludedHistory.map(entry => entry.objectId));
  const emitted = new Set<string>();
  const visited = new Set<string>();
  const pending: string[] = [];
  for (const rawRoot of includeObjectIds) {
    pending.push(await peelToCommitObjectId({ files, repository, objectId: rawRoot }));
  }
  const treeCache = new Map<string, PathTree>();

  while (pending.length > 0) {
    const objectId = pending.pop()!;
    if (visited.has(objectId) || excluded.has(objectId)) continue;
    visited.add(objectId);
    const commit = await readCommit({ files, repository, objectId });
    const currentTree = await readPathTree({ files, repository, treeObjectId: commit.treeObjectId, cache: treeCache });
    const parentData: Array<{ objectId: string, tree: PathTree }> = [];
    for (const parentObjectId of commit.parentObjectIds) {
      if (excluded.has(parentObjectId)) continue;
      const parent = await readCommit({ files, repository, objectId: parentObjectId });
      parentData.push({
        objectId: parentObjectId,
        tree: await readPathTree({ files, repository, treeObjectId: parent.treeObjectId, cache: treeCache }),
      });
    }

    const availablePaths = new Set(currentTree.keys());
    for (const parent of parentData) for (const path of parent.tree.keys()) availablePaths.add(path);
    const matches = matchRepositoryPaths({ repository, cwd, operands: pathOperands, availablePaths });
    const selectedPaths = new Set<string>();
    for (const paths of matches.values()) for (const path of paths) selectedPaths.add(path);

    if (parentData.length === 0) {
      if ([...selectedPaths].some(path => currentTree.has(path))) emitted.add(objectId);
      continue;
    }

    const sameParents = parentData.filter(parent => pathTreesEqual({
      left: currentTree,
      right: parent.tree,
      paths: selectedPaths,
    }));
    if (sameParents.length > 0) {
      pending.push(...sameParents.map(parent => parent.objectId));
      continue;
    }
    emitted.add(objectId);
    pending.push(...parentData.map(parent => parent.objectId));
  }

  const ordered = await collectCommitHistory({ files, repository, includeObjectIds, excludeObjectIds });
  return ordered.filter(entry => emitted.has(entry.objectId));
}

function identityParts({ value }: { value: string }): { name: string, email: string, epoch: string } {
  const parsed = parseCommitAuthor({ value });
  return {
    name: parsed.identity.name,
    email: parsed.identity.email,
    epoch: parsed.timestamp.split(' ', 1)[0]!,
  };
}

export function formatCommitTemplate({ objectId, commit, format }: {
  objectId: string,
  commit: ParsedCommit,
  format: string,
}): string {
  const author = identityParts({ value: commit.author });
  const committer = identityParts({ value: commit.committer });
  let result = '';
  for (let offset = 0; offset < format.length;) {
    if (format[offset] !== '%') {
      result += format[offset]!;
      offset += 1;
      continue;
    }
    const two = format.slice(offset, offset + 3);
    const twoValue = (() => {
      switch (two) {
      case '%an': return author.name;
      case '%ae': return author.email;
      case '%at': return author.epoch;
      case '%cn': return committer.name;
      case '%ce': return committer.email;
      case '%ct': return committer.epoch;
      default: return undefined;
      }
    })();
    if (twoValue !== undefined) {
      result += twoValue;
      offset += 3;
      continue;
    }
    const token = format.slice(offset, offset + 2);
    switch (token) {
    case '%%': result += '%'; break;
    case '%H': result += objectId; break;
    case '%h': result += objectId.slice(0, 7); break;
    case '%P': result += commit.parentObjectIds.join(' '); break;
    case '%p': result += commit.parentObjectIds.map(parent => parent.slice(0, 7)).join(' '); break;
    case '%s': result += commitSubject({ commit }); break;
    case '%B': result += commit.message.replace(/\n+$/u, ''); break;
    case '%n': result += '\n'; break;
    default: throw new Error(`unsupported log format placeholder: ${token}`);
    }
    offset += 2;
  }
  return result;
}

export const TEST_ONLY = {
  peelToCommitObjectId,
};
