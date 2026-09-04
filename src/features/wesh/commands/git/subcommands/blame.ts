import { commitSubject, createGitCommitCache, readCachedCommit } from '@/features/wesh/commands/git/commits';
import type { GitCommitCache, ParsedCommit } from '@/features/wesh/commands/git/commits';
import { getDiffRenameLimitConfigValue, readEffectiveConfig } from '@/features/wesh/commands/git/config';
import { createDiffOperations } from '@/features/wesh/commands/git/diff/algorithm';
import { readObject } from '@/features/wesh/commands/git/objects';
import type { GitObjectReadCache } from '@/features/wesh/commands/git/objects';
import { followRenameSourcePath, readPathTree } from '@/features/wesh/commands/git/history';
import { matchRepositoryPathSelection } from '@/features/wesh/commands/git/pathspec';
import { discoverRepositoryFromContext } from '@/features/wesh/commands/git/repository';
import { resolveCommitRevision } from '@/features/wesh/commands/git/revision';
import { GIT_DEFAULT_RENAME_LIMIT } from '@/features/wesh/commands/git/renames';
import { sortGitUtf8Strings } from '@/features/wesh/commands/git/utf8-order';
import { parseAuthorForLog } from '@/features/wesh/commands/git/log-format';
import { analyzeArgvShortForm, defineArgvCatalog } from '@/features/wesh/argv-v2';
import type { WeshCommandContext, WeshCommandResult } from '@/features/wesh/types';
import { GitUsageError } from '@/features/wesh/commands/git/errors';

const BLAME_HELP = `\
usage: git blame [<options>] [<rev>] [--] <file>

    -L <start,end>       annotate only the given line range
    -w                   ignore whitespace when comparing lines
    -M                   detect moved lines within a file
    -C                   detect copied lines from other files; repeat to widen the search
    --porcelain          show machine-readable blame information
    --line-porcelain     show machine-readable metadata for every line
`;

const BLAME_OUTPUT_FLUSH_THRESHOLD = 64 * 1024;

const BLAME_SHORT_ARGV_CATALOG = defineArgvCatalog<'ignore-whitespace' | 'line-range' | 'detect-moves' | 'detect-copies'>({
  nonExecutableLongOptions: [],
  definitions: [
    { semantic: 'ignore-whitespace', forms: [{ kind: 'short', name: 'w', value: { kind: 'none' } }] },
    { semantic: 'line-range', forms: [{ kind: 'short', name: 'L', value: { kind: 'required-attached-or-following', missingValueName: 'start,end' } }] },
    { semantic: 'detect-moves', forms: [{ kind: 'short', name: 'M', value: { kind: 'none' } }] },
    { semantic: 'detect-copies', forms: [{ kind: 'short', name: 'C', value: { kind: 'none' } }] },
  ],
});

interface BlameRange {
  start: number,
  end: number,
}

type BlameCopySearchMode = 'disabled' | 'changed-files' | 'creation-files' | 'all-files';

interface ParsedBlameArguments {
  revision: string,
  pathOperand: string,
  range: BlameRange | undefined,
  ignoreWhitespace: boolean,
  detectMoves: boolean,
  copySearchMode: BlameCopySearchMode,
  porcelain: 'none' | 'porcelain' | 'line-porcelain',
}

function blameCopySearchMode({ level }: { level: number }): BlameCopySearchMode {
  if (level <= 0) return 'disabled';
  if (level === 1) return 'changed-files';
  if (level === 2) return 'creation-files';
  return 'all-files';
}

function parseBlameRange({ value }: { value: string }): BlameRange {
  const match = /^([0-9]+),([0-9]+)$/u.exec(value);
  if (match === null) throw new GitUsageError({ message: `invalid -L parameter '${value}'` });
  const start = Number.parseInt(match[1]!, 10);
  const end = Number.parseInt(match[2]!, 10);
  if (start < 1 || end < start) throw new GitUsageError({ message: `invalid -L parameter '${value}'` });
  return { start, end };
}

function parseBlameArguments({ args }: { args: readonly string[] }): ParsedBlameArguments {
  let range: BlameRange | undefined;
  let ignoreWhitespace = false;
  let detectMoves = false;
  let copySearchLevel = 0;
  let porcelain: ParsedBlameArguments['porcelain'] = 'none';
  let separatorIndex = -1;
  const beforeSeparator: string[] = [];
  const afterSeparator: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (separatorIndex >= 0) {
      afterSeparator.push(arg);
      continue;
    }
    if (arg === '--') {
      separatorIndex = index;
      continue;
    }
    if (arg === '--porcelain') {
      porcelain = 'porcelain';
      continue;
    }
    if (arg === '--line-porcelain') {
      porcelain = 'line-porcelain';
      continue;
    }
    if (arg.startsWith('-') && !arg.startsWith('--') && arg.length > 1) {
      let bodyOffset = 1;
      while (bodyOffset < arg.length) {
        const analysis = analyzeArgvShortForm({ token: arg, bodyOffset, prefix: '-', catalog: BLAME_SHORT_ARGV_CATALOG });
        switch (analysis.kind) {
        case 'unknown':
          throw new GitUsageError({ message: `unknown option: ${arg}` });
        case 'matched':
          break;
        default: {
          const _ex: never = analysis;
          throw new Error(`Unhandled blame argv analysis: ${JSON.stringify(_ex)}`);
        }
        }
        switch (analysis.semantic) {
        case 'ignore-whitespace':
          ignoreWhitespace = true;
          break;
        case 'detect-moves':
          detectMoves = true;
          break;
        case 'detect-copies':
          copySearchLevel += 1;
          break;
        case 'line-range': {
          let rawValue: string;
          switch (analysis.value.kind) {
          case 'inline':
            rawValue = analysis.value.rawValue;
            break;
          case 'following-required': {
            const value = args[index + 1];
            if (value === undefined) throw new GitUsageError({ message: `option '${analysis.option}' requires a value` });
            rawValue = value;
            index += 1;
            break;
          }
          case 'none':
          case 'following-optional':
            throw new Error(`Blame -L produced invalid value claim: ${analysis.value.kind}`);
          default: {
            const _ex: never = analysis.value;
            throw new Error(`Unhandled blame -L value: ${JSON.stringify(_ex)}`);
          }
          }
          range = parseBlameRange({ value: rawValue });
          break;
        }
        default: {
          const _ex: never = analysis.semantic;
          throw new Error(`Unhandled blame option semantic: ${_ex}`);
        }
        }
        bodyOffset = analysis.nextBodyOffset;
      }
      continue;
    }
    if (arg.startsWith('--')) throw new GitUsageError({ message: `unknown option: ${arg}` });
    beforeSeparator.push(arg);
  }

  if (afterSeparator.length > 1) throw new GitUsageError({ message: 'too many path arguments' });
  if (afterSeparator.length === 1) {
    if (beforeSeparator.length > 1) throw new GitUsageError({ message: 'too many revisions specified' });
    return {
      revision: beforeSeparator[0] ?? 'HEAD',
      pathOperand: afterSeparator[0]!,
      range,
      ignoreWhitespace,
      detectMoves,
      copySearchMode: blameCopySearchMode({ level: copySearchLevel }),
      porcelain,
    };
  }
  if (beforeSeparator.length === 0) throw new GitUsageError({ message: 'no path specified' });
  if (beforeSeparator.length > 1) throw new GitUsageError({ message: 'too many path arguments' });
  return { revision: 'HEAD', pathOperand: beforeSeparator[0]!, range, ignoreWhitespace, detectMoves, copySearchMode: blameCopySearchMode({ level: copySearchLevel }), porcelain };
}

async function readCommitFile({ context, repository, commit, path, treeCache, objectReadCache }: {
  context: WeshCommandContext,
  repository: Awaited<ReturnType<typeof discoverRepositoryFromContext>>,
  commit: ParsedCommit,
  path: string,
  treeCache: Map<string, Awaited<ReturnType<typeof readPathTree>>>,
  objectReadCache: GitObjectReadCache,
}): Promise<string[] | undefined> {
  const entries = await readPathTree({
    files: context.files,
    repository,
    treeObjectId: commit.treeObjectId,
    cache: treeCache,
    objectReadCache,
  });
  const entry = entries.get(path);
  if (entry === undefined) return undefined;
  const object = await readObject({
    files: context.files,
    repository,
    objectId: entry.objectId,
    cache: objectReadCache,
  });
  switch (object.type) {
  case 'blob':
    break;
  case 'tree':
  case 'commit':
  case 'tag':
    throw new Error(`path '${path}' does not reference a blob`);
  default: {
    const _ex: never = object.type;
    throw new Error(`Unhandled blame object type: ${_ex}`);
  }
  }
  if (object.body.includes(0)) throw new Error(`cannot blame binary file '${path}'`);
  const lines = new TextDecoder().decode(object.body).split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

interface BlameAttribution {
  commitObjectId: string,
  sourceLine: number,
  sourcePath: string,
}

function comparableLine({ line, ignoreWhitespace }: { line: string, ignoreWhitespace: boolean }): string {
  return ignoreWhitespace ? line.replace(/[ \t\r\n\v\f]+/gu, '') : line;
}

function normalizedBlameLines({ lines, ignoreWhitespace }: {
  lines: readonly string[],
  ignoreWhitespace: boolean,
}): readonly string[] {
  return ignoreWhitespace ? lines.map(line => comparableLine({ line, ignoreWhitespace: true })) : lines;
}

function blameLineAlphanumericScore({ line }: { line: string }): number {
  let score = 0;
  for (let index = 0; index < line.length; index += 1) {
    const code = line.charCodeAt(index);
    if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) score += 1;
  }
  return score;
}

function mapMovedBlameLines({ childLines, normalizedParentLines, normalizedChildLines, childToParent, active }: {
  childLines: readonly string[],
  normalizedParentLines: readonly string[],
  normalizedChildLines: readonly string[],
  childToParent: Map<number, number>,
  active: ReadonlyMap<number, number>,
}): void {
  const usedParentLines = new Set(childToParent.values());
  const activeChildLines = new Set(
    [...active.keys()].filter(childLineIndex => !childToParent.has(childLineIndex)),
  );
  const parentStartsByLine = new Map<string, number[]>();
  for (let parentLineIndex = 0; parentLineIndex < normalizedParentLines.length; parentLineIndex += 1) {
    if (usedParentLines.has(parentLineIndex)) continue;
    const line = normalizedParentLines[parentLineIndex]!;
    const starts = parentStartsByLine.get(line);
    if (starts === undefined) parentStartsByLine.set(line, [parentLineIndex]);
    else starts.push(parentLineIndex);
  }
  const scorePrefix = new Array<number>(childLines.length + 1).fill(0);
  for (let index = 0; index < childLines.length; index += 1) {
    scorePrefix[index + 1] = scorePrefix[index]! + blameLineAlphanumericScore({ line: childLines[index]! });
  }

  for (const childStart of activeChildLines) {
    if (childToParent.has(childStart)) continue;
    let bestParentStart: number | undefined;
    let bestLength = 0;
    let bestScore = 0;
    for (const parentStart of parentStartsByLine.get(normalizedChildLines[childStart]!) ?? []) {
      if (usedParentLines.has(parentStart)) continue;
      let length = 0;
      while (
        activeChildLines.has(childStart + length)
        && childStart + length < normalizedChildLines.length
        && parentStart + length < normalizedParentLines.length
        && !usedParentLines.has(parentStart + length)
        && normalizedChildLines[childStart + length] === normalizedParentLines[parentStart + length]
      ) {
        length += 1;
      }
      if (length === 0) continue;
      const score = scorePrefix[childStart + length]! - scorePrefix[childStart]!;
      if (score > bestScore || (score === bestScore && length > bestLength)) {
        bestParentStart = parentStart;
        bestLength = length;
        bestScore = score;
      }
    }
    if (bestParentStart === undefined || bestScore < 20) continue;
    for (let offset = 0; offset < bestLength; offset += 1) {
      const childLineIndex = childStart + offset;
      const parentLineIndex = bestParentStart + offset;
      childToParent.set(childLineIndex, parentLineIndex);
      usedParentLines.add(parentLineIndex);
    }
  }
}

interface ActiveBlameLines {
  path: string,
  lines: Map<number, number>,
}

interface BlameCopySource {
  path: string,
  lines: readonly string[],
  normalizedLines: readonly string[],
  startsByLine: ReadonlyMap<string, readonly number[]>,
}

function hasUnmappedActiveBlameLine({ active, mapped }: {
  active: ReadonlyMap<number, number>,
  mapped: ReadonlyMap<number, number>,
}): boolean {
  for (const childLineIndex of active.keys()) {
    if (!mapped.has(childLineIndex)) return true;
  }
  return false;
}

function addActiveBlameLine({ activeByPath, path, lineIndex, finalLineIndex }: {
  activeByPath: Map<string, ActiveBlameLines>,
  path: string,
  lineIndex: number,
  finalLineIndex: number,
}): void {
  const existing = activeByPath.get(path);
  if (existing === undefined) {
    activeByPath.set(path, { path, lines: new Map([[lineIndex, finalLineIndex]]) });
    return;
  }
  existing.lines.set(lineIndex, finalLineIndex);
}

function blameScorePrefix({ lines }: { lines: readonly string[] }): number[] {
  const prefix = new Array<number>(lines.length + 1).fill(0);
  for (let index = 0; index < lines.length; index += 1) {
    prefix[index + 1] = prefix[index]! + blameLineAlphanumericScore({ line: lines[index]! });
  }
  return prefix;
}

function lineStartsByValue({ lines }: { lines: readonly string[] }): ReadonlyMap<string, readonly number[]> {
  const starts = new Map<string, number[]>();
  for (let index = 0; index < lines.length; index += 1) {
    const value = lines[index]!;
    const indexes = starts.get(value);
    if (indexes === undefined) starts.set(value, [index]);
    else indexes.push(index);
  }
  return starts;
}

function findCopiedBlameMappings({ childLines, normalizedChildLines, active, alreadyMappedChildLines, sources }: {
  childLines: readonly string[],
  normalizedChildLines: readonly string[],
  active: ReadonlyMap<number, number>,
  alreadyMappedChildLines: ReadonlyMap<number, number>,
  sources: readonly BlameCopySource[],
}): Array<{ childLineIndex: number, sourcePath: string, sourceLineIndex: number }> {
  const remaining = new Set<number>();
  for (const childLineIndex of active.keys()) {
    if (!alreadyMappedChildLines.has(childLineIndex)) remaining.add(childLineIndex);
  }
  const mappings: Array<{ childLineIndex: number, sourcePath: string, sourceLineIndex: number }> = [];
  const scorePrefix = blameScorePrefix({ lines: childLines });

  for (const childStart of remaining) {
    let best: { source: BlameCopySource, sourceStart: number, length: number, score: number } | undefined;
    for (const source of sources) {
      for (const sourceStart of source.startsByLine.get(normalizedChildLines[childStart]!) ?? []) {
        let length = 0;
        while (
          remaining.has(childStart + length)
          && childStart + length < normalizedChildLines.length
          && sourceStart + length < source.normalizedLines.length
          && normalizedChildLines[childStart + length] === source.normalizedLines[sourceStart + length]
        ) {
          length += 1;
        }
        if (length === 0) continue;
        const score = scorePrefix[childStart + length]! - scorePrefix[childStart]!;
        if (best === undefined || score > best.score || (score === best.score && length > best.length)) {
          best = { source, sourceStart, length, score };
        }
      }
    }
    if (best === undefined || best.score < 40) continue;
    for (let offset = 0; offset < best.length; offset += 1) {
      const childLineIndex = childStart + offset;
      remaining.delete(childLineIndex);
      mappings.push({
        childLineIndex,
        sourcePath: best.source.path,
        sourceLineIndex: best.sourceStart + offset,
      });
    }
  }
  return mappings;
}

async function calculateBlame({ context, repository, targetCommitObjectId, path, ignoreWhitespace, detectMoves, copySearchMode, renameLimit, treeCache, commitCache }: {
  context: WeshCommandContext,
  repository: Awaited<ReturnType<typeof discoverRepositoryFromContext>>,
  targetCommitObjectId: string,
  path: string,
  ignoreWhitespace: boolean,
  detectMoves: boolean,
  copySearchMode: BlameCopySearchMode,
  renameLimit: number,
  treeCache: Map<string, Awaited<ReturnType<typeof readPathTree>>>,
  commitCache: GitCommitCache,
}): Promise<{ commitObjectId: string, lines: string[], attributions: BlameAttribution[] }> {
  let childCommitObjectId = targetCommitObjectId;
  let childCommit = await readCachedCommit({ files: context.files, repository, objectId: childCommitObjectId, cache: commitCache });
  const targetLines = await readCommitFile({ context, repository, commit: childCommit, path, treeCache, objectReadCache: commitCache.objectReadCache });
  if (targetLines === undefined) throw new Error(`no such path '${path}' in ${targetCommitObjectId}`);
  const attributions = targetLines.map((_, index) => ({
    commitObjectId: targetCommitObjectId,
    sourceLine: index + 1,
    sourcePath: path,
  }));
  let activeByPath = new Map<string, ActiveBlameLines>([[
    path,
    { path, lines: new Map(targetLines.map((_, index) => [index, index])) },
  ]]);

  while (activeByPath.size > 0) {
    const parentObjectId = childCommit.parentObjectIds[0];
    if (parentObjectId === undefined) break;
    const parentCommit = await readCachedCommit({ files: context.files, repository, objectId: parentObjectId, cache: commitCache });
    const currentTree = await readPathTree({
      files: context.files,
      repository,
      treeObjectId: childCommit.treeObjectId,
      cache: treeCache,
      objectReadCache: commitCache.objectReadCache,
    });
    const parentTree = await readPathTree({
      files: context.files,
      repository,
      treeObjectId: parentCommit.treeObjectId,
      cache: treeCache,
      objectReadCache: commitCache.objectReadCache,
    });
    const nextActiveByPath = new Map<string, ActiveBlameLines>();
    const copyRequests: Array<{
      childPath: string,
      childLines: readonly string[],
      normalizedChildLines: readonly string[],
      active: ReadonlyMap<number, number>,
      mappedChildLines: ReadonlyMap<number, number>,
      excludedSourcePath: string | undefined,
      childPathWasCreated: boolean,
    }> = [];

    for (const activePath of activeByPath.values()) {
      const childLines = await readCommitFile({ context, repository, commit: childCommit, path: activePath.path, treeCache, objectReadCache: commitCache.objectReadCache });
      if (childLines === undefined) throw new Error(`active blame path '${activePath.path}' disappeared from ${childCommitObjectId}`);
      const currentEntry = currentTree.get(activePath.path);
      const parentEntry = parentTree.get(activePath.path);
      const same = currentEntry?.objectId === parentEntry?.objectId && currentEntry?.mode === parentEntry?.mode;
      const parentPath = same
        ? activePath.path
        : await followRenameSourcePath({
          files: context.files,
          repository,
          parentTree,
          currentTree,
          destinationPath: activePath.path,
          renameLimit,
          objectReadCache: commitCache.objectReadCache,
        }) ?? activePath.path;
      const parentLines = await readCommitFile({ context, repository, commit: parentCommit, path: parentPath, treeCache, objectReadCache: commitCache.objectReadCache });
      const childToParent = new Map<number, number>();
      const normalizedChildLines = normalizedBlameLines({ lines: childLines, ignoreWhitespace });
      if (parentLines !== undefined) {
        const normalizedParentLines = normalizedBlameLines({ lines: parentLines, ignoreWhitespace });
        const operations = createDiffOperations({
          leftLength: parentLines.length,
          rightLength: childLines.length,
          areEqual: ({ leftIndex, rightIndex }) => normalizedParentLines[leftIndex] === normalizedChildLines[rightIndex],
        });
        for (const operation of operations) {
          switch (operation.kind) {
          case 'equal':
            for (let offset = 0; offset < operation.length; offset += 1) {
              childToParent.set(operation.rightStart + offset, operation.leftStart + offset);
            }
            break;
          case 'delete':
          case 'insert':
            break;
          default: {
            const _ex: never = operation;
            throw new Error(`Unhandled blame diff operation: ${JSON.stringify(_ex)}`);
          }
          }
        }
        if (detectMoves || copySearchMode !== 'disabled') {
          mapMovedBlameLines({
            childLines,
            normalizedParentLines,
            normalizedChildLines,
            childToParent,
            active: activePath.lines,
          });
        }
        for (const [childLineIndex, finalLineIndex] of activePath.lines) {
          const parentLineIndex = childToParent.get(childLineIndex);
          if (parentLineIndex === undefined) continue;
          attributions[finalLineIndex] = {
            commitObjectId: parentObjectId,
            sourceLine: parentLineIndex + 1,
            sourcePath: parentPath,
          };
          addActiveBlameLine({
            activeByPath: nextActiveByPath,
            path: parentPath,
            lineIndex: parentLineIndex,
            finalLineIndex,
          });
        }
      }
      if (copySearchMode !== 'disabled' && hasUnmappedActiveBlameLine({ active: activePath.lines, mapped: childToParent })) {
        copyRequests.push({
          childPath: activePath.path,
          childLines,
          normalizedChildLines,
          active: activePath.lines,
          mappedChildLines: childToParent,
          excludedSourcePath: parentLines === undefined ? undefined : parentPath,
          childPathWasCreated: parentLines === undefined,
        });
      }
    }

    if (copySearchMode !== 'disabled' && copyRequests.length > 0) {
      const shouldLoadAllCandidatePaths = copySearchMode === 'all-files'
        || (copySearchMode === 'creation-files' && copyRequests.some(request => request.childPathWasCreated));
      const changedCandidateSourcePathsUnsorted: string[] = [];
      const allCandidateSourcePathsUnsorted = shouldLoadAllCandidatePaths ? [] as string[] : undefined;
      for (const [sourcePath, parentEntry] of parentTree) {
        if (parentEntry.mode === 0o160000) continue;
        allCandidateSourcePathsUnsorted?.push(sourcePath);
        const currentEntry = currentTree.get(sourcePath);
        if (currentEntry?.objectId !== parentEntry.objectId || currentEntry?.mode !== parentEntry.mode) {
          changedCandidateSourcePathsUnsorted.push(sourcePath);
        }
      }
      const changedCandidateSourcePaths = sortGitUtf8Strings({ values: changedCandidateSourcePathsUnsorted });
      const allCandidateSourcePaths = allCandidateSourcePathsUnsorted === undefined
        ? undefined
        : sortGitUtf8Strings({ values: allCandidateSourcePathsUnsorted });
      const sourceCache = new Map<string, BlameCopySource | undefined>();
      const loadCopySource = async ({ sourcePath }: { sourcePath: string }): Promise<BlameCopySource | undefined> => {
        if (sourceCache.has(sourcePath)) return sourceCache.get(sourcePath);
        const lines = await readCommitFile({ context, repository, commit: parentCommit, path: sourcePath, treeCache, objectReadCache: commitCache.objectReadCache });
        if (lines === undefined) {
          sourceCache.set(sourcePath, undefined);
          return undefined;
        }
        const normalizedLines = normalizedBlameLines({ lines, ignoreWhitespace });
        const source = {
          path: sourcePath,
          lines,
          normalizedLines,
          startsByLine: lineStartsByValue({ lines: normalizedLines }),
        };
        sourceCache.set(sourcePath, source);
        return source;
      };

      for (const request of copyRequests) {
        let candidateSourcePaths: readonly string[];
        switch (copySearchMode) {
        case 'changed-files':
          candidateSourcePaths = changedCandidateSourcePaths;
          break;
        case 'creation-files':
          candidateSourcePaths = request.childPathWasCreated
            ? allCandidateSourcePaths!
            : changedCandidateSourcePaths;
          break;
        case 'all-files':
          candidateSourcePaths = allCandidateSourcePaths!;
          break;
        default: {
          const _ex: never = copySearchMode;
          throw new Error(`Unhandled blame copy search mode: ${_ex}`);
        }
        }
        const sources: BlameCopySource[] = [];
        for (const sourcePath of candidateSourcePaths) {
          if (sourcePath === request.excludedSourcePath || sourcePath === request.childPath) continue;
          const source = await loadCopySource({ sourcePath });
          if (source !== undefined) sources.push(source);
        }
        const mappings = findCopiedBlameMappings({
          childLines: request.childLines,
          normalizedChildLines: request.normalizedChildLines,
          active: request.active,
          alreadyMappedChildLines: request.mappedChildLines,
          sources,
        });
        for (const mapping of mappings) {
          const finalLineIndex = request.active.get(mapping.childLineIndex);
          if (finalLineIndex === undefined) continue;
          attributions[finalLineIndex] = {
            commitObjectId: parentObjectId,
            sourceLine: mapping.sourceLineIndex + 1,
            sourcePath: mapping.sourcePath,
          };
          addActiveBlameLine({
            activeByPath: nextActiveByPath,
            path: mapping.sourcePath,
            lineIndex: mapping.sourceLineIndex,
            finalLineIndex,
          });
        }
      }
    }

    activeByPath = nextActiveByPath;
    childCommitObjectId = parentObjectId;
    childCommit = parentCommit;
  }
  return { commitObjectId: targetCommitObjectId, lines: targetLines, attributions };
}

function blameDate({ timestamp, timezone }: { timestamp: number, timezone: string }): string {
  const sign = timezone.startsWith('-') ? -1 : 1;
  const hours = Number.parseInt(timezone.slice(1, 3), 10);
  const minutes = Number.parseInt(timezone.slice(3, 5), 10);
  const offsetMinutes = sign * (hours * 60 + minutes);
  const adjusted = new Date((timestamp + offsetMinutes * 60) * 1000);
  const date = adjusted.toISOString().slice(0, 19).replace('T', ' ');
  return `${date} ${timezone}`;
}

function blameIdentity({ identity }: { identity: string }): { name: string, email: string } {
  const match = /^(.*) <([^>]*)>$/u.exec(identity);
  return match === null ? { name: identity, email: '' } : { name: match[1]!, email: match[2]! };
}

interface BlameCommitPresentation {
  authorName: string,
  authorEmail: string,
  authorTimestamp: number,
  authorTimezone: string,
  authorDate: string,
  committerName: string,
  committerEmail: string,
  committerTimestamp: number,
  committerTimezone: string,
  summary: string,
  boundary: boolean,
}

async function readBlameCommitPresentation({ files, repository, objectId, commitCache, presentationCache }: {
  files: WeshCommandContext['files'],
  repository: Awaited<ReturnType<typeof discoverRepositoryFromContext>>,
  objectId: string,
  commitCache: GitCommitCache,
  presentationCache: Map<string, BlameCommitPresentation>,
}): Promise<BlameCommitPresentation> {
  const cached = presentationCache.get(objectId);
  if (cached !== undefined) return cached;
  const commit = await readCachedCommit({ files, repository, objectId, cache: commitCache });
  const author = parseAuthorForLog({ author: commit.author });
  const committer = parseAuthorForLog({ author: commit.committer });
  const authorIdentity = blameIdentity({ identity: author.identity });
  const committerIdentity = blameIdentity({ identity: committer.identity });
  const presentation: BlameCommitPresentation = {
    authorName: authorIdentity.name,
    authorEmail: authorIdentity.email,
    authorTimestamp: author.timestamp,
    authorTimezone: author.timezone,
    authorDate: blameDate({ timestamp: author.timestamp, timezone: author.timezone }),
    committerName: committerIdentity.name,
    committerEmail: committerIdentity.email,
    committerTimestamp: committer.timestamp,
    committerTimezone: committer.timezone,
    summary: commitSubject({ commit }),
    boundary: commit.parentObjectIds.length === 0,
  };
  presentationCache.set(objectId, presentation);
  return presentation;
}

export async function runBlame({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  if (args.length === 1 && args[0] === '--help') {
    await context.text().print({ text: BLAME_HELP });
    return { exitCode: 0 };
  }
  const parsed = parseBlameArguments({ args });
  const repository = await discoverRepositoryFromContext({ context });
  const config = await readEffectiveConfig({
    files: context.files,
    repository,
    homePath: context.env.get('HOME') ?? '/',
    cwd: context.cwd,
    env: context.env,
  });
  const renameLimit = getDiffRenameLimitConfigValue({ config }) ?? GIT_DEFAULT_RENAME_LIMIT;
  const targetCommitObjectId = await resolveCommitRevision({ files: context.files, repository, expression: parsed.revision });
  const commitCache = createGitCommitCache();
  const targetCommit = await readCachedCommit({ files: context.files, repository, objectId: targetCommitObjectId, cache: commitCache });
  const treeCache = new Map<string, Awaited<ReturnType<typeof readPathTree>>>();
  const targetTree = await readPathTree({
    files: context.files,
    repository,
    treeObjectId: targetCommit.treeObjectId,
    cache: treeCache,
  });
  const selected = matchRepositoryPathSelection({
    repository,
    cwd: context.cwd,
    operands: [parsed.pathOperand],
    availablePaths: targetTree.keys(),
  }).selected;
  if (selected.size !== 1) throw new Error(`path '${parsed.pathOperand}' did not match exactly one file`);
  const path = selected.values().next().value as string;
  const blame = await calculateBlame({
    context,
    repository,
    targetCommitObjectId,
    path,
    ignoreWhitespace: parsed.ignoreWhitespace,
    detectMoves: parsed.detectMoves,
    copySearchMode: parsed.copySearchMode,
    renameLimit,
    treeCache,
    commitCache,
  });
  const start = parsed.range?.start ?? 1;
  const end = Math.min(parsed.range?.end ?? blame.lines.length, blame.lines.length);
  if (start > blame.lines.length) throw new GitUsageError({ message: `file ${path} has only ${blame.lines.length} lines` });
  const emittedMetadata = new Set<string>();
  const presentationCache = new Map<string, BlameCommitPresentation>();
  let previousAttribution: BlameAttribution | undefined;
  let outputBuffer = '';

  for (let finalLine = start; finalLine <= end; finalLine += 1) {
    const attribution = blame.attributions[finalLine - 1]!;
    const presentation = await readBlameCommitPresentation({
      files: context.files,
      repository,
      objectId: attribution.commitObjectId,
      commitCache,
      presentationCache,
    });
    const line = blame.lines[finalLine - 1]!;
    switch (parsed.porcelain) {
    case 'none': {
      const displayObjectId = presentation.boundary
        ? `^${attribution.commitObjectId.slice(0, 7)}`
        : attribution.commitObjectId.slice(0, 8);
      const sourcePath = attribution.sourcePath === path ? '' : ` ${attribution.sourcePath}`;
      outputBuffer += `${displayObjectId}${sourcePath} (${presentation.authorName} ${presentation.authorDate} ${String(finalLine).padStart(String(end).length, ' ')}) ${line}\n`;
      break;
    }
    case 'porcelain':
    case 'line-porcelain': {
      const startsGroup = previousAttribution === undefined
        || previousAttribution.commitObjectId !== attribution.commitObjectId
        || previousAttribution.sourcePath !== attribution.sourcePath
        || previousAttribution.sourceLine + 1 !== attribution.sourceLine;
      let groupLength = 1;
      if (startsGroup) {
        for (let lookahead = finalLine + 1; lookahead <= end; lookahead += 1) {
          const next = blame.attributions[lookahead - 1]!;
          if (next.commitObjectId !== attribution.commitObjectId
            || next.sourcePath !== attribution.sourcePath
            || next.sourceLine !== attribution.sourceLine + groupLength) break;
          groupLength += 1;
        }
      }
      const groupSuffix = startsGroup ? ` ${groupLength}` : '';
      outputBuffer += `${attribution.commitObjectId} ${attribution.sourceLine} ${finalLine}${groupSuffix}\n`;
      const metadataKey = `${attribution.commitObjectId}\0${attribution.sourcePath}`;
      const shouldEmitMetadata = parsed.porcelain === 'line-porcelain' || !emittedMetadata.has(metadataKey);
      if (shouldEmitMetadata) {
        outputBuffer += `author ${presentation.authorName}\n`;
        outputBuffer += `author-mail <${presentation.authorEmail}>\n`;
        outputBuffer += `author-time ${presentation.authorTimestamp}\n`;
        outputBuffer += `author-tz ${presentation.authorTimezone}\n`;
        outputBuffer += `committer ${presentation.committerName}\n`;
        outputBuffer += `committer-mail <${presentation.committerEmail}>\n`;
        outputBuffer += `committer-time ${presentation.committerTimestamp}\n`;
        outputBuffer += `committer-tz ${presentation.committerTimezone}\n`;
        outputBuffer += `summary ${presentation.summary}\n`;
        if (presentation.boundary) outputBuffer += 'boundary\n';
        outputBuffer += `filename ${attribution.sourcePath}\n`;
        emittedMetadata.add(metadataKey);
      }
      outputBuffer += `\t${line}\n`;
      break;
    }
    default: {
      const _ex: never = parsed.porcelain;
      throw new Error(`Unhandled blame output mode: ${_ex}`);
    }
    }
    previousAttribution = attribution;
    if (outputBuffer.length >= BLAME_OUTPUT_FLUSH_THRESHOLD) {
      await context.text().print({ text: outputBuffer });
      outputBuffer = '';
    }
  }
  if (outputBuffer.length > 0) await context.text().print({ text: outputBuffer });
  return { exitCode: 0 };
}

export const TEST_ONLY = {
  parseBlameArguments,
};
