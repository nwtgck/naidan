import { resolveCharacterLocaleMode } from '@/features/wesh/commands/_shared/locale';
import { createDiffOperations } from '@/features/wesh/commands/diff/algorithm';
import { compareDiffInputs } from '@/features/wesh/commands/diff/compare';
import { createDiffInput, createLineComparator, getLineBytes } from '@/features/wesh/commands/diff/input';
import type { DiffCompareSettings } from '@/features/wesh/commands/diff/compare';
import type { DiffComparisonOptions } from '@/features/wesh/commands/diff/model';
import { createDiffByteWriter } from '@/features/wesh/commands/diff/output';
import type { WeshCommandContext, WeshCommandResult } from '@/features/wesh/types';
import { cleanWorktreeBytes, loadWorktreeAttributes } from './attributes';
import { readEffectiveConfig, readWorktreeContentConfig } from './config';
import type { GitIndexEntry } from './index-file';
import { readIndex } from './index-file';
import { objectIdFor, readObject } from './objects';
import type { GitRepository } from './repository';
import { assertRepositoryHasUsableWorktree, repositoryHasWorktree, discoverRepositoryFromContext } from './repository';
import { resolveCommitRevision } from './revision';
import { readCommit } from './commits';
import { readTreeRecursively } from './tree';
import { pathExists } from './files';
import { matchRepositoryPaths } from './pathspec';
import { formatGitPatchPath, quoteGitPath, quoteNonAsciiFromConfig } from './path-output';
import { compareGitPaths, sortGitPaths } from './path-order';
import { readWorktreeContent, worktreeAbsolutePath } from './worktree';
import { writeTwoParentCombinedDiff } from './combined-diff';
import { findExactRenames } from './renames';
import type { GitExactRenameMatch } from './renames';

const gitlinkEncoder = new TextEncoder();

function gitlinkDiffBytes({ objectId }: { objectId: string }): Uint8Array {
  return gitlinkEncoder.encode(`Subproject commit ${objectId}\n`);
}

interface GitDiffSnapshotEntry {
  path: string,
  mode: number,
  objectId: string,
  bytes: Uint8Array,
}

type GitDiffSnapshot = Map<string, GitDiffSnapshotEntry>;

function indexRegularMode({ entry }: { entry: GitIndexEntry }): 0o100644 | 0o100755 | undefined {
  switch (entry.mode) {
  case 0o100644:
  case 0o100755:
    return entry.mode;
  case 0o120000:
  case 0o160000:
    return undefined;
  default:
    throw new Error(`unsupported index mode ${entry.mode.toString(8)}: ${entry.path}`);
  }
}

async function snapshotFromIndex({ context, repository, entries }: {
  context: WeshCommandContext,
  repository: GitRepository,
  entries: readonly GitIndexEntry[],
}): Promise<GitDiffSnapshot> {
  const result: GitDiffSnapshot = new Map();
  for (const entry of entries) {
    if (entry.stage !== 0) throw new Error(`unmerged index entry is not supported yet: ${entry.path}`);
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
      result.set(entry.path, {
        path: entry.path,
        mode: entry.mode,
        objectId: entry.objectId,
        bytes: object.body,
      });
      break;
    case 'tree':
    case 'commit':
    case 'tag':
      throw new Error(`index entry ${entry.path} does not reference a blob`);
    default: {
      const _ex: never = object.type;
      throw new Error(`Unhandled index object type: ${JSON.stringify(_ex)}`);
    }
    }
  }
  return result;
}

async function snapshotFromTree({ context, repository, revision }: {
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

async function writeUnmergedCombinedDiff({ context, repository, path, entries, quoteNonAscii }: {
  context: WeshCommandContext,
  repository: GitRepository,
  path: string,
  entries: readonly GitIndexEntry[],
  quoteNonAscii: boolean,
}): Promise<void> {
  const pathEntries = entries.filter(entry => entry.path === path);
  const firstParent = pathEntries.find(entry => entry.stage === 2);
  const secondParent = pathEntries.find(entry => entry.stage === 3);
  if (firstParent === undefined || secondParent === undefined) {
    await context.text().print({ text: `* Unmerged path ${path}\n` });
    return;
  }
  if ((firstParent.mode !== 0o100644 && firstParent.mode !== 0o100755) || secondParent.mode !== firstParent.mode) {
    throw new Error(`combined diff mode is not supported yet: ${path}`);
  }
  const firstObject = await readObject({ files: context.files, repository, objectId: firstParent.objectId });
  const secondObject = await readObject({ files: context.files, repository, objectId: secondParent.objectId });
  if (firstObject.type !== 'blob' || secondObject.type !== 'blob') {
    throw new Error(`combined diff index entry does not reference a blob: ${path}`);
  }
  const absolutePath = worktreeAbsolutePath({ repository, path });
  if (!await pathExists({ files: context.files, path: absolutePath })) {
    throw new Error(`combined diff worktree path is missing: ${path}`);
  }
  const stat = await context.files.lstat({ path: absolutePath });
  const content = await readWorktreeContent({
    files: context.files,
    absolutePath,
    type: stat.type,
    regularFileMode: firstParent.mode,
  });
  if (content.mode !== firstParent.mode) throw new Error(`combined diff mode change is not supported yet: ${path}`);
  const attributes = await loadWorktreeAttributes({ files: context.files, repository, contentConfig: await readWorktreeContentConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env }) });
  const resultBytes = attributes.clean({ path, bytes: content.bytes, indexBytes: firstObject.body });
  await writeTwoParentCombinedDiff({
    handle: context.stdout,
    path,
    firstParent: { objectId: firstParent.objectId, bytes: firstObject.body },
    secondParent: { objectId: secondParent.objectId, bytes: secondObject.body },
    resultBytes,
    quoteNonAscii,
  });
}

async function snapshotWorktreeForIndex({ context, repository, entries }: {
  context: WeshCommandContext,
  repository: GitRepository,
  entries: readonly GitIndexEntry[],
}): Promise<GitDiffSnapshot> {
  const result: GitDiffSnapshot = new Map();
  const attributes = await loadWorktreeAttributes({ files: context.files, repository, contentConfig: await readWorktreeContentConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env }) });
  for (const entry of entries) {
    if (entry.stage !== 0) throw new Error(`unmerged index entry is not supported yet: ${entry.path}`);
    if (entry.mode === 0o160000) {
      result.set(entry.path, { path: entry.path, mode: entry.mode, objectId: entry.objectId, bytes: new Uint8Array() });
      continue;
    }
    const absolutePath = worktreeAbsolutePath({ repository, path: entry.path });
    if (!await pathExists({ files: context.files, path: absolutePath })) continue;
    const stat = await context.files.lstat({ path: absolutePath });
    const content = await readWorktreeContent({
      files: context.files,
      absolutePath,
      type: stat.type,
      regularFileMode: indexRegularMode({ entry }),
    });
    const bytes = content.mode === 0o100644 || content.mode === 0o100755
      ? await cleanWorktreeBytes({ attributes, files: context.files, repository, path: entry.path, bytes: content.bytes, indexObjectId: entry.objectId })
      : content.bytes;
    const objectId = objectIdFor({ type: 'blob', body: bytes });
    result.set(entry.path, { path: entry.path, mode: content.mode, objectId, bytes });
  }
  return result;
}

function defaultComparisonOptions(): DiffComparisonOptions {
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

async function writePatchEntry({ context, path, left, right, quoteNonAscii }: {
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

function hasTrailingWhitespace({ bytes }: { bytes: Uint8Array }): boolean {
  if (bytes.byteLength === 0) return false;
  const last = bytes[bytes.byteLength - 1];
  return last === 0x20 || last === 0x09;
}

function isConflictMarkerLine({ text }: { text: string }): boolean {
  return text === '<<<<<<<' || text.startsWith('<<<<<<< ')
    || text === '|||||||' || text.startsWith('||||||| ')
    || text === '======='
    || text === '>>>>>>>' || text.startsWith('>>>>>>> ');
}

async function checkWhitespaceErrors({ context, paths, left, right }: {
  context: WeshCommandContext,
  paths: readonly string[],
  left: GitDiffSnapshot,
  right: GitDiffSnapshot,
}): Promise<boolean> {
  let found = false;
  const decoder = new TextDecoder();
  const comparisonOptions = defaultComparisonOptions();
  for (const path of paths) {
    const leftInput = createDiffInput({
      displayName: `a/${path}`,
      resolvedPath: undefined,
      mtime: undefined,
      bytes: left.get(path)?.bytes ?? new Uint8Array(),
    });
    const rightInput = createDiffInput({
      displayName: `b/${path}`,
      resolvedPath: undefined,
      mtime: undefined,
      bytes: right.get(path)?.bytes ?? new Uint8Array(),
    });
    const operations = createDiffOperations({
      leftLength: leftInput.lines.starts.length,
      rightLength: rightInput.lines.starts.length,
      areEqual: createLineComparator({ left: leftInput, right: rightInput, options: comparisonOptions }),
      preferSpeedOverCompatibility: false,
    });
    for (const operation of operations) {
      switch (operation.kind) {
      case 'equal':
      case 'delete':
        break;
      case 'insert':
        for (let offset = 0; offset < operation.length; offset += 1) {
          const lineIndex = operation.rightStart + offset;
          const bytes = getLineBytes({ input: rightInput, lineIndex, stripTrailingCarriageReturn: false });
          const text = decoder.decode(bytes);
          if (isConflictMarkerLine({ text })) {
            found = true;
            await context.text().print({ text: `${path}:${lineIndex + 1}: leftover conflict marker\n` });
          }
          if (hasTrailingWhitespace({ bytes })) {
            found = true;
            await context.text().print({
              text: `${path}:${lineIndex + 1}: trailing whitespace.\n+${text}\n`,
            });
          }
        }
        break;
      default: {
        const _ex: never = operation;
        throw new Error(`Unhandled diff operation: ${JSON.stringify(_ex)}`);
      }
      }
    }
  }
  return found;
}

function changedPaths({ left, right }: { left: GitDiffSnapshot, right: GitDiffSnapshot }): string[] {
  const paths = new Set([...left.keys(), ...right.keys()]);
  return sortGitPaths({ paths: [...paths].filter(path => {
    const a = left.get(path);
    const b = right.get(path);
    return a?.objectId !== b?.objectId || a?.mode !== b?.mode;
  }) });
}

function exactRenamesForPaths({ paths, left, right }: {
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

async function writeExactRenamePatch({ context, rename, quoteNonAscii }: {
  context: WeshCommandContext,
  rename: GitExactRenameMatch,
  quoteNonAscii: boolean,
}): Promise<void> {
  const sourceDiffPath = formatGitPatchPath({ path: rename.sourcePath, prefix: 'a', quoteNonAscii, headerLabel: false });
  const destinationDiffPath = formatGitPatchPath({ path: rename.destinationPath, prefix: 'b', quoteNonAscii, headerLabel: false });
  const sourcePath = quoteGitPath({ path: rename.sourcePath, quoteNonAscii, quoteSpaces: false });
  const destinationPath = quoteGitPath({ path: rename.destinationPath, quoteNonAscii, quoteSpaces: false });
  await context.text().print({
    text: `diff --git ${sourceDiffPath} ${destinationDiffPath}\nsimilarity index 100%\nrename from ${sourcePath}\nrename to ${destinationPath}\n`,
  });
}

interface GitDiffStatEntry {
  path: string,
  sortPath: string,
  additions: number,
  deletions: number,
  binarySize: { left: number, right: number } | undefined,
}

function containsNul({ bytes }: { bytes: Uint8Array }): boolean {
  return bytes.includes(0);
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
    if (leftEntry?.objectId !== rightEntry?.objectId && (containsNul({ bytes: leftBytes }) || containsNul({ bytes: rightBytes }))) {
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

async function writeDiffStat({ context, paths, left, right, quoteNonAscii, unmergedPaths = [] }: {
  context: WeshCommandContext,
  paths: readonly string[],
  left: GitDiffSnapshot,
  right: GitDiffSnapshot,
  quoteNonAscii: boolean,
  unmergedPaths?: readonly string[],
}): Promise<void> {
  if (paths.length === 0 && unmergedPaths.length === 0) return;
  const exactRenames = exactRenamesForPaths({ paths, left, right });
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
  | { type: 'regex', pattern: RegExp };

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
  pattern: RegExp,
}): boolean {
  const leftInput = createDiffInput({ displayName: 'left', resolvedPath: undefined, mtime: undefined, bytes: leftBytes });
  const rightInput = createDiffInput({ displayName: 'right', resolvedPath: undefined, mtime: undefined, bytes: rightBytes });
  const operations = createDiffOperations({
    leftLength: leftInput.lines.starts.length,
    rightLength: rightInput.lines.starts.length,
    areEqual: createLineComparator({ left: leftInput, right: rightInput, options: defaultComparisonOptions() }),
    preferSpeedOverCompatibility: false,
  });
  const decoder = new TextDecoder();
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
      const text = decoder.decode(getLineBytes({ input, lineIndex: start + offset, stripTrailingCarriageReturn: false }));
      pattern.lastIndex = 0;
      if (pattern.test(text)) return true;
    }
  }
  return false;
}

export async function revisionDiffMatchesSearch({ context, repository, leftRevision, rightRevision, pathOperands, search }: {
  context: WeshCommandContext,
  repository: GitRepository,
  leftRevision: string | undefined,
  rightRevision: string,
  pathOperands: readonly string[],
  search: GitDiffSearch,
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
  for (const path of paths) {
    const leftBytes = left.get(path)?.bytes ?? new Uint8Array();
    const rightBytes = right.get(path)?.bytes ?? new Uint8Array();
    switch (search.type) {
    case 'string':
      if (countByteSequence({ bytes: leftBytes, needle: search.bytes }) !== countByteSequence({ bytes: rightBytes, needle: search.bytes })) return true;
      break;
    case 'regex':
      if (changedLinesMatch({ leftBytes, rightBytes, pattern: search.pattern })) return true;
      break;
    default: {
      const _ex: never = search;
      throw new Error(`Unhandled diff search type: ${((_ex satisfies never) as { readonly type: string }).type}`);
    }
    }
  }
  return false;
}

export async function writeRevisionStat({ context, repository, leftRevision, rightRevision, pathOperands, quoteNonAscii }: {
  context: WeshCommandContext,
  repository: GitRepository,
  leftRevision: string | undefined,
  rightRevision: string,
  pathOperands: readonly string[],
  quoteNonAscii: boolean,
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
  await writeDiffStat({ context, paths, left, right, quoteNonAscii });
}

export async function writeRevisionPatch({ context, repository, leftRevision, rightRevision, pathOperands, quoteNonAscii }: {
  context: WeshCommandContext,
  repository: GitRepository,
  leftRevision: string | undefined,
  rightRevision: string,
  pathOperands: readonly string[],
  quoteNonAscii: boolean,
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
  const exactRenames = exactRenamesForPaths({ paths, left, right });
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

export async function runDiff({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  let cached = false;
  let nameOnly = false;
  let nameStatus = false;
  let stat = false;
  let check = false;
  let quiet = false;
  let exitCode = false;
  let nul = false;
  const revisions: string[] = [];
  const pathOperands: string[] = [];
  let parsingPaths = false;
  for (const arg of args) {
    if (parsingPaths) {
      pathOperands.push(arg);
      continue;
    }
    switch (arg) {
    case '--':
      parsingPaths = true;
      break;
    case '--cached':
    case '--staged':
      cached = true;
      break;
    case '--name-only':
      nameOnly = true;
      break;
    case '--name-status':
      nameStatus = true;
      break;
    case '--stat':
      stat = true;
      break;
    case '--check':
      check = true;
      break;
    case '--quiet':
      quiet = true;
      exitCode = true;
      break;
    case '--exit-code':
      exitCode = true;
      break;
    case '-z':
      nul = true;
      break;
    case '--cc':
    case '--no-color':
    case '--no-ext-diff':
      break;
    default:
      if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
      revisions.push(arg);
      break;
    }
  }
  if (cached && revisions.length > 1) throw new Error('too many revisions for --cached');
  if (!cached && revisions.length > 2) throw new Error('too many revisions');

  const repository = await discoverRepositoryFromContext({ context });
  if (!repositoryHasWorktree({ repository }) && !cached && revisions.length < 2) {
    assertRepositoryHasUsableWorktree({ context, repository });
  }
  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
  const quoteNonAscii = quoteNonAsciiFromConfig({ config });
  const indexEntries = await readIndex({ files: context.files, repository });
  const stageZeroEntries = indexEntries.filter(entry => entry.stage === 0);
  const unmergedIndexPaths = sortGitPaths({ paths: new Set(indexEntries.filter(entry => entry.stage !== 0).map(entry => entry.path)) });
  const defaultUnmergedSummary = !cached && revisions.length === 0 && unmergedIndexPaths.length > 0
    && (nameOnly || nameStatus || quiet || stat || check);
  const combinedUnmergedPatch = !cached && revisions.length === 0 && unmergedIndexPaths.length > 0
    && !nameOnly && !nameStatus && !quiet && !stat && !check;
  if (!cached && revisions.length < 2 && unmergedIndexPaths.length > 0
    && !defaultUnmergedSummary && !combinedUnmergedPatch) {
    throw new Error('combined diff for this unmerged comparison is not supported yet');
  }
  let left: GitDiffSnapshot;
  let right: GitDiffSnapshot;
  if (cached) {
    left = await snapshotFromTree({ context, repository, revision: revisions[0] ?? 'HEAD' });
    right = await snapshotFromIndex({ context, repository, entries: stageZeroEntries });
  } else if (revisions.length === 0) {
    const worktreeComparisonEntries = defaultUnmergedSummary
      ? [
        ...stageZeroEntries,
        ...indexEntries.filter(entry => entry.stage === 2).map(entry => ({ ...entry, stage: 0 as const })),
      ]
      : combinedUnmergedPatch
        ? stageZeroEntries
        : indexEntries;
    left = await snapshotFromIndex({ context, repository, entries: worktreeComparisonEntries });
    right = await snapshotWorktreeForIndex({ context, repository, entries: worktreeComparisonEntries });
  } else if (revisions.length === 1) {
    left = await snapshotFromTree({ context, repository, revision: revisions[0]! });
    right = await snapshotWorktreeForIndex({ context, repository, entries: indexEntries });
    for (const [path, entry] of await snapshotFromIndex({ context, repository, entries: indexEntries })) {
      if (!right.has(path) && !left.has(path)) right.set(path, entry);
    }
  } else {
    left = await snapshotFromTree({ context, repository, revision: revisions[0]! });
    right = await snapshotFromTree({ context, repository, revision: revisions[1]! });
  }

  let unmergedPaths = cached || defaultUnmergedSummary || combinedUnmergedPatch ? unmergedIndexPaths : [];
  let paths = changedPaths({ left, right });
  if (cached) paths = paths.filter(path => !unmergedPaths.includes(path));
  if (pathOperands.length > 0) {
    const matches = matchRepositoryPaths({
      repository,
      cwd: context.cwd,
      operands: pathOperands,
      availablePaths: new Set([...left.keys(), ...right.keys(), ...unmergedPaths]),
    });
    const selected = new Set([...matches.values()].flat());
    paths = paths.filter(path => selected.has(path));
    unmergedPaths = unmergedPaths.filter(path => selected.has(path));
  }
  const exactRenames = exactRenamesForPaths({ paths, left, right });
  const exactRenameSources = new Set(exactRenames.map(rename => rename.sourcePath));
  const exactRenameDestinations = new Set(exactRenames.map(rename => rename.destinationPath));
  if (check) {
    const hasErrors = await checkWhitespaceErrors({ context, paths, left, right });
    return { exitCode: hasErrors ? 2 : 0 };
  }
  if (quiet) return { exitCode: paths.length === 0 && unmergedPaths.length === 0 ? 0 : 1 };
  if (stat) {
    if (nameOnly || nameStatus) throw new Error('combined diff stat/name output is not supported yet');
    await writeDiffStat({ context, paths, left, right, quoteNonAscii, unmergedPaths });
    return { exitCode: 0 };
  }
  if (nameOnly) {
    const separator = nul ? '\0' : '\n';
    const renderPath = ({ path }: { path: string }): string => (
      nul ? path : quoteGitPath({ path, quoteNonAscii, quoteSpaces: false })
    );
    if (defaultUnmergedSummary) {
      const rows = [
        ...unmergedPaths.map(path => ({ path, order: 0 })),
        ...paths.map(path => ({ path, order: 1 })),
      ].sort((leftRow, rightRow) => compareGitPaths({ left: leftRow.path, right: rightRow.path }) || leftRow.order - rightRow.order);
      await context.text().print({ text: rows.map(row => `${renderPath({ path: row.path })}${separator}`).join('') });
    } else {
      const outputPaths = sortGitPaths({
        paths: new Set([
          ...paths.filter(path => !exactRenameSources.has(path) && !exactRenameDestinations.has(path)),
          ...exactRenames.map(rename => rename.destinationPath),
          ...unmergedPaths,
        ]),
      });
      await context.text().print({ text: outputPaths.map(path => `${renderPath({ path })}${separator}`).join('') });
    }
    return { exitCode: 0 };
  }
  if (nameStatus) {
    const normal = new Map(paths.map(path => {
      const a = left.get(path);
      const b = right.get(path);
      const status = a === undefined ? 'A' : b === undefined ? 'D' : 'M';
      return [path, status] as const;
    }));
    const renderRow = ({ status, path }: { status: string, path: string }): string => {
      if (nul) return `${status}\0${path}\0`;
      return `${status}\t${quoteGitPath({ path, quoteNonAscii, quoteSpaces: false })}\n`;
    };
    const renderRenameRow = ({ rename }: { rename: GitExactRenameMatch }): string => {
      if (nul) return `R100\0${rename.sourcePath}\0${rename.destinationPath}\0`;
      const source = quoteGitPath({ path: rename.sourcePath, quoteNonAscii, quoteSpaces: false });
      const destination = quoteGitPath({ path: rename.destinationPath, quoteNonAscii, quoteSpaces: false });
      return `R100\t${source}\t${destination}\n`;
    };
    if (defaultUnmergedSummary) {
      const rows = [
        ...unmergedPaths.map(path => ({ path, status: 'U', order: 0 })),
        ...paths.map(path => ({ path, status: normal.get(path)!, order: 1 })),
      ].sort((leftRow, rightRow) => compareGitPaths({ left: leftRow.path, right: rightRow.path }) || leftRow.order - rightRow.order);
      await context.text().print({ text: rows.map(row => renderRow({ status: row.status, path: row.path })).join('') });
    } else {
      const unmerged = new Set(unmergedPaths);
      const rows = [
        ...paths
          .filter(path => !exactRenameSources.has(path) && !exactRenameDestinations.has(path))
          .map(path => ({ kind: 'normal' as const, sortPath: path, path })),
        ...unmergedPaths.map(path => ({ kind: 'normal' as const, sortPath: path, path })),
        ...exactRenames.map(rename => ({ kind: 'rename' as const, sortPath: rename.sourcePath, rename })),
      ].sort((leftRow, rightRow) => compareGitPaths({ left: leftRow.sortPath, right: rightRow.sortPath }));
      await context.text().print({
        text: rows.map(row => {
          switch (row.kind) {
          case 'normal':
            return renderRow({ status: unmerged.has(row.path) ? 'U' : normal.get(row.path)!, path: row.path });
          case 'rename':
            return renderRenameRow({ rename: row.rename });
          default: {
            const _ex: never = row;
            throw new Error(`Unhandled diff name-status row: ${JSON.stringify(_ex)}`);
          }
          }
        }).join(''),
      });
    }
    return { exitCode: 0 };
  }
  const outputRows = [
    ...paths
      .filter(path => !exactRenameSources.has(path) && !exactRenameDestinations.has(path))
      .map(path => ({ kind: 'path' as const, sortPath: path, path })),
    ...unmergedPaths.map(path => ({ kind: 'path' as const, sortPath: path, path })),
    ...exactRenames.map(rename => ({ kind: 'rename' as const, sortPath: rename.sourcePath, rename })),
  ].sort((leftRow, rightRow) => compareGitPaths({ left: leftRow.sortPath, right: rightRow.sortPath }));
  for (const row of outputRows) {
    switch (row.kind) {
    case 'path':
      if (unmergedPaths.includes(row.path)) {
        if (combinedUnmergedPatch) await writeUnmergedCombinedDiff({ context, repository, path: row.path, entries: indexEntries, quoteNonAscii });
        else await context.text().print({ text: `* Unmerged path ${row.path}\n` });
      } else {
        await writePatchEntry({ context, path: row.path, left: left.get(row.path), right: right.get(row.path), quoteNonAscii });
      }
      break;
    case 'rename':
      await writeExactRenamePatch({ context, rename: row.rename, quoteNonAscii });
      break;
    default: {
      const _ex: never = row;
      throw new Error(`Unhandled diff output row: ${JSON.stringify(_ex)}`);
    }
    }
  }
  return { exitCode: exitCode && outputRows.length > 0 ? 1 : 0 };
}

export const TEST_ONLY = {
  changedPaths,
  gitlinkDiffBytes,
};
