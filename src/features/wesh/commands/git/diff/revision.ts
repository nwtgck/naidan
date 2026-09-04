import { testGitExtendedRegexBytes } from '@/features/wesh/commands/git/extended-regex';
import type { GitExtendedRegex } from '@/features/wesh/commands/git/extended-regex';
import { resolveCharacterLocaleMode } from "@/features/wesh/commands/_shared/locale";
import { createChangeGroups, createDiffOperations, createHunks } from "@/features/wesh/commands/git/diff/algorithm";
import { compareDiffInputs } from "@/features/wesh/commands/git/diff/compare";
import { encodeGitBinaryLiteral } from "@/features/wesh/commands/git/diff/binary-patch";
import { createDiffInput, createLineComparator, getLineBytes, isBinaryInput } from "@/features/wesh/commands/git/diff/input";
import type { DiffCompareSettings } from "@/features/wesh/commands/git/diff/compare";
import type { DiffComparisonOptions } from "@/features/wesh/commands/git/diff/model";
import { createDiffByteWriter } from "@/features/wesh/commands/git/diff/output";
import type { WeshCommandContext } from "@/features/wesh/types";
import { readObject } from "@/features/wesh/commands/git/objects";
import type { GitRepository } from "@/features/wesh/commands/git/repository";
import { resolveCommitRevision } from "@/features/wesh/commands/git/revision";
import { readCommit } from "@/features/wesh/commands/git/commits";
import { readTreeRecursively } from "@/features/wesh/commands/git/tree";
import { matchRepositoryPathSelection } from "@/features/wesh/commands/git/pathspec";
import { formatGitPatchPath, quoteGitPath } from "@/features/wesh/commands/git/path-output";
import { sortGitPaths } from "@/features/wesh/commands/git/path-order";
import { sortByGitUtf8StringKey } from "@/features/wesh/commands/git/utf8-order";
import { exactRenameContentIdentity, findExactRenames, findGitRenameMatches } from "@/features/wesh/commands/git/renames";
import type { GitExactRenameCandidate, GitExactRenameMatch, GitSimilarityRenameMatch } from "@/features/wesh/commands/git/renames";

const gitlinkEncoder = new TextEncoder();

export function gitlinkDiffBytes({ objectId }: { objectId: string }): Uint8Array {
  return gitlinkEncoder.encode(`Subproject commit ${objectId}\n`);
}

export type GitDiffSnapshotEntry = {
  path: string,
  mode: number,
  objectId: string,
  content:
    | { kind: 'loaded', bytes: Uint8Array }
    | { kind: 'object', source: 'tree' | 'index' },
};

export type GitDiffSnapshot = Map<string, GitDiffSnapshotEntry>;

export function loadedDiffSnapshotEntry({ path, mode, objectId, bytes }: {
  path: string,
  mode: number,
  objectId: string,
  bytes: Uint8Array,
}): GitDiffSnapshotEntry {
  return { path, mode, objectId, content: { kind: 'loaded', bytes } };
}

export function objectDiffSnapshotEntry({ path, mode, objectId, source }: {
  path: string,
  mode: number,
  objectId: string,
  source: 'tree' | 'index',
}): GitDiffSnapshotEntry {
  return { path, mode, objectId, content: { kind: 'object', source } };
}

export async function readDiffSnapshotEntryBytes({ context, repository, entry }: {
  context: WeshCommandContext,
  repository: GitRepository,
  entry: GitDiffSnapshotEntry | undefined,
}): Promise<Uint8Array> {
  if (entry === undefined) return new Uint8Array();
  switch (entry.content.kind) {
  case 'loaded':
    return entry.content.bytes;
  case 'object': {
    const source = entry.content.source;
    const object = await readObject({ files: context.files, repository, objectId: entry.objectId });
    switch (object.type) {
    case 'blob':
      entry.content = { kind: 'loaded', bytes: object.body };
      return object.body;
    case 'tree':
    case 'commit':
    case 'tag':
      throw new Error(`${source} entry ${entry.path} does not reference a blob`);
    default: {
      const _ex: never = object.type;
      throw new Error(`Unhandled ${source} object type: ${JSON.stringify(_ex)}`);
    }
    }
  }
  default: {
    const _ex: never = entry.content;
    throw new Error(`Unhandled diff snapshot content: ${JSON.stringify(_ex)}`);
  }
  }
}

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
    result.set(entry.path, entry.mode === 0o160000
      ? loadedDiffSnapshotEntry({
        path: entry.path,
        mode: entry.mode,
        objectId: entry.objectId,
        bytes: gitlinkDiffBytes({ objectId: entry.objectId }),
      })
      : objectDiffSnapshotEntry({
        path: entry.path,
        mode: entry.mode,
        objectId: entry.objectId,
        source: 'tree',
      }));
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

function defaultCompareSettings({ labels, characterLocaleMode, contextLines = 3 }: {
  labels: readonly string[],
  characterLocaleMode: 'ascii' | 'unicode',
  contextLines?: number,
}): DiffCompareSettings {
  return {
    comparisonOptions: defaultComparisonOptions(),
    outputOptions: {
      mode: { kind: 'unified', contextLines },
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

const wordDiffDecoder = new TextDecoder();

interface WordDiffToken {
  readonly text: string,
  readonly whitespace: boolean,
}

function wordDiffTokens({ text }: { text: string }): WordDiffToken[] {
  const parts = text.match(/\s+|[^\s]+/gu) ?? [];
  return parts.map(part => ({ text: part, whitespace: /^\s+$/u.test(part) }));
}

function renderWordDiffLine({ leftText, rightText }: { leftText: string, rightText: string }): string {
  const leftTokens = wordDiffTokens({ text: leftText });
  const rightTokens = wordDiffTokens({ text: rightText });
  const operations = createDiffOperations({
    leftLength: leftTokens.length,
    rightLength: rightTokens.length,
    areEqual: ({ leftIndex, rightIndex }) => {
      const leftToken = leftTokens[leftIndex]!;
      const rightToken = rightTokens[rightIndex]!;
      return leftToken.text === rightToken.text || (leftToken.whitespace && rightToken.whitespace);
    },
    preferSpeedOverCompatibility: false,
  });
  let output = '';
  for (const operation of operations) {
    switch (operation.kind) {
    case 'equal':
      for (let offset = 0; offset < operation.length; offset += 1)
        output += rightTokens[operation.rightStart + offset]!.text;
      break;
    case 'delete': {
      let deleted = '';
      for (let offset = 0; offset < operation.length; offset += 1)
        deleted += leftTokens[operation.leftStart + offset]!.text;
      output += `[-${deleted}-]`;
      break;
    }
    case 'insert': {
      let inserted = '';
      for (let offset = 0; offset < operation.length; offset += 1)
        inserted += rightTokens[operation.rightStart + offset]!.text;
      output += `{+${inserted}+}`;
      break;
    }
    default: {
      const _ex: never = operation;
      throw new Error(`Unhandled word diff operation: ${JSON.stringify(_ex)}`);
    }
    }
  }
  return output;
}

function formatUnifiedRange({ start, count }: { start: number, count: number }): string {
  if (count === 0) return `${start},0`;
  const first = start + 1;
  return count === 1 ? `${first}` : `${first},${count}`;
}

function lineText({ input, lineIndex }: { input: ReturnType<typeof createDiffInput>, lineIndex: number }): string {
  return wordDiffDecoder.decode(getLineBytes({ input, lineIndex, stripTrailingCarriageReturn: false }));
}

function lineInsideRange({ lineIndex, start, count }: { lineIndex: number, start: number, count: number }): boolean {
  return lineIndex >= start && lineIndex < start + count;
}

async function writeWordDiff({ writer, leftInput, rightInput, contextLines }: {
  writer: ReturnType<typeof createDiffByteWriter>,
  leftInput: ReturnType<typeof createDiffInput>,
  rightInput: ReturnType<typeof createDiffInput>,
  contextLines: number,
}): Promise<void> {
  const comparisonOptions = defaultComparisonOptions();
  const operations = createDiffOperations({
    leftLength: leftInput.lines.starts.length,
    rightLength: rightInput.lines.starts.length,
    areEqual: createLineComparator({ left: leftInput, right: rightInput, options: comparisonOptions }),
    preferSpeedOverCompatibility: false,
  });
  const changeGroups = createChangeGroups({ operations });
  const hunks = createHunks({
    operations,
    changeGroups,
    contextLines,
    leftLength: leftInput.lines.starts.length,
    rightLength: rightInput.lines.starts.length,
  });
  for (const hunk of hunks) {
    await writer.writeText({ text: `@@ -${formatUnifiedRange({ start: hunk.leftStart, count: hunk.leftCount })} +${formatUnifiedRange({ start: hunk.rightStart, count: hunk.rightCount })} @@\n` });
    let operationIndex = hunk.operationStart;
    while (operationIndex < hunk.operationEnd) {
      const operation = operations[operationIndex];
      if (operation === undefined) break;
      switch (operation.kind) {
      case 'equal':
        for (let offset = 0; offset < operation.length; offset += 1) {
          const leftLine = operation.leftStart + offset;
          const rightLine = operation.rightStart + offset;
          if (!lineInsideRange({ lineIndex: leftLine, start: hunk.leftStart, count: hunk.leftCount })
            || !lineInsideRange({ lineIndex: rightLine, start: hunk.rightStart, count: hunk.rightCount })) continue;
          await writer.writeText({ text: lineText({ input: rightInput, lineIndex: rightLine }) });
          if (rightInput.lines.hasLineFeed[rightLine] === 1) await writer.writeText({ text: '\n' });
        }
        operationIndex += 1;
        continue;
      case 'delete':
      case 'insert':
        break;
      default: {
        const _ex: never = operation;
        throw new Error(`Unhandled word diff line operation: ${JSON.stringify(_ex)}`);
      }
      }
      const deletedLines: number[] = [];
      const insertedLines: number[] = [];
      changeBlock: while (operationIndex < hunk.operationEnd) {
        const current = operations[operationIndex];
        if (current === undefined) break;
        switch (current.kind) {
        case 'equal':
          break changeBlock;
        case 'delete':
          for (let offset = 0; offset < current.length; offset += 1) {
            const lineIndex = current.leftStart + offset;
            if (lineInsideRange({ lineIndex, start: hunk.leftStart, count: hunk.leftCount })) deletedLines.push(lineIndex);
          }
          break;
        case 'insert':
          for (let offset = 0; offset < current.length; offset += 1) {
            const lineIndex = current.rightStart + offset;
            if (lineInsideRange({ lineIndex, start: hunk.rightStart, count: hunk.rightCount })) insertedLines.push(lineIndex);
          }
          break;
        default: {
          const _ex: never = current;
          throw new Error(`Unhandled word diff change operation: ${JSON.stringify(_ex)}`);
        }
        }
        operationIndex += 1;
      }
      const lineCount = Math.max(deletedLines.length, insertedLines.length);
      for (let pairIndex = 0; pairIndex < lineCount; pairIndex += 1) {
        const leftLineIndex = deletedLines[pairIndex];
        const rightLineIndex = insertedLines[pairIndex];
        let text: string;
        if (leftLineIndex !== undefined && rightLineIndex !== undefined) {
          text = renderWordDiffLine({
            leftText: lineText({ input: leftInput, lineIndex: leftLineIndex }),
            rightText: lineText({ input: rightInput, lineIndex: rightLineIndex }),
          });
        } else if (leftLineIndex !== undefined) {
          text = `[-${lineText({ input: leftInput, lineIndex: leftLineIndex })}-]`;
        } else if (rightLineIndex !== undefined) {
          text = `{+${lineText({ input: rightInput, lineIndex: rightLineIndex })}+}`;
        } else {
          continue;
        }
        await writer.writeText({ text });
        const hasLineFeed = rightLineIndex !== undefined
          ? rightInput.lines.hasLineFeed[rightLineIndex] === 1
          : leftInput.lines.hasLineFeed[leftLineIndex!] === 1;
        if (hasLineFeed) await writer.writeText({ text: '\n' });
      }
    }
  }
}

export async function writePatchEntry({ context, repository, path, left, right, quoteNonAscii, contextLines = 3, wordDiff = false, binaryPatch = false }: {
  context: WeshCommandContext,
  repository: GitRepository,
  path: string,
  left: GitDiffSnapshotEntry | undefined,
  right: GitDiffSnapshotEntry | undefined,
  quoteNonAscii: boolean,
  contextLines?: number,
  wordDiff?: boolean,
  binaryPatch?: boolean,
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
    const leftBytes = await readDiffSnapshotEntryBytes({ context, repository, entry: left });
    const rightBytes = await readDiffSnapshotEntryBytes({ context, repository, entry: right });
    const leftInput = createDiffInput({ displayName: leftDiffPath, resolvedPath: undefined, mtime: undefined, bytes: leftBytes });
    const rightInput = createDiffInput({ displayName: rightDiffPath, resolvedPath: undefined, mtime: undefined, bytes: rightBytes });
    const binary = isBinaryInput({ input: leftInput }) || isBinaryInput({ input: rightInput });
    const objectIdWidth = binary && binaryPatch ? 40 : 7;
    const leftObjectId = left === undefined ? '0'.repeat(objectIdWidth) : left.objectId.slice(0, objectIdWidth);
    const rightObjectId = right === undefined ? '0'.repeat(objectIdWidth) : right.objectId.slice(0, objectIdWidth);
    await writer.writeText({
      text: `index ${leftObjectId}..${rightObjectId}${left !== undefined && right !== undefined && left.mode === right.mode ? ` ${formatMode({ mode: left.mode })}` : ''}\n`,
    });
    if (binary && binaryPatch) {
      await writer.writeText({ text: 'GIT binary patch\n' });
      await writer.writeText({ text: `${await encodeGitBinaryLiteral({ bytes: rightBytes })}\n` });
      await writer.writeText({ text: `${await encodeGitBinaryLiteral({ bytes: leftBytes })}\n` });
    } else if (wordDiff && !binary) {
      await writer.writeText({ text: `--- ${left === undefined ? '/dev/null' : leftHeaderPath}\n` });
      await writer.writeText({ text: `+++ ${right === undefined ? '/dev/null' : rightHeaderPath}\n` });
      await writeWordDiff({ writer, leftInput, rightInput, contextLines });
    } else {
      await compareDiffInputs({
        writer,
        left: leftInput,
        right: rightInput,
        settings: defaultCompareSettings({
          labels: [left === undefined ? '/dev/null' : leftHeaderPath, right === undefined ? '/dev/null' : rightHeaderPath],
          characterLocaleMode: resolveCharacterLocaleMode({ env: context.env }),
          contextLines,
        }),
      });
    }
  }
  await writer.flush();
}

export function changedPaths({ left, right }: { left: GitDiffSnapshot, right: GitDiffSnapshot }): string[] {
  const changed: string[] = [];
  for (const path of snapshotPathUnion({ left, right })) {
    const a = left.get(path);
    const b = right.get(path);
    if (a?.objectId !== b?.objectId || a?.mode !== b?.mode) changed.push(path);
  }
  return sortGitPaths({ paths: changed });
}

export function exactRenamesForPaths({ paths, left, right }: {
  paths: readonly string[],
  left: GitDiffSnapshot,
  right: GitDiffSnapshot,
}): GitExactRenameMatch[] {
  const deleted: GitExactRenameCandidate[] = [];
  const added: GitExactRenameCandidate[] = [];
  for (const path of paths) {
    const leftEntry = left.get(path);
    if (leftEntry !== undefined && !right.has(path)) {
      deleted.push({ path, objectId: leftEntry.objectId, mode: leftEntry.mode });
    }
    const rightEntry = right.get(path);
    if (rightEntry !== undefined && !left.has(path)) {
      added.push({ path, objectId: rightEntry.objectId, mode: rightEntry.mode });
    }
  }
  return findExactRenames({ deleted, added });
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

async function createDiffStatEntries({ context, repository, paths, left, right }: {
  context: WeshCommandContext,
  repository: GitRepository,
  paths: readonly string[],
  left: GitDiffSnapshot,
  right: GitDiffSnapshot,
}): Promise<GitDiffStatEntry[]> {
  const result: GitDiffStatEntry[] = [];
  for (const path of paths) {
    const leftEntry = left.get(path);
    const rightEntry = right.get(path);
    if (leftEntry?.objectId === rightEntry?.objectId) {
      result.push({ path, sortPath: path, additions: 0, deletions: 0, binarySize: undefined });
      continue;
    }
    const leftBytes = await readDiffSnapshotEntryBytes({ context, repository, entry: leftEntry });
    const rightBytes = await readDiffSnapshotEntryBytes({ context, repository, entry: rightEntry });
    if (isGitBinaryContent({ bytes: leftBytes }) || isGitBinaryContent({ bytes: rightBytes })) {
      result.push({
        path,
        sortPath: path,
        additions: 0,
        deletions: 0,
        binarySize: { left: leftBytes.byteLength, right: rightBytes.byteLength },
      });
      continue;
    }
    const counts = diffLineCounts({ leftBytes, rightBytes });
    result.push({ path, sortPath: path, ...counts, binarySize: undefined });
  }
  return result;
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

export async function writeDiffStat({ context, repository, paths, left, right, quoteNonAscii, detectRenames, unmergedPaths = [] }: {
  context: WeshCommandContext,
  repository: GitRepository,
  paths: readonly string[],
  left: GitDiffSnapshot,
  right: GitDiffSnapshot,
  quoteNonAscii: boolean,
  detectRenames: boolean,
  unmergedPaths?: readonly string[],
}): Promise<void> {
  if (paths.length === 0 && unmergedPaths.length === 0) return;
  const exactRenames = detectRenames ? exactRenamesForPaths({ paths, left, right }) : [];
  const renamePaths = new Set<string>();
  for (const rename of exactRenames) {
    renamePaths.add(rename.sourcePath);
    renamePaths.add(rename.destinationPath);
  }
  const entries = [
    ...await createDiffStatEntries({ context, repository, paths: paths.filter(path => !renamePaths.has(path)), left, right }),
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
  const rows = sortByGitUtf8StringKey({
    values: [
      ...unmergedPaths.map(path => ({ kind: 'unmerged' as const, sortPath: path, path })),
      ...entries.map(entry => ({ kind: 'entry' as const, sortPath: entry.sortPath, entry })),
    ],
    key: ({ value }) => value.sortPath,
  });
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

async function renameMatchesForPickaxe({ context, repository, paths, left, right, renameLimit }: {
  context: WeshCommandContext,
  repository: GitRepository,
  paths: readonly string[],
  left: GitDiffSnapshot,
  right: GitDiffSnapshot,
  renameLimit: number,
}): Promise<GitSimilarityRenameMatch[]> {
  const deleted = [];
  const added = [];
  for (const path of paths) {
    const leftEntry = left.get(path);
    if (leftEntry !== undefined && !right.has(path)) {
      deleted.push({
        path,
        objectId: leftEntry.objectId,
        mode: leftEntry.mode,
        bytes: await readDiffSnapshotEntryBytes({ context, repository, entry: leftEntry }),
      });
    }
    const rightEntry = right.get(path);
    if (rightEntry !== undefined && !left.has(path)) {
      added.push({
        path,
        objectId: rightEntry.objectId,
        mode: rightEntry.mode,
        bytes: await readDiffSnapshotEntryBytes({ context, repository, entry: rightEntry }),
      });
    }
  }
  return findGitRenameMatches({ deleted, added, renameLimit });
}

function snapshotPathUnion({ left, right }: {
  left: GitDiffSnapshot,
  right: GitDiffSnapshot,
}): Set<string> {
  const paths = new Set(left.keys());
  for (const path of right.keys()) paths.add(path);
  return paths;
}

function renamePathSet({ renames }: {
  renames: readonly GitSimilarityRenameMatch[],
}): Set<string> {
  const paths = new Set<string>();
  for (const rename of renames) {
    paths.add(rename.sourcePath);
    paths.add(rename.destinationPath);
  }
  return paths;
}

function excludeExactCopyDestinationsForPickaxe({ paths, sourcePaths, left, right }: {
  paths: readonly string[],
  sourcePaths: readonly string[],
  left: GitDiffSnapshot,
  right: GitDiffSnapshot,
}): string[] {
  const sourceIdentities = new Set<string>();
  for (const path of sourcePaths) {
    const entry = left.get(path);
    if (entry !== undefined) sourceIdentities.add(exactRenameContentIdentity({ objectId: entry.objectId, mode: entry.mode }));
  }
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
    const selected = matchRepositoryPathSelection({
      repository,
      cwd: context.cwd,
      operands: pathOperands,
      availablePaths: snapshotPathUnion({ left, right }),
    }).selected;
    paths = paths.filter(path => selected.has(path));
  }
  const copySourcePaths = paths;
  let similarityRenames: GitSimilarityRenameMatch[] = [];
  if (detectRenames) {
    similarityRenames = await renameMatchesForPickaxe({ context, repository, paths, left, right, renameLimit });
    if (similarityRenames.length > 0) {
      const renamePaths = renamePathSet({ renames: similarityRenames });
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
      leftBytes: await readDiffSnapshotEntryBytes({ context, repository, entry: left.get(similarityRename.sourcePath) }),
      rightBytes: await readDiffSnapshotEntryBytes({ context, repository, entry: right.get(similarityRename.destinationPath) }),
      search,
    })) return true;
  }
  for (const path of paths) {
    const leftBytes = await readDiffSnapshotEntryBytes({ context, repository, entry: left.get(path) });
    const rightBytes = await readDiffSnapshotEntryBytes({ context, repository, entry: right.get(path) });
    if (diffSearchMatchesBytes({ leftBytes, rightBytes, search })) return true;
  }
  return false;
}

async function revisionDiffNameSelection({ context, repository, leftRevision, rightRevision, pathOperands, detectRenames }: {
  context: WeshCommandContext,
  repository: GitRepository,
  leftRevision: string | undefined,
  rightRevision: string,
  pathOperands: readonly string[],
  detectRenames: boolean,
}): Promise<{
  left: GitDiffSnapshot,
  right: GitDiffSnapshot,
  paths: string[],
  exactRenames: GitExactRenameMatch[],
}> {
  const left = leftRevision === undefined
    ? new Map<string, GitDiffSnapshotEntry>()
    : await snapshotFromTree({ context, repository, revision: leftRevision });
  const right = await snapshotFromTree({ context, repository, revision: rightRevision });
  let paths = changedPaths({ left, right });
  if (pathOperands.length > 0) {
    const selected = matchRepositoryPathSelection({
      repository,
      cwd: context.cwd,
      operands: pathOperands,
      availablePaths: snapshotPathUnion({ left, right }),
    }).selected;
    paths = paths.filter(path => selected.has(path));
  }
  return {
    left,
    right,
    paths,
    exactRenames: detectRenames ? exactRenamesForPaths({ paths, left, right }) : [],
  };
}

export async function writeRevisionNameOnly({ context, repository, leftRevision, rightRevision, pathOperands, quoteNonAscii, detectRenames }: {
  context: WeshCommandContext,
  repository: GitRepository,
  leftRevision: string | undefined,
  rightRevision: string,
  pathOperands: readonly string[],
  quoteNonAscii: boolean,
  detectRenames: boolean,
}): Promise<void> {
  const { paths, exactRenames } = await revisionDiffNameSelection({
    context,
    repository,
    leftRevision,
    rightRevision,
    pathOperands,
    detectRenames,
  });
  const renamePaths = new Set<string>();
  for (const rename of exactRenames) {
    renamePaths.add(rename.sourcePath);
    renamePaths.add(rename.destinationPath);
  }
  const outputPaths = new Set(paths.filter(path => !renamePaths.has(path)));
  for (const rename of exactRenames) outputPaths.add(rename.destinationPath);
  const text = sortGitPaths({ paths: outputPaths })
    .map(path => `${quoteGitPath({ path, quoteNonAscii, quoteSpaces: false })}\n`)
    .join('');
  if (text !== '') await context.text().print({ text });
}

export async function writeRevisionNameStatus({ context, repository, leftRevision, rightRevision, pathOperands, quoteNonAscii, detectRenames }: {
  context: WeshCommandContext,
  repository: GitRepository,
  leftRevision: string | undefined,
  rightRevision: string,
  pathOperands: readonly string[],
  quoteNonAscii: boolean,
  detectRenames: boolean,
}): Promise<void> {
  const { left, right, paths, exactRenames } = await revisionDiffNameSelection({
    context,
    repository,
    leftRevision,
    rightRevision,
    pathOperands,
    detectRenames,
  });
  const renamePaths = new Set<string>();
  for (const rename of exactRenames) {
    renamePaths.add(rename.sourcePath);
    renamePaths.add(rename.destinationPath);
  }
  const rows = sortByGitUtf8StringKey({
    values: [
      ...paths.filter(path => !renamePaths.has(path)).map(path => ({
        kind: 'path' as const,
        sortPath: path,
        path,
      })),
      ...exactRenames.map(rename => ({
        kind: 'rename' as const,
        sortPath: rename.sourcePath,
        rename,
      })),
    ],
    key: ({ value }) => value.sortPath,
  });
  let text = '';
  for (const row of rows) {
    switch (row.kind) {
    case 'path': {
      const status = left.has(row.path) ? (right.has(row.path) ? 'M' : 'D') : 'A';
      text += `${status}\t${quoteGitPath({ path: row.path, quoteNonAscii, quoteSpaces: false })}\n`;
      break;
    }
    case 'rename':
      text += `R100\t${quoteGitPath({ path: row.rename.sourcePath, quoteNonAscii, quoteSpaces: false })}\t${quoteGitPath({ path: row.rename.destinationPath, quoteNonAscii, quoteSpaces: false })}\n`;
      break;
    default: {
      const _ex: never = row;
      throw new Error(`Unhandled revision name-status row: ${JSON.stringify(_ex)}`);
    }
    }
  }
  if (text !== '') await context.text().print({ text });
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
    const selected = matchRepositoryPathSelection({
      repository,
      cwd: context.cwd,
      operands: pathOperands,
      availablePaths: snapshotPathUnion({ left, right }),
    }).selected;
    paths = paths.filter(path => selected.has(path));
  }
  await writeDiffStat({ context, repository, paths, left, right, quoteNonAscii, detectRenames });
}

export async function writeRevisionPatch({ context, repository, leftRevision, rightRevision, pathOperands, quoteNonAscii, detectRenames, contextLines = 3 }: {
  context: WeshCommandContext,
  repository: GitRepository,
  leftRevision: string | undefined,
  rightRevision: string,
  pathOperands: readonly string[],
  quoteNonAscii: boolean,
  detectRenames: boolean,
  contextLines?: number,
}): Promise<void> {
  const left = leftRevision === undefined
    ? new Map<string, GitDiffSnapshotEntry>()
    : await snapshotFromTree({ context, repository, revision: leftRevision });
  const right = await snapshotFromTree({ context, repository, revision: rightRevision });
  let paths = changedPaths({ left, right });
  if (pathOperands.length > 0) {
    const selected = matchRepositoryPathSelection({
      repository,
      cwd: context.cwd,
      operands: pathOperands,
      availablePaths: snapshotPathUnion({ left, right }),
    }).selected;
    paths = paths.filter(path => selected.has(path));
  }
  const exactRenames = detectRenames ? exactRenamesForPaths({ paths, left, right }) : [];
  const renamePaths = new Set(exactRenames.flatMap(rename => [rename.sourcePath, rename.destinationPath]));
  const rows = sortByGitUtf8StringKey({
    values: [
      ...paths.filter(path => !renamePaths.has(path)).map(path => ({ kind: 'path' as const, sortPath: path, path })),
      ...exactRenames.map(rename => ({ kind: 'rename' as const, sortPath: rename.sourcePath, rename })),
    ],
    key: ({ value }) => value.sortPath,
  });
  for (const row of rows) {
    switch (row.kind) {
    case 'path':
      await writePatchEntry({ context, repository, path: row.path, left: left.get(row.path), right: right.get(row.path), quoteNonAscii, contextLines });
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
