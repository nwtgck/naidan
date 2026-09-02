import { testGitExtendedRegexBytes } from '@/features/wesh/commands/git/extended-regex';
import type { GitExtendedRegex } from '@/features/wesh/commands/git/extended-regex';
import { resolveCharacterLocaleMode } from "@/features/wesh/commands/_shared/locale";
import { createDiffOperations } from "@/features/wesh/commands/git/diff/algorithm";
import { compareDiffInputs } from "@/features/wesh/commands/git/diff/compare";
import { createDiffInput, createLineComparator, getLineBytes } from "@/features/wesh/commands/git/diff/input";
import type { DiffCompareSettings } from "@/features/wesh/commands/git/diff/compare";
import type { DiffComparisonOptions } from "@/features/wesh/commands/git/diff/model";
import { createDiffByteWriter } from "@/features/wesh/commands/git/diff/output";
import type { WeshCommandContext } from "@/features/wesh/types";
import { readObject } from "@/features/wesh/commands/git/objects";
import type { GitRepository } from "@/features/wesh/commands/git/repository";
import { resolveCommitRevision } from "@/features/wesh/commands/git/revision";
import { readCommit } from "@/features/wesh/commands/git/commits";
import { readTreeRecursively } from "@/features/wesh/commands/git/tree";
import { matchRepositoryPaths } from "@/features/wesh/commands/git/pathspec";
import { formatGitPatchPath, quoteGitPath } from "@/features/wesh/commands/git/path-output";
import { compareGitPaths, sortGitPaths } from "@/features/wesh/commands/git/path-order";
import { exactRenameContentIdentity, findExactRenames, findGitRenameMatches } from "@/features/wesh/commands/git/renames";
import type { GitExactRenameMatch, GitSimilarityRenameMatch } from "@/features/wesh/commands/git/renames";

const gitlinkEncoder = new TextEncoder();

export function gitlinkDiffBytes({ objectId }: { objectId: string }): Uint8Array {
  return gitlinkEncoder.encode(`Subproject commit ${objectId}\n`);
}

interface GitDiffSnapshotEntry {
  path: string,
  mode: number,
  objectId: string,
  bytes: Uint8Array,
}

export type GitDiffSnapshot = Map<string, GitDiffSnapshotEntry>;

export async function snapshotFromTree({ context, repository, revision }: {
  context: WeshCommandContext,
  repository: GitRepository,
  revision: string,
}): Promise<GitDiffSnapshot> {
  const objectId = await resolveCommitRevision({ files: context.files, repository, expression: revision });
  const commit = await readCommit({ files: context.files, repository, objectId });
  const treeEntries = await readTreeRecursively({
    files: context.files,
    repository,
    treeObjectId: commit.treeObjectId,
  });
  const result: GitDiffSnapshot = new Map();
  for (const entry of treeEntries) {
    if (entry.mode === 0o160000) {
      result.set(entry.path, {
        path: entry.path,
        mode: entry.mode,
        objectId: entry.objectId,
        bytes: gitlinkDiffBytes({ objectId: entry.objectId }),
      });
      continue;
    }
    const object = await readObject({ files: context.files, repository, objectId: entry.objectId });
    switch (object.type) {
    case 'blob':
      result.set(entry.path, { path: entry.path, mode: entry.mode, objectId: entry.objectId, bytes: object.body });
      break;
    case 'tree':
    case 'commit':
    case 'tag':
      throw new Error(`tree entry ${entry.path} does not reference a blob`);
    default: {
      const _ex: never = object.type;
      throw new Error(`Unhandled object type: ${_ex}`);
    }
    }
  }
  return result;
}

export function defaultComparisonOptions(): DiffComparisonOptions {
  return {
    stripTrailingCarriageReturn: false,
    ignoreCase: false,
    ignoreTabExpansion: false,
    ignoreTrailingSpace: false,
    ignoreSpaceChange: false,
    ignoreAllSpace: false,
    tabSize: 8,
  };
}

function defaultCompareSettings({ labels, characterLocaleMode }: {
  labels: readonly string[],
  characterLocaleMode: 'ascii' | 'unicode',
}): DiffCompareSettings {
  return {
    comparisonOptions: defaultComparisonOptions(),
    outputOptions: {
      mode: { kind: 'unified', contextLines: 3 },
      characterLocaleMode,
      functionLinePattern: /^[^\s].*/u,
      expandTabs: false,
      initialTab: false,
      tabSize: 8,
      suppressBlankEmpty: false,
      labels,
    },
    binaryMode: 'detect',
    reportIdenticalFiles: false,
    ignoreBlankLineChanges: false,
    ignoreMatchingLinePatterns: [],
    preferSpeedOverCompatibility: false,
  };
}

function formatMode({ mode }: { mode: number }): string {
  return mode.toString(8).padStart(6, '0');
}

function shortObjectId({ objectId }: { objectId: string }): string {
  return objectId.slice(0, 7);
}

export async function writePatchEntry({ context, path, left, right, quoteNonAscii }: {
  context: WeshCommandContext,
  path: string,
  left: GitDiffSnapshotEntry | undefined,
  right: GitDiffSnapshotEntry | undefined,
  quoteNonAscii: boolean,
}): Promise<void> {
  if (left !== undefined && right !== undefined
    && left.objectId === right.objectId && left.mode === right.mode) return;

  const writer = createDiffByteWriter({ handle: context.stdout });
  const leftDiffPath = formatGitPatchPath({ path, prefix: 'a', quoteNonAscii, headerLabel: false });
  const rightDiffPath = formatGitPatchPath({ path, prefix: 'b', quoteNonAscii, headerLabel: false });
  const leftHeaderPath = formatGitPatchPath({ path, prefix: 'a', quoteNonAscii, headerLabel: true });
  const rightHeaderPath = formatGitPatchPath({ path, prefix: 'b', quoteNonAscii, headerLabel: true });
  await writer.writeText({ text: `diff --git ${leftDiffPath} ${rightDiffPath}\n` });
  if (left === undefined && right !== undefined) {
    await writer.writeText({ text: `new file mode ${formatMode({ mode: right.mode })}\n` });
  } else if (left !== undefined && right === undefined) {
    await writer.writeText({ text: `deleted file mode ${formatMode({ mode: left.mode })}\n` });
  } else if (left !== undefined && right !== undefined && left.mode !== right.mode) {
    await writer.writeText({ text: `old mode ${formatMode({ mode: left.mode })}\nnew mode ${formatMode({ mode: right.mode })}\n` });
  }

  if (left?.objectId !== right?.objectId) {
    await writer.writeText({
      text: `index ${left === undefined ? '0000000' : shortObjectId({ objectId: left.objectId })}..${right === undefined ? '0000000' : shortObjectId({ objectId: right.objectId })}${left !== undefined && right !== undefined && left.mode === right.mode ? ` ${formatMode({ mode: left.mode })}` : ''}\n`,
    });
    const leftBytes = left?.bytes ?? new Uint8Array();
    const rightBytes = right?.bytes ?? new Uint8Array();
    await compareDiffInputs({
      writer,
      left: createDiffInput({ displayName: leftDiffPath, resolvedPath: undefined, mtime: undefined, bytes: leftBytes }),
      right: createDiffInput({ displayName: rightDiffPath, resolvedPath: undefined, mtime: undefined, bytes: rightBytes }),
      settings: defaultCompareSettings({
        labels: [left === undefined ? '/dev/null' : leftHeaderPath, right === undefined ? '/dev/null' : rightHeaderPath],
        characterLocaleMode: resolveCharacterLocaleMode({ env: context.env }),
      }),
    });
  }
  await writer.flush();
}

export function changedPaths({ left, right }: { left: GitDiffSnapshot, right: GitDiffSnapshot }): string[] {
  const paths = new Set([...left.keys(), ...right.keys()]);
  return sortGitPaths({ paths: [...paths].filter(path => {
    const a = left.get(path);
    const b = right.get(path);
    return a?.objectId !== b?.objectId || a?.mode !== b?.mode;
  }) });
}

export function exactRenamesForPaths({ paths, left, right }: {
  paths: readonly string[],
  left: GitDiffSnapshot,
  right: GitDiffSnapshot,
}): GitExactRenameMatch[] {
  return findExactRenames({
    deleted: paths.flatMap(path => {
      const entry = left.get(path);
      return entry !== undefined && !right.has(path)
        ? [{ path, objectId: entry.objectId, mode: entry.mode }]
        : [];
    }),
    added: paths.flatMap(path => {
      const entry = right.get(path);
      return entry !== undefined && !left.has(path)
        ? [{ path, objectId: entry.objectId, mode: entry.mode }]
        : [];
    }),
  });
}

export async function writeExactRenamePatch({ context, rename, quoteNonAscii }: {
  context: WeshCommandContext,
  rename: GitExactRenameMatch,
  quoteNonAscii: boolean,
}): Promise<void> {
  const sourceDiffPath = formatGitPatchPath({ path: rename.sourcePath, prefix: 'a', quoteNonAscii, headerLabel: false });
  const destinationDiffPath = formatGitPatchPath({ path: rename.destinationPath, prefix: 'b', quoteNonAscii, headerLabel: false });
  const sourcePath = quoteGitPath({ path: rename.sourcePath, quoteNonAscii, quoteSpaces: false });
  const destinationPath = quoteGitPath({ path: rename.destinationPath, quoteNonAscii, quoteSpaces: false });
  const modeChange = rename.sourceMode === rename.destinationMode
    ? ''
    : `old mode ${formatMode({ mode: rename.sourceMode })}\nnew mode ${formatMode({ mode: rename.destinationMode })}\n`;
  await context.text().print({
    text: `diff --git ${sourceDiffPath} ${destinationDiffPath}\n${modeChange}similarity index 100%\nrename from ${sourcePath}\nrename to ${destinationPath}\n`,
  });
}

interface GitDiffStatEntry {
  path: string,
  sortPath: string,
  additions: number,
  deletions: number,
  binarySize: { left: number, right: number } | undefined,
}

const GIT_BINARY_PROBE_BYTE_LIMIT = 8000;

function isGitBinaryContent({ bytes }: { bytes: Uint8Array }): boolean {
  const limit = Math.min(bytes.byteLength, GIT_BINARY_PROBE_BYTE_LIMIT);
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) return true;
  }
  return false;
}

function diffLineCounts({ leftBytes, rightBytes }: {
  leftBytes: Uint8Array,
  rightBytes: Uint8Array,
}): { additions: number, deletions: number } {
  const leftInput = createDiffInput({ displayName: 'left', resolvedPath: undefined, mtime: undefined, bytes: leftBytes });
  const rightInput = createDiffInput({ displayName: 'right', resolvedPath: undefined, mtime: undefined, bytes: rightBytes });
  const operations = createDiffOperations({
    leftLength: leftInput.lines.starts.length,
    rightLength: rightInput.lines.starts.length,
    areEqual: createLineComparator({ left: leftInput, right: rightInput, options: defaultComparisonOptions() }),
    preferSpeedOverCompatibility: false,
  });
  let additions = 0;
  let deletions = 0;
  for (const operation of operations) {
    switch (operation.kind) {
    case 'equal':
      break;
    case 'insert':
      additions += operation.length;
      break;
    case 'delete':
      deletions += operation.length;
      break;
    default: {
      const _ex: never = operation;
      throw new Error(`Unhandled diff operation: ${JSON.stringify(_ex)}`);
    }
    }
  }
  return { additions, deletions };
}

function scaleStatGraph({ additions, deletions }: { additions: number, deletions: number }): string {
  const total = additions + deletions;
  if (total === 0) return '';
  const maximumWidth = 50;
  if (total <= maximumWidth) return `${'+'.repeat(additions)}${'-'.repeat(deletions)}`;
  let additionWidth = Math.round((additions / total) * maximumWidth);
  if (additions > 0) additionWidth = Math.max(1, additionWidth);
  if (deletions > 0) additionWidth = Math.min(maximumWidth - 1, additionWidth);
  return `${'+'.repeat(additionWidth)}${'-'.repeat(maximumWidth - additionWidth)}`;
}

function createDiffStatEntries({ paths, left, right }: {
  paths: readonly string[],
  left: GitDiffSnapshot,
  right: GitDiffSnapshot,
}): GitDiffStatEntry[] {
  return paths.map(path => {
    const leftEntry = left.get(path);
    const rightEntry = right.get(path);
    const leftBytes = leftEntry?.bytes ?? new Uint8Array();
    const rightBytes = rightEntry?.bytes ?? new Uint8Array();
    if (leftEntry?.objectId !== rightEntry?.objectId && (isGitBinaryContent({ bytes: leftBytes }) || isGitBinaryContent({ bytes: rightBytes }))) {
      return {
        path,
        sortPath: path,
        additions: 0,
        deletions: 0,
        binarySize: { left: leftBytes.byteLength, right: rightBytes.byteLength },
      };
    }
    const counts = leftEntry?.objectId === rightEntry?.objectId
      ? { additions: 0, deletions: 0 }
      : diffLineCounts({ leftBytes, rightBytes });
    return { path, sortPath: path, ...counts, binarySize: undefined };
  });
}

function renameStatPath({ sourcePath, destinationPath }: { sourcePath: string, destinationPath: string }): string {
  const source = sourcePath.split('/');
  const destination = destinationPath.split('/');
  let prefixLength = 0;
  while (prefixLength < source.length && prefixLength < destination.length
    && source[prefixLength] === destination[prefixLength]) {
    prefixLength += 1;
  }
  let suffixLength = 0;
  while (suffixLength < source.length - prefixLength && suffixLength < destination.length - prefixLength
    && source[source.length - 1 - suffixLength] === destination[destination.length - 1 - suffixLength]) {
    suffixLength += 1;
  }
  if (prefixLength === 0 && suffixLength === 0) return `${sourcePath} => ${destinationPath}`;
  const prefix = source.slice(0, prefixLength);
  const sourceMiddle = source.slice(prefixLength, source.length - suffixLength).join('/');
  const destinationMiddle = destination.slice(prefixLength, destination.length - suffixLength).join('/');
  const suffix = suffixLength === 0 ? [] : source.slice(source.length - suffixLength);
  return [...prefix, `{${sourceMiddle} => ${destinationMiddle}}`, ...suffix].join('/');
}

export async function writeDiffStat({ context, paths, left, right, quoteNonAscii, detectRenames, unmergedPaths = [] }: {
  context: WeshCommandContext,
  paths: readonly string[],
  left: GitDiffSnapshot,
  right: GitDiffSnapshot,
  quoteNonAscii: boolean,
  detectRenames: boolean,
  unmergedPaths?: readonly string[],
}): Promise<void> {
  if (paths.length === 0 && unmergedPaths.length === 0) return;
  const exactRenames = detectRenames ? exactRenamesForPaths({ paths, left, right }) : [];
  const renamePaths = new Set(exactRenames.flatMap(rename => [rename.sourcePath, rename.destinationPath]));
  const entries = [
    ...createDiffStatEntries({ paths: paths.filter(path => !renamePaths.has(path)), left, right }),
    ...exactRenames.map(rename => ({
      path: renameStatPath({ sourcePath: rename.sourcePath, destinationPath: rename.destinationPath }),
      sortPath: rename.sourcePath,
      additions: 0,
      deletions: 0,
      binarySize: undefined,
    })),
  ];
  const renderedPaths = new Map(entries.map(entry => [
    entry.path,
    quoteGitPath({ path: entry.path, quoteNonAscii, quoteSpaces: false }),
  ]));
  for (const path of unmergedPaths) {
    renderedPaths.set(path, quoteGitPath({ path, quoteNonAscii, quoteSpaces: false }));
  }
  const pathWidth = Math.max(...[...renderedPaths.values()].map(path => path.length));
  const hasBinary = entries.some(entry => entry.binarySize !== undefined);
  const maximumCount = Math.max(0, ...entries.map(entry => entry.additions + entry.deletions));
  const countWidth = hasBinary ? Math.max(3, String(maximumCount).length) : String(maximumCount).length;
  const rows = [
    ...unmergedPaths.map(path => ({ kind: 'unmerged' as const, sortPath: path, path })),
    ...entries.map(entry => ({ kind: 'entry' as const, sortPath: entry.sortPath, entry })),
  ].sort((leftRow, rightRow) => compareGitPaths({ left: leftRow.sortPath, right: rightRow.sortPath }));
  for (const row of rows) {
    switch (row.kind) {
    case 'unmerged': {
      const renderedPath = renderedPaths.get(row.path)!;
      const prefix = ` ${renderedPath.padEnd(pathWidth)} | `;
      await context.text().print({ text: `${prefix}Unmerged\n` });
      break;
    }
    case 'entry': {
      const { entry } = row;
      const renderedPath = renderedPaths.get(entry.path)!;
      const prefix = ` ${renderedPath.padEnd(pathWidth)} | `;
      if (entry.binarySize !== undefined) {
        await context.text().print({ text: `${prefix}Bin ${entry.binarySize.left} -> ${entry.binarySize.right} bytes\n` });
        break;
      }
      const count = entry.additions + entry.deletions;
      const graph = scaleStatGraph({ additions: entry.additions, deletions: entry.deletions });
      await context.text().print({ text: `${prefix}${String(count).padStart(countWidth)}${graph.length === 0 ? '' : ` ${graph}`}\n` });
      break;
    }
    default: {
      const _ex: never = row;
      throw new Error(`Unhandled diff stat row: ${JSON.stringify(_ex)}`);
    }
    }
  }
  const additions = entries.reduce((sum, entry) => sum + entry.additions, 0);
  const deletions = entries.reduce((sum, entry) => sum + entry.deletions, 0);
  let summary = ` ${entries.length} file${entries.length === 1 ? '' : 's'} changed`;
  if (additions === 0 && deletions === 0) {
    if (entries.length === 0) {
      await context.text().print({ text: `${summary}\n` });
      return;
    }
    summary += ', 0 insertions(+), 0 deletions(-)';
  } else {
    if (additions > 0) summary += `, ${additions} insertion${additions === 1 ? '' : 's'}(+)`;
    if (deletions > 0) summary += `, ${deletions} deletion${deletions === 1 ? '' : 's'}(-)`;
  }
  await context.text().print({ text: `${summary}\n` });
}

export type GitDiffSearch =
  | { type: 'string', bytes: Uint8Array }
  | { type: 'regex', pattern: GitExtendedRegex };

function countByteSequence({ bytes, needle }: { bytes: Uint8Array, needle: Uint8Array }): number {
  if (needle.byteLength === 0) return 0;
  let count = 0;
  for (let offset = 0; offset + needle.byteLength <= bytes.byteLength;) {
    let matches = true;
    for (let index = 0; index < needle.byteLength; index += 1) {
      if (bytes[offset + index] !== needle[index]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      count += 1;
      offset += needle.byteLength;
    } else offset += 1;
  }
  return count;
}

function changedLinesMatch({ leftBytes, rightBytes, pattern }: {
  leftBytes: Uint8Array,
  rightBytes: Uint8Array,
  pattern: GitExtendedRegex,
}): boolean {
  if (isGitBinaryContent({ bytes: leftBytes }) || isGitBinaryContent({ bytes: rightBytes })) return false;
  const leftInput = createDiffInput({ displayName: 'left', resolvedPath: undefined, mtime: undefined, bytes: leftBytes });
  const rightInput = createDiffInput({ displayName: 'right', resolvedPath: undefined, mtime: undefined, bytes: rightBytes });
  const operations = createDiffOperations({
    leftLength: leftInput.lines.starts.length,
    rightLength: rightInput.lines.starts.length,
    areEqual: createLineComparator({ left: leftInput, right: rightInput, options: defaultComparisonOptions() }),
    preferSpeedOverCompatibility: false,
  });
  for (const operation of operations) {
    let input;
    let start: number;
    switch (operation.kind) {
    case 'equal':
      continue;
    case 'delete':
      input = leftInput;
      start = operation.leftStart;
      break;
    case 'insert':
      input = rightInput;
      start = operation.rightStart;
      break;
    default: {
      const _ex: never = operation;
      throw new Error(`Unhandled diff operation: ${JSON.stringify(_ex)}`);
    }
    }
    for (let offset = 0; offset < operation.length; offset += 1) {
      const bytes = getLineBytes({ input, lineIndex: start + offset, stripTrailingCarriageReturn: false });
      if (testGitExtendedRegexBytes({ regex: pattern, bytes })) return true;
    }
  }
  return false;
}

function diffSearchMatchesBytes({ leftBytes, rightBytes, search }: {
  leftBytes: Uint8Array,
  rightBytes: Uint8Array,
  search: GitDiffSearch,
}): boolean {
  switch (search.type) {
  case 'string':
    return countByteSequence({ bytes: leftBytes, needle: search.bytes }) !== countByteSequence({ bytes: rightBytes, needle: search.bytes });
  case 'regex':
    return changedLinesMatch({ leftBytes, rightBytes, pattern: search.pattern });
  default: {
    const _ex: never = search;
    throw new Error(`Unhandled diff search type: ${((_ex satisfies never) as { readonly type: string }).type}`);
  }
  }
}

function renameMatchesForPickaxe({ paths, left, right, renameLimit }: {
  paths: readonly string[],
  left: GitDiffSnapshot,
  right: GitDiffSnapshot,
  renameLimit: number,
}): GitSimilarityRenameMatch[] {
  const deleted = paths.flatMap(path => {
    const entry = left.get(path);
    return entry !== undefined && !right.has(path)
      ? [{ path, objectId: entry.objectId, mode: entry.mode, bytes: entry.bytes }]
      : [];
  });
  const added = paths.flatMap(path => {
    const entry = right.get(path);
    return entry !== undefined && !left.has(path)
      ? [{ path, objectId: entry.objectId, mode: entry.mode, bytes: entry.bytes }]
      : [];
  });
  return findGitRenameMatches({ deleted, added, renameLimit });
}

function excludeExactCopyDestinationsForPickaxe({ paths, sourcePaths, left, right }: {
  paths: readonly string[],
  sourcePaths: readonly string[],
  left: GitDiffSnapshot,
  right: GitDiffSnapshot,
}): string[] {
  const sourceIdentities = new Set(sourcePaths.flatMap(path => {
    const entry = left.get(path);
    return entry === undefined
      ? []
      : [exactRenameContentIdentity({ objectId: entry.objectId, mode: entry.mode })];
  }));
  return paths.filter(path => {
    if (left.has(path)) return true;
    const entry = right.get(path);
    return entry === undefined
      || !sourceIdentities.has(exactRenameContentIdentity({ objectId: entry.objectId, mode: entry.mode }));
  });
}

export async function revisionDiffMatchesSearch({ context, repository, leftRevision, rightRevision, pathOperands, search, detectRenames, detectCopies, renameLimit }: {
  context: WeshCommandContext,
  repository: GitRepository,
  leftRevision: string | undefined,
  rightRevision: string,
  pathOperands: readonly string[],
  search: GitDiffSearch,
  detectRenames: boolean,
  detectCopies: boolean,
  renameLimit: number,
}): Promise<boolean> {
  const left = leftRevision === undefined
    ? new Map<string, GitDiffSnapshotEntry>()
    : await snapshotFromTree({ context, repository, revision: leftRevision });
  const right = await snapshotFromTree({ context, repository, revision: rightRevision });
  let paths = changedPaths({ left, right });
  if (pathOperands.length > 0) {
    const matches = matchRepositoryPaths({
      repository,
      cwd: context.cwd,
      operands: pathOperands,
      availablePaths: new Set([...left.keys(), ...right.keys()]),
    });
    const selected = new Set([...matches.values()].flat());
    paths = paths.filter(path => selected.has(path));
  }
  const copySourcePaths = paths;
  let similarityRenames: GitSimilarityRenameMatch[] = [];
  if (detectRenames) {
    similarityRenames = renameMatchesForPickaxe({ paths, left, right, renameLimit });
    if (similarityRenames.length > 0) {
      const renamePaths = new Set(similarityRenames.flatMap(rename => [rename.sourcePath, rename.destinationPath]));
      paths = paths.filter(path => !renamePaths.has(path));
    }
    if (detectCopies && pathOperands.length === 0) {
      paths = excludeExactCopyDestinationsForPickaxe({
        paths,
        sourcePaths: copySourcePaths,
        left,
        right,
      });
    }
  }
  for (const similarityRename of similarityRenames) {
    if (diffSearchMatchesBytes({
      leftBytes: left.get(similarityRename.sourcePath)!.bytes,
      rightBytes: right.get(similarityRename.destinationPath)!.bytes,
      search,
    })) return true;
  }
  for (const path of paths) {
    const leftBytes = left.get(path)?.bytes ?? new Uint8Array();
    const rightBytes = right.get(path)?.bytes ?? new Uint8Array();
    if (diffSearchMatchesBytes({ leftBytes, rightBytes, search })) return true;
  }
  return false;
}

export async function writeRevisionStat({ context, repository, leftRevision, rightRevision, pathOperands, quoteNonAscii, detectRenames }: {
  context: WeshCommandContext,
  repository: GitRepository,
  leftRevision: string | undefined,
  rightRevision: string,
  pathOperands: readonly string[],
  quoteNonAscii: boolean,
  detectRenames: boolean,
}): Promise<void> {
  const left = leftRevision === undefined
    ? new Map<string, GitDiffSnapshotEntry>()
    : await snapshotFromTree({ context, repository, revision: leftRevision });
  const right = await snapshotFromTree({ context, repository, revision: rightRevision });
  let paths = changedPaths({ left, right });
  if (pathOperands.length > 0) {
    const matches = matchRepositoryPaths({
      repository,
      cwd: context.cwd,
      operands: pathOperands,
      availablePaths: new Set([...left.keys(), ...right.keys()]),
    });
    const selected = new Set([...matches.values()].flat());
    paths = paths.filter(path => selected.has(path));
  }
  await writeDiffStat({ context, paths, left, right, quoteNonAscii, detectRenames });
}

export async function writeRevisionPatch({ context, repository, leftRevision, rightRevision, pathOperands, quoteNonAscii, detectRenames }: {
  context: WeshCommandContext,
  repository: GitRepository,
  leftRevision: string | undefined,
  rightRevision: string,
  pathOperands: readonly string[],
  quoteNonAscii: boolean,
  detectRenames: boolean,
}): Promise<void> {
  const left = leftRevision === undefined
    ? new Map<string, GitDiffSnapshotEntry>()
    : await snapshotFromTree({ context, repository, revision: leftRevision });
  const right = await snapshotFromTree({ context, repository, revision: rightRevision });
  let paths = changedPaths({ left, right });
  if (pathOperands.length > 0) {
    const matches = matchRepositoryPaths({
      repository,
      cwd: context.cwd,
      operands: pathOperands,
      availablePaths: new Set([...left.keys(), ...right.keys()]),
    });
    const selected = new Set([...matches.values()].flat());
    paths = paths.filter(path => selected.has(path));
  }
  const exactRenames = detectRenames ? exactRenamesForPaths({ paths, left, right }) : [];
  const renamePaths = new Set(exactRenames.flatMap(rename => [rename.sourcePath, rename.destinationPath]));
  const rows = [
    ...paths.filter(path => !renamePaths.has(path)).map(path => ({ kind: 'path' as const, sortPath: path, path })),
    ...exactRenames.map(rename => ({ kind: 'rename' as const, sortPath: rename.sourcePath, rename })),
  ].sort((leftRow, rightRow) => compareGitPaths({ left: leftRow.sortPath, right: rightRow.sortPath }));
  for (const row of rows) {
    switch (row.kind) {
    case 'path':
      await writePatchEntry({ context, path: row.path, left: left.get(row.path), right: right.get(row.path), quoteNonAscii });
      break;
    case 'rename':
      await writeExactRenamePatch({ context, rename: row.rename, quoteNonAscii });
      break;
    default: {
      const _ex: never = row;
      throw new Error(`Unhandled revision diff row: ${JSON.stringify(_ex)}`);
    }
    }
  }
}

export const TEST_ONLY = {
  changedPaths,
  gitlinkDiffBytes,
  isGitBinaryContent,
};
