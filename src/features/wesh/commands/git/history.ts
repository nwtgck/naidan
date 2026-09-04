import { commitSubject, createGitCommitCache, parseCommitAuthor, readCachedCommit } from './commits';
import type { GitCommitCache, ParsedCommit } from './commits';
import type { GitFiles } from './files';
import { relativeToWorktree } from './repository';
import type { GitRepository } from './repository';
import { peelToCommitObjectId } from './revision';
import { matchRepositoryPathSelection } from './pathspec';
import { readTreeRecursively } from './tree';
import { normalizePath } from '@/features/wesh/path';
import { readObject } from './objects';
import { findExactRenames, findGitRenameMatches } from './renames';
import type { GitSimilarityRenameCandidate } from './renames';

export interface GitHistoryCommit {
  objectId: string,
  commit: ParsedCommit,
}

export interface GitFollowHistoryCommit extends GitHistoryCommit {
  followPath: string,
  parentFollowPath: string | undefined,
}

interface CommitReadCache {
  commits: GitCommitCache,
  peeledObjectIds: Map<string, string>,
}

function createCommitReadCache(): CommitReadCache {
  return {
    commits: createGitCommitCache(),
    peeledObjectIds: new Map<string, string>(),
  };
}

async function peelCachedCommitObjectId({ files, repository, objectId, cache }: {
  files: GitFiles,
  repository: GitRepository,
  objectId: string,
  cache: CommitReadCache,
}): Promise<string> {
  const cached = cache.peeledObjectIds.get(objectId);
  if (cached !== undefined) return cached;
  const peeled = await peelToCommitObjectId({ files, repository, objectId });
  cache.peeledObjectIds.set(objectId, peeled);
  cache.peeledObjectIds.set(peeled, peeled);
  return peeled;
}

async function loadClosureObjectIds({ files, repository, roots, cache }: {
  files: GitFiles,
  repository: GitRepository,
  roots: readonly string[],
  cache: CommitReadCache,
}): Promise<Set<string>> {
  const objectIds = new Set<string>();
  const pending: string[] = [];
  for (const rootObjectId of roots) {
    pending.push(await peelCachedCommitObjectId({ files, repository, objectId: rootObjectId, cache }));
  }
  while (pending.length > 0) {
    const objectId = pending.pop()!;
    if (objectIds.has(objectId)) continue;
    const commit = await readCachedCommit({ files, repository, objectId, cache: cache.commits });
    objectIds.add(objectId);
    pending.push(...commit.parentObjectIds);
  }
  return objectIds;
}

function committerEpoch({ commit }: { commit: ParsedCommit }): number {
  const timestamp = parseCommitAuthor({ value: commit.committer }).timestamp;
  const value = Number.parseInt(timestamp.split(' ', 1)[0]!, 10);
  if (!Number.isSafeInteger(value)) throw new Error(`invalid commit timestamp: ${timestamp}`);
  return value;
}

interface CommitReadyQueue {
  objectIds: string[],
  compare: ({ left, right }: { left: string, right: string }) => number,
}

function pushReadyCommit({ queue, objectId }: { queue: CommitReadyQueue, objectId: string }): void {
  const { objectIds, compare } = queue;
  objectIds.push(objectId);
  let index = objectIds.length - 1;
  while (index > 0) {
    const parentIndex = Math.floor((index - 1) / 2);
    if (compare({ left: objectIds[parentIndex]!, right: objectIds[index]! }) <= 0) break;
    [objectIds[parentIndex], objectIds[index]] = [objectIds[index]!, objectIds[parentIndex]!];
    index = parentIndex;
  }
}

function popReadyCommit({ queue }: { queue: CommitReadyQueue }): string | undefined {
  const { objectIds, compare } = queue;
  if (objectIds.length === 0) return undefined;
  const first = objectIds[0]!;
  const last = objectIds.pop()!;
  if (objectIds.length === 0) return first;
  objectIds[0] = last;
  let index = 0;
  while (true) {
    const leftIndex = index * 2 + 1;
    if (leftIndex >= objectIds.length) break;
    const rightIndex = leftIndex + 1;
    let nextIndex = leftIndex;
    if (rightIndex < objectIds.length
      && compare({ left: objectIds[rightIndex]!, right: objectIds[leftIndex]! }) < 0) {
      nextIndex = rightIndex;
    }
    if (compare({ left: objectIds[index]!, right: objectIds[nextIndex]! }) <= 0) break;
    [objectIds[index], objectIds[nextIndex]] = [objectIds[nextIndex]!, objectIds[index]!];
    index = nextIndex;
  }
  return first;
}

export async function collectCommitHistory({ files, repository, includeObjectIds, excludeObjectIds }: {
  files: GitFiles,
  repository: GitRepository,
  includeObjectIds: readonly string[],
  excludeObjectIds: readonly string[],
}): Promise<GitHistoryCommit[]> {
  return collectCommitHistoryWithCache({
    files,
    repository,
    includeObjectIds,
    excludeObjectIds,
    cache: createCommitReadCache(),
  });
}

async function collectCommitHistoryWithCache({ files, repository, includeObjectIds, excludeObjectIds, cache }: {
  files: GitFiles,
  repository: GitRepository,
  includeObjectIds: readonly string[],
  excludeObjectIds: readonly string[],
  cache: CommitReadCache,
}): Promise<GitHistoryCommit[]> {
  const included = await loadClosureObjectIds({ files, repository, roots: includeObjectIds, cache });
  const excluded = await loadClosureObjectIds({ files, repository, roots: excludeObjectIds, cache });
  for (const objectId of excluded) included.delete(objectId);

  const childCounts = new Map<string, number>();
  for (const objectId of included) childCounts.set(objectId, 0);
  for (const objectId of included) {
    const commit = cache.commits.get(objectId)!;
    for (const parentObjectId of commit.parentObjectIds) {
      if (included.has(parentObjectId)) childCounts.set(parentObjectId, childCounts.get(parentObjectId)! + 1);
    }
  }

  const result: GitHistoryCommit[] = [];
  const committerEpochs = new Map<string, number>();
  const committerEpochForObjectId = ({ objectId }: { objectId: string }): number => {
    const cached = committerEpochs.get(objectId);
    if (cached !== undefined) return cached;
    const value = committerEpoch({ commit: cache.commits.get(objectId)! });
    committerEpochs.set(objectId, value);
    return value;
  };
  const ready: CommitReadyQueue = {
    objectIds: [],
    compare: ({ left, right }) => {
      const timeDifference = committerEpochForObjectId({ objectId: right }) - committerEpochForObjectId({ objectId: left });
      return timeDifference || left.localeCompare(right);
    },
  };
  for (const objectId of included) {
    if (childCounts.get(objectId) === 0) pushReadyCommit({ queue: ready, objectId });
  }
  while (ready.objectIds.length > 0) {
    const objectId = popReadyCommit({ queue: ready })!;
    const commit = cache.commits.get(objectId)!;
    result.push({ objectId, commit });
    for (const parentObjectId of commit.parentObjectIds) {
      if (!included.has(parentObjectId)) continue;
      const remainingChildren = childCounts.get(parentObjectId)! - 1;
      childCounts.set(parentObjectId, remainingChildren);
      if (remainingChildren === 0) pushReadyCommit({ queue: ready, objectId: parentObjectId });
    }
  }
  if (result.length !== included.size) throw new Error('commit graph contains a cycle');
  return result;
}

export async function countCommitDivergence({ files, repository, leftObjectId, rightObjectId }: {
  files: GitFiles,
  repository: GitRepository,
  leftObjectId: string,
  rightObjectId: string,
}): Promise<{ leftOnly: number, rightOnly: number }> {
  const cache = createCommitReadCache();
  const left = await loadClosureObjectIds({ files, repository, roots: [leftObjectId], cache });
  const right = await loadClosureObjectIds({ files, repository, roots: [rightObjectId], cache });
  let leftOnly = 0;
  for (const objectId of left) {
    if (!right.has(objectId)) leftOnly += 1;
  }
  let rightOnly = 0;
  for (const objectId of right) {
    if (!left.has(objectId)) rightOnly += 1;
  }
  return { leftOnly, rightOnly };
}

export async function collectGraphCommitHistory({ files, repository, includeObjectIds, excludeObjectIds }: {
  files: GitFiles,
  repository: GitRepository,
  includeObjectIds: readonly string[],
  excludeObjectIds: readonly string[],
}): Promise<GitHistoryCommit[]> {
  const cache = createCommitReadCache();
  const included = await loadClosureObjectIds({ files, repository, roots: includeObjectIds, cache });
  const excluded = await loadClosureObjectIds({ files, repository, roots: excludeObjectIds, cache });
  for (const objectId of excluded) included.delete(objectId);

  const childCounts = new Map<string, number>();
  for (const objectId of included) childCounts.set(objectId, 0);
  for (const objectId of included) {
    const commit = cache.commits.get(objectId)!;
    for (const parentObjectId of commit.parentObjectIds) {
      if (included.has(parentObjectId)) childCounts.set(parentObjectId, childCounts.get(parentObjectId)! + 1);
    }
  }

  const initiallyReady = [...included].filter(objectId => childCounts.get(objectId) === 0);
  initiallyReady.sort((left, right) => {
    const timeDifference = committerEpoch({ commit: cache.commits.get(right)! }) - committerEpoch({ commit: cache.commits.get(left)! });
    return timeDifference || left.localeCompare(right);
  });
  let initialReadyIndex = 0;
  const frontStack: string[] = [];
  const result: GitHistoryCommit[] = [];
  while (frontStack.length > 0 || initialReadyIndex < initiallyReady.length) {
    const objectId = frontStack.pop() ?? initiallyReady[initialReadyIndex++]!;
    const commit = cache.commits.get(objectId)!;
    result.push({ objectId, commit });
    for (const parentObjectId of commit.parentObjectIds) {
      if (!included.has(parentObjectId)) continue;
      const remainingChildren = childCounts.get(parentObjectId)! - 1;
      childCounts.set(parentObjectId, remainingChildren);
      if (remainingChildren === 0) frontStack.push(parentObjectId);
    }
  }
  if (result.length !== included.size) throw new Error('commit graph contains a cycle');
  return result;
}


export interface PathTreeEntry {
  objectId: string,
  mode: number,
}

export type PathTree = Map<string, PathTreeEntry>;

export async function readPathTree({ files, repository, treeObjectId, cache, objectReadCache }: {
  files: GitFiles,
  repository: GitRepository,
  treeObjectId: string,
  cache: Map<string, PathTree>,
  objectReadCache?: GitCommitCache['objectReadCache'],
}): Promise<PathTree> {
  const cached = cache.get(treeObjectId);
  if (cached !== undefined) return cached;
  const tree = new Map<string, PathTreeEntry>();
  for (const entry of await readTreeRecursively({ files, repository, treeObjectId, objectReadCache })) {
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

  const cache = createCommitReadCache();
  const excluded = excludeObjectIds.length === 0
    ? new Set<string>()
    : await loadClosureObjectIds({ files, repository, roots: excludeObjectIds, cache });
  const emitted = new Set<string>();
  const visited = new Set<string>();
  const pending: string[] = [];
  for (const rawRoot of includeObjectIds) {
    pending.push(await peelCachedCommitObjectId({ files, repository, objectId: rawRoot, cache }));
  }
  const treeCache = new Map<string, PathTree>();

  while (pending.length > 0) {
    const objectId = pending.pop()!;
    if (visited.has(objectId) || excluded.has(objectId)) continue;
    visited.add(objectId);
    const commit = await readCachedCommit({ files, repository, objectId, cache: cache.commits });
    const currentTree = await readPathTree({
      files,
      repository,
      treeObjectId: commit.treeObjectId,
      cache: treeCache,
      objectReadCache: cache.commits.objectReadCache,
    });
    const parentData: Array<{ objectId: string, tree: PathTree }> = [];
    for (const parentObjectId of commit.parentObjectIds) {
      if (excluded.has(parentObjectId)) continue;
      const parent = await readCachedCommit({ files, repository, objectId: parentObjectId, cache: cache.commits });
      parentData.push({
        objectId: parentObjectId,
        tree: await readPathTree({
          files,
          repository,
          treeObjectId: parent.treeObjectId,
          cache: treeCache,
          objectReadCache: cache.commits.objectReadCache,
        }),
      });
    }

    const availablePaths = new Set(currentTree.keys());
    for (const parent of parentData) for (const path of parent.tree.keys()) availablePaths.add(path);
    const selectedPaths = matchRepositoryPathSelection({
      repository,
      cwd,
      operands: pathOperands,
      availablePaths,
    }).selected;

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

  const ordered = await collectCommitHistoryWithCache({ files, repository, includeObjectIds, excludeObjectIds, cache });
  return ordered.filter(entry => emitted.has(entry.objectId));
}

function followRepositoryPath({ repository, cwd, operand }: {
  repository: GitRepository,
  cwd: string,
  operand: string,
}): string {
  if (operand.startsWith(':') || /[*?[]/u.test(operand))
    throw new Error('--follow does not support pathspec magic or wildcards yet');
  const absolutePath = normalizePath({ cwd, path: operand });
  const relativePath = relativeToWorktree({ repository, absolutePath });
  if (relativePath.length === 0)
    throw new Error('--follow requires a file path');
  return relativePath;
}

async function readSimilarityRenameCandidate({ files, repository, entry, path, objectReadCache }: {
  files: GitFiles,
  repository: GitRepository,
  entry: PathTreeEntry,
  path: string,
  objectReadCache?: GitCommitCache['objectReadCache'],
}): Promise<GitSimilarityRenameCandidate | undefined> {
  if ((entry.mode & 0o170000) !== 0o100000) return undefined;
  const object = await readObject({ files, repository, objectId: entry.objectId, cache: objectReadCache });
  switch (object.type) {
  case 'blob':
    return { path, objectId: entry.objectId, mode: entry.mode, bytes: object.body };
  case 'tree':
  case 'commit':
  case 'tag':
    return undefined;
  default:
    throw new Error(`Unhandled follow rename object type: ${object.type}`);
  }
}

export async function followRenameSourcePath({ files, repository, parentTree, currentTree, destinationPath, renameLimit, objectReadCache }: {
  files: GitFiles,
  repository: GitRepository,
  parentTree: PathTree,
  currentTree: PathTree,
  destinationPath: string,
  renameLimit: number,
  objectReadCache?: GitCommitCache['objectReadCache'],
}): Promise<string | undefined> {
  const destination = currentTree.get(destinationPath);
  if (destination === undefined) return undefined;
  const deleted = [...parentTree]
    .filter(([path]) => !currentTree.has(path))
    .map(([path, entry]) => ({ path, objectId: entry.objectId, mode: entry.mode }));
  if (deleted.length === 0) return undefined;
  const exact = findExactRenames({
    deleted,
    added: [{ path: destinationPath, objectId: destination.objectId, mode: destination.mode }],
  }).find(rename => rename.destinationPath === destinationPath);
  if (exact !== undefined) return exact.sourcePath;
  if (renameLimit > 0 && deleted.length > renameLimit) return undefined;

  const destinationCandidate = await readSimilarityRenameCandidate({
    files,
    repository,
    entry: destination,
    path: destinationPath,
    objectReadCache,
  });
  if (destinationCandidate === undefined) return undefined;
  const deletedCandidates: GitSimilarityRenameCandidate[] = [];
  for (const candidate of deleted) {
    const entry = parentTree.get(candidate.path)!;
    const loaded = await readSimilarityRenameCandidate({
      files,
      repository,
      entry,
      path: candidate.path,
      objectReadCache,
    });
    if (loaded !== undefined) deletedCandidates.push(loaded);
  }
  return findGitRenameMatches({
    deleted: deletedCandidates,
    added: [destinationCandidate],
    renameLimit,
  }).find(rename => rename.destinationPath === destinationPath)?.sourcePath;
}

export async function collectFollowHistory({ files, repository, includeObjectIds, excludeObjectIds, cwd, pathOperand, renameLimit }: {
  files: GitFiles,
  repository: GitRepository,
  includeObjectIds: readonly string[],
  excludeObjectIds: readonly string[],
  cwd: string,
  pathOperand: string,
  renameLimit: number,
}): Promise<GitFollowHistoryCommit[]> {
  const initialPath = followRepositoryPath({ repository, cwd, operand: pathOperand });
  const cache = createCommitReadCache();
  const excluded = excludeObjectIds.length === 0
    ? new Set<string>()
    : await loadClosureObjectIds({ files, repository, roots: excludeObjectIds, cache });
  const emitted = new Set<string>();
  const emittedPaths = new Map<string, { followPath: string, parentFollowPath: string | undefined }>();
  const visited = new Set<string>();
  const pending: Array<{ objectId: string, path: string }> = [];
  for (const rawRoot of includeObjectIds) {
    pending.push({
      objectId: await peelCachedCommitObjectId({ files, repository, objectId: rawRoot, cache }),
      path: initialPath,
    });
  }
  const treeCache = new Map<string, PathTree>();

  while (pending.length > 0) {
    const state = pending.pop()!;
    const visitKey = `${state.objectId}\0${state.path}`;
    if (visited.has(visitKey) || excluded.has(state.objectId)) continue;
    visited.add(visitKey);
    const commit = await readCachedCommit({ files, repository, objectId: state.objectId, cache: cache.commits });
    const currentTree = await readPathTree({
      files,
      repository,
      treeObjectId: commit.treeObjectId,
      cache: treeCache,
      objectReadCache: cache.commits.objectReadCache,
    });
    if (commit.parentObjectIds.length === 0) {
      if (currentTree.has(state.path)) {
        emitted.add(state.objectId);
        if (!emittedPaths.has(state.objectId)) {
          emittedPaths.set(state.objectId, { followPath: state.path, parentFollowPath: undefined });
        }
      }
      continue;
    }

    const parentStates: Array<{ objectId: string, path: string, same: boolean }> = [];
    for (const parentObjectId of commit.parentObjectIds) {
      if (excluded.has(parentObjectId)) continue;
      const parent = await readCachedCommit({ files, repository, objectId: parentObjectId, cache: cache.commits });
      const parentTree = await readPathTree({
        files,
        repository,
        treeObjectId: parent.treeObjectId,
        cache: treeCache,
        objectReadCache: cache.commits.objectReadCache,
      });
      const currentEntry = currentTree.get(state.path);
      const parentEntry = parentTree.get(state.path);
      const same = currentEntry?.objectId === parentEntry?.objectId && currentEntry?.mode === parentEntry?.mode;
      const predecessorPath = same
        ? state.path
        : await followRenameSourcePath({
          files,
          repository,
          parentTree,
          currentTree,
          destinationPath: state.path,
          renameLimit,
          objectReadCache: cache.commits.objectReadCache,
        }) ?? state.path;
      parentStates.push({ objectId: parentObjectId, path: predecessorPath, same });
    }
    const sameParents = parentStates.filter(parent => parent.same);
    if (sameParents.length > 0) {
      pending.push(...sameParents.map(parent => ({ objectId: parent.objectId, path: parent.path })));
      continue;
    }
    emitted.add(state.objectId);
    if (!emittedPaths.has(state.objectId)) {
      emittedPaths.set(state.objectId, {
        followPath: state.path,
        parentFollowPath: parentStates.length === 1 ? parentStates[0]!.path : undefined,
      });
    }
    pending.push(...parentStates.map(parent => ({ objectId: parent.objectId, path: parent.path })));
  }

  const ordered = await collectCommitHistoryWithCache({ files, repository, includeObjectIds, excludeObjectIds, cache });
  return ordered.flatMap(entry => {
    if (!emitted.has(entry.objectId)) return [];
    const paths = emittedPaths.get(entry.objectId);
    if (paths === undefined) throw new Error(`missing follow paths for commit: ${entry.objectId}`);
    return [{ ...entry, ...paths }];
  });
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
