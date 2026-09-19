export interface GitExactRenameCandidate {
  path: string,
  objectId: string,
  mode: number,
}

export interface GitExactRenameMatch {
  sourcePath: string,
  destinationPath: string,
  objectId: string,
  sourceMode: number,
  destinationMode: number,
}

export function exactRenameContentIdentity({ objectId, mode }: { objectId: string, mode: number }): string {
  return `${mode & 0o170000}:${objectId}`;
}

interface GitExactRenameSourceQueue {
  readonly candidates: readonly GitExactRenameCandidate[],
  readonly sourceIndexes: readonly number[],
  readonly basenameIndexes: Map<string, number[]>,
  readonly basenameOffsets: Map<string, number>,
  readonly usedIndexes: Set<number>,
  nextSourceOffset: number,
}

function createExactRenameSourceQueue({ candidates, sourceIndexes }: {
  candidates: readonly GitExactRenameCandidate[],
  sourceIndexes: readonly number[],
}): GitExactRenameSourceQueue {
  const basenameIndexes = new Map<string, number[]>();
  for (const sourceIndex of sourceIndexes) {
    const basename = gitPathBasename({ path: candidates[sourceIndex]!.path });
    const indexes = basenameIndexes.get(basename) ?? [];
    indexes.push(sourceIndex);
    basenameIndexes.set(basename, indexes);
  }
  return {
    candidates,
    sourceIndexes,
    basenameIndexes,
    basenameOffsets: new Map<string, number>(),
    usedIndexes: new Set<number>(),
    nextSourceOffset: 0,
  };
}

function takeExactRenameSource({ queue, destinationPath }: {
  queue: GitExactRenameSourceQueue,
  destinationPath: string,
}): number | undefined {
  const basename = gitPathBasename({ path: destinationPath });
  const sameBasenameIndexes = queue.basenameIndexes.get(basename);
  if (sameBasenameIndexes !== undefined) {
    let offset = queue.basenameOffsets.get(basename) ?? 0;
    while (offset < sameBasenameIndexes.length && queue.usedIndexes.has(sameBasenameIndexes[offset]!)) offset += 1;
    queue.basenameOffsets.set(basename, offset + 1);
    const sourceIndex = sameBasenameIndexes[offset];
    if (sourceIndex !== undefined) {
      queue.usedIndexes.add(sourceIndex);
      return sourceIndex;
    }
  }

  while (queue.nextSourceOffset < queue.sourceIndexes.length
    && queue.usedIndexes.has(queue.sourceIndexes[queue.nextSourceOffset]!)) {
    queue.nextSourceOffset += 1;
  }
  const sourceIndex = queue.sourceIndexes[queue.nextSourceOffset];
  if (sourceIndex === undefined) return undefined;
  queue.nextSourceOffset += 1;
  queue.usedIndexes.add(sourceIndex);
  return sourceIndex;
}

export function findExactRenames({ deleted, added }: {
  deleted: readonly GitExactRenameCandidate[],
  added: readonly GitExactRenameCandidate[],
}): GitExactRenameMatch[] {
  const groups = new Map<string, { deleted: GitExactRenameCandidate[], added: GitExactRenameCandidate[] }>();
  for (const candidate of deleted) {
    const key = exactRenameContentIdentity({ objectId: candidate.objectId, mode: candidate.mode });
    const group = groups.get(key) ?? { deleted: [], added: [] };
    group.deleted.push(candidate);
    groups.set(key, group);
  }
  for (const candidate of added) {
    const key = exactRenameContentIdentity({ objectId: candidate.objectId, mode: candidate.mode });
    const group = groups.get(key) ?? { deleted: [], added: [] };
    group.added.push(candidate);
    groups.set(key, group);
  }

  const matches: GitExactRenameMatch[] = [];
  for (const group of groups.values()) {
    const queue = createExactRenameSourceQueue({
      candidates: group.deleted,
      sourceIndexes: group.deleted.map((_candidate, index) => index),
    });
    for (const destination of group.added) {
      const sourceIndex = takeExactRenameSource({ queue, destinationPath: destination.path });
      if (sourceIndex === undefined) break;
      const source = group.deleted[sourceIndex]!;
      matches.push({
        sourcePath: source.path,
        destinationPath: destination.path,
        objectId: source.objectId,
        sourceMode: source.mode,
        destinationMode: destination.mode,
      });
    }
  }
  return matches;
}

export interface GitSimilarityRenameCandidate extends GitExactRenameCandidate {
  bytes: Uint8Array,
}

export interface GitSimilarityRenameMatch {
  sourcePath: string,
  destinationPath: string,
  score: number,
}

const GIT_RENAME_MAX_SCORE = 60_000;
const GIT_RENAME_DEFAULT_SCORE = 30_000;
const GIT_RENAME_HASH_BASE = 107_927;
const GIT_BINARY_PROBE_BYTE_LIMIT = 8_000;
const GIT_RENAME_BASENAME_SCORE = 45_000;
const GIT_RENAME_CANDIDATES_PER_DESTINATION = 4;
export const GIT_DEFAULT_RENAME_LIMIT = 1_000;

function isRegularFileMode({ mode }: { mode: number }): boolean {
  return (mode & 0o170000) === 0o100000;
}

function isGitBinaryContent({ bytes }: { bytes: Uint8Array }): boolean {
  const limit = Math.min(bytes.byteLength, GIT_BINARY_PROBE_BYTE_LIMIT);
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) return true;
  }
  return false;
}

function gitRenameSpanCounts({ bytes }: { bytes: Uint8Array }): Map<number, number> {
  const counts = new Map<number, number>();
  const isText = !isGitBinaryContent({ bytes });
  let accumulated1 = 0;
  let accumulated2 = 0;
  let spanLength = 0;

  const commitSpan = (): void => {
    const hash = ((accumulated1 + Math.imul(accumulated2, 0x61)) >>> 0) % GIT_RENAME_HASH_BASE;
    counts.set(hash, (counts.get(hash) ?? 0) + spanLength);
    accumulated1 = 0;
    accumulated2 = 0;
    spanLength = 0;
  };

  for (let index = 0; index < bytes.byteLength; index += 1) {
    const value = bytes[index]!;
    if (isText && value === 0x0d && index + 1 < bytes.byteLength && bytes[index + 1] === 0x0a) continue;
    const previous1 = accumulated1;
    accumulated1 = (((accumulated1 << 7) ^ (accumulated2 >>> 25)) + value) >>> 0;
    accumulated2 = ((accumulated2 << 7) ^ (previous1 >>> 25)) >>> 0;
    spanLength += 1;
    if (spanLength >= 64 || value === 0x0a) commitSpan();
  }
  if (spanLength > 0) commitSpan();
  return counts;
}

type GitRenameSpanCountCache = Map<GitSimilarityRenameCandidate, Map<number, number>>;

function cachedGitRenameSpanCounts({ candidate, cache }: {
  candidate: GitSimilarityRenameCandidate,
  cache: GitRenameSpanCountCache,
}): Map<number, number> {
  const cached = cache.get(candidate);
  if (cached !== undefined) return cached;
  const counts = gitRenameSpanCounts({ bytes: candidate.bytes });
  cache.set(candidate, counts);
  return counts;
}

function estimateGitRenameSimilarityScoreWithCache({ source, destination, spanCountCache }: {
  source: GitSimilarityRenameCandidate,
  destination: GitSimilarityRenameCandidate,
  spanCountCache: GitRenameSpanCountCache,
}): number {
  if (!isRegularFileMode({ mode: source.mode }) || !isRegularFileMode({ mode: destination.mode })) return 0;
  const sourceSize = source.bytes.byteLength;
  const destinationSize = destination.bytes.byteLength;
  if (sourceSize === 0 || destinationSize === 0) return 0;
  const maximumSize = Math.max(sourceSize, destinationSize);
  const baseSize = Math.min(sourceSize, destinationSize);
  const sizeDelta = maximumSize - baseSize;
  if (maximumSize * (GIT_RENAME_MAX_SCORE - GIT_RENAME_DEFAULT_SCORE) < sizeDelta * GIT_RENAME_MAX_SCORE) return 0;

  const sourceCounts = cachedGitRenameSpanCounts({ candidate: source, cache: spanCountCache });
  const destinationCounts = cachedGitRenameSpanCounts({ candidate: destination, cache: spanCountCache });
  let sourceCopied = 0;
  for (const [hash, sourceCount] of sourceCounts) {
    sourceCopied += Math.min(sourceCount, destinationCounts.get(hash) ?? 0);
  }
  return Math.floor((sourceCopied * GIT_RENAME_MAX_SCORE) / maximumSize);
}

export function estimateGitRenameSimilarityScore({ source, destination }: {
  source: GitSimilarityRenameCandidate,
  destination: GitSimilarityRenameCandidate,
}): number {
  return estimateGitRenameSimilarityScoreWithCache({
    source,
    destination,
    spanCountCache: new Map<GitSimilarityRenameCandidate, Map<number, number>>(),
  });
}

interface GitRenameScoreCandidate {
  sourceIndex: number,
  destinationIndex: number,
  score: number,
  nameScore: number,
}

function gitPathBasename({ path }: { path: string }): string {
  const slashIndex = path.lastIndexOf('/');
  return slashIndex < 0 ? path : path.slice(slashIndex + 1);
}

function gitRenameBasenameSame({ sourcePath, destinationPath }: {
  sourcePath: string,
  destinationPath: string,
}): boolean {
  return gitPathBasename({ path: sourcePath }) === gitPathBasename({ path: destinationPath });
}

function compareGitRenameScoreCandidates({ left, right }: {
  left: GitRenameScoreCandidate | undefined,
  right: GitRenameScoreCandidate | undefined,
}): number {
  if (left === undefined) return right === undefined ? 0 : 1;
  if (right === undefined) return -1;
  if (left.score !== right.score) return right.score - left.score;
  return right.nameScore - left.nameScore;
}

function recordGitRenameCandidateIfBetter({ candidates, candidate }: {
  candidates: Array<GitRenameScoreCandidate | undefined>,
  candidate: GitRenameScoreCandidate,
}): void {
  let worstIndex = 0;
  for (let index = 1; index < candidates.length; index += 1) {
    if (compareGitRenameScoreCandidates({ left: candidates[index], right: candidates[worstIndex] }) > 0) {
      worstIndex = index;
    }
  }
  if (compareGitRenameScoreCandidates({ left: candidates[worstIndex], right: candidate }) > 0) {
    candidates[worstIndex] = candidate;
  }
}

function uniqueBasenameIndexes({ candidates }: {
  candidates: readonly GitSimilarityRenameCandidate[],
}): Map<string, number> {
  const indexes = new Map<string, number>();
  for (let index = 0; index < candidates.length; index += 1) {
    const basename = gitPathBasename({ path: candidates[index]!.path });
    indexes.set(basename, indexes.has(basename) ? -1 : index);
  }
  return indexes;
}

function exactRenameMatches({ deleted, added }: {
  deleted: readonly GitSimilarityRenameCandidate[],
  added: readonly GitSimilarityRenameCandidate[],
}): { matches: GitSimilarityRenameMatch[], usedDeleted: Set<number>, usedAdded: Set<number> } {
  const sourceIndexesByIdentity = new Map<string, number[]>();
  for (let sourceIndex = 0; sourceIndex < deleted.length; sourceIndex += 1) {
    const source = deleted[sourceIndex]!;
    const identity = exactRenameContentIdentity({ objectId: source.objectId, mode: source.mode });
    const indexes = sourceIndexesByIdentity.get(identity) ?? [];
    indexes.push(sourceIndex);
    sourceIndexesByIdentity.set(identity, indexes);
  }
  const queuesByIdentity = new Map<string, GitExactRenameSourceQueue>();
  const usedDeleted = new Set<number>();
  const usedAdded = new Set<number>();
  const matches: GitSimilarityRenameMatch[] = [];
  for (let destinationIndex = 0; destinationIndex < added.length; destinationIndex += 1) {
    const destination = added[destinationIndex]!;
    const identity = exactRenameContentIdentity({ objectId: destination.objectId, mode: destination.mode });
    const sourceIndexes = sourceIndexesByIdentity.get(identity);
    if (sourceIndexes === undefined) continue;
    let queue = queuesByIdentity.get(identity);
    if (queue === undefined) {
      queue = createExactRenameSourceQueue({ candidates: deleted, sourceIndexes });
      queuesByIdentity.set(identity, queue);
    }
    const sourceIndex = takeExactRenameSource({ queue, destinationPath: destination.path });
    if (sourceIndex === undefined) continue;
    usedDeleted.add(sourceIndex);
    usedAdded.add(destinationIndex);
    matches.push({
      sourcePath: deleted[sourceIndex]!.path,
      destinationPath: destination.path,
      score: GIT_RENAME_MAX_SCORE,
    });
  }
  return { matches, usedDeleted, usedAdded };
}

export function findGitRenameMatches({ deleted, added, renameLimit }: {
  deleted: readonly GitSimilarityRenameCandidate[],
  added: readonly GitSimilarityRenameCandidate[],
  renameLimit: number,
}): GitSimilarityRenameMatch[] {
  const exact = exactRenameMatches({ deleted, added });
  const matches = [...exact.matches];
  const spanCountCache: GitRenameSpanCountCache = new Map();
  let remainingDeleted = deleted.filter((_candidate, index) => !exact.usedDeleted.has(index));
  let remainingAdded = added.filter((_candidate, index) => !exact.usedAdded.has(index));

  const sourceBasenames = uniqueBasenameIndexes({ candidates: remainingDeleted });
  const destinationBasenames = uniqueBasenameIndexes({ candidates: remainingAdded });
  const basenameUsedDeleted = new Set<number>();
  const basenameUsedAdded = new Set<number>();
  for (let sourceIndex = 0; sourceIndex < remainingDeleted.length; sourceIndex += 1) {
    const source = remainingDeleted[sourceIndex]!;
    const basename = gitPathBasename({ path: source.path });
    if (sourceBasenames.get(basename) !== sourceIndex) continue;
    const destinationIndex = destinationBasenames.get(basename);
    if (destinationIndex === undefined || destinationIndex < 0 || basenameUsedAdded.has(destinationIndex)) continue;
    const destination = remainingAdded[destinationIndex]!;
    const score = estimateGitRenameSimilarityScoreWithCache({ source, destination, spanCountCache });
    if (score < GIT_RENAME_BASENAME_SCORE) continue;
    basenameUsedDeleted.add(sourceIndex);
    basenameUsedAdded.add(destinationIndex);
    matches.push({ sourcePath: source.path, destinationPath: destination.path, score });
  }
  remainingDeleted = remainingDeleted.filter((_candidate, index) => !basenameUsedDeleted.has(index));
  remainingAdded = remainingAdded.filter((_candidate, index) => !basenameUsedAdded.has(index));

  if (remainingDeleted.length === 0 || remainingAdded.length === 0) return matches;
  if (renameLimit > 0 && remainingDeleted.length * remainingAdded.length > renameLimit * renameLimit) return matches;

  const matrix: Array<GitRenameScoreCandidate | undefined> = [];
  for (let destinationIndex = 0; destinationIndex < remainingAdded.length; destinationIndex += 1) {
    const destination = remainingAdded[destinationIndex]!;
    const candidates = new Array<GitRenameScoreCandidate | undefined>(GIT_RENAME_CANDIDATES_PER_DESTINATION);
    for (let sourceIndex = 0; sourceIndex < remainingDeleted.length; sourceIndex += 1) {
      const source = remainingDeleted[sourceIndex]!;
      recordGitRenameCandidateIfBetter({
        candidates,
        candidate: {
          sourceIndex,
          destinationIndex,
          score: estimateGitRenameSimilarityScoreWithCache({ source, destination, spanCountCache }),
          nameScore: gitRenameBasenameSame({ sourcePath: source.path, destinationPath: destination.path }) ? 1 : 0,
        },
      });
    }
    matrix.push(...candidates);
  }

  const ranked = matrix.flatMap((candidate, stableIndex) => candidate === undefined ? [] : [{ candidate, stableIndex }]);
  ranked.sort((left, right) => compareGitRenameScoreCandidates({ left: left.candidate, right: right.candidate })
    || left.stableIndex - right.stableIndex);
  const usedDeleted = new Set<number>();
  const usedAdded = new Set<number>();
  for (const { candidate } of ranked) {
    if (candidate.score < GIT_RENAME_DEFAULT_SCORE) break;
    if (usedDeleted.has(candidate.sourceIndex) || usedAdded.has(candidate.destinationIndex)) continue;
    usedDeleted.add(candidate.sourceIndex);
    usedAdded.add(candidate.destinationIndex);
    matches.push({
      sourcePath: remainingDeleted[candidate.sourceIndex]!.path,
      destinationPath: remainingAdded[candidate.destinationIndex]!.path,
      score: candidate.score,
    });
  }
  return matches;
}

export function findUnambiguousSimilarityRename({ deleted, added }: {
  deleted: readonly GitSimilarityRenameCandidate[],
  added: readonly GitSimilarityRenameCandidate[],
}): GitSimilarityRenameMatch | undefined {
  if (deleted.length !== 1 || added.length !== 1) return undefined;
  const source = deleted[0]!;
  const destination = added[0]!;
  const score = estimateGitRenameSimilarityScore({ source, destination });
  if (score < GIT_RENAME_DEFAULT_SCORE) return undefined;
  return { sourcePath: source.path, destinationPath: destination.path, score };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  gitRenameSpanCounts,
};
