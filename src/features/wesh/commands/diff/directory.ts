import { foldAsciiCase } from '@/features/wesh/commands/_shared/locale';
import { isPathNotFoundError } from '@/features/wesh/commands/_shared/path-errors';
import { resolvePath } from '@/features/wesh/path';
import type {
  WeshCommandContext,
  WeshDirEntry,
  WeshFileHandle,
  WeshFileType,
  WeshStat,
} from '@/features/wesh/types';
import { readAllFileBytes } from '@/features/wesh/utils/fs';
import { promiseAllKeyed } from '@/utils/promise';
import { compareDiffInputs, type DiffCompareSettings } from './compare';
import { createDiffInput } from './input';
import type { DiffInput } from './model';
import type { DiffByteWriter } from './output';
import { quoteDiffFileName } from './quote';

const BRIEF_COMPARE_CHUNK_SIZE = 64 * 1024;

export interface DiffDirectoryOptions {
  readonly recursive: boolean,
  readonly noDereference: boolean,
  readonly missingFileMode: 'report' | 'both-empty' | 'left-empty',
  readonly fileNameCaseMode: 'sensitive' | 'insensitive',
  readonly excludePatterns: readonly RegExp[],
  readonly startingFile: string | undefined,
}

async function getComparisonStat({
  context,
  path,
  noDereference,
}: {
  context: WeshCommandContext,
  path: string,
  noDereference: boolean,
}): Promise<WeshStat> {
  return noDereference
    ? await context.files.lstat({ path })
    : await context.files.stat({ path });
}

type ComparisonStatResult =
  | { readonly kind: 'found', readonly stat: WeshStat }
  | { readonly kind: 'missing', readonly message: string };

async function tryGetComparisonStat({
  context,
  path,
  noDereference,
}: {
  context: WeshCommandContext,
  path: string,
  noDereference: boolean,
}): Promise<ComparisonStatResult> {
  try {
    return {
      kind: 'found',
      stat: await getComparisonStat({ context, path, noDereference }),
    };
  } catch (error) {
    if (!isPathNotFoundError({ error })) {
      throw error;
    }
    return {
      kind: 'missing',
      // Browser OPFS error messages differ between engines. Once the error is
      // semantically classified as a missing path, expose a stable shell-style
      // diagnostic rather than leaking the browser-specific DOMException text.
      message: `${path}: No such file or directory`,
    };
  }
}

export type DiffCompareStatus = 'same' | 'different' | 'trouble';

type EntryPairKind = 'directories' | 'files' | 'special-files' | 'mismatched-types';

interface DirectoryEntryPair {
  readonly name: string,
  readonly left: WeshDirEntry | undefined,
  readonly right: WeshDirEntry | undefined,
}

interface DirectorySide {
  readonly actualPath: string | undefined,
  readonly displayPath: string,
}

interface PendingDirectory {
  readonly left: DirectorySide,
  readonly right: DirectorySide,
  readonly leftAncestorInodes: ReadonlySet<number>,
  readonly rightAncestorInodes: ReadonlySet<number>,
  readonly startingFile: string | undefined,
}

interface FileSide extends DirectorySide {
  readonly stat: WeshStat | undefined,
}

async function extendDirectoryAncestors({
  context,
  side,
  ancestors,
  noDereference,
}: {
  context: WeshCommandContext,
  side: DirectorySide,
  ancestors: ReadonlySet<number>,
  noDereference: boolean,
}): Promise<{
  readonly ancestors: ReadonlySet<number>,
  readonly loopPath: string | undefined,
}> {
  if (side.actualPath === undefined) {
    return {
      ancestors,
      loopPath: undefined,
    };
  }

  const stat = await getComparisonStat({
    context,
    path: side.actualPath,
    noDereference,
  });
  switch (stat.type) {
  case 'directory':
    break;
  case 'file':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    throw new Error(`${side.displayPath}: expected directory, found ${stat.type}`);
  default: {
    const _ex: never = stat.type;
    throw new Error(`Unhandled file type: ${_ex}`);
  }
  }
  if (ancestors.has(stat.ino)) {
    return {
      ancestors,
      loopPath: side.displayPath,
    };
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(stat.ino);
  return {
    ancestors: nextAncestors,
    loopPath: undefined,
  };
}

function joinPath({ parent, name }: { parent: string, name: string }): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
}

function basename({ path }: { path: string }): string {
  const normalized = path.length > 1 ? path.replace(/\/+$/u, '') : path;
  const index = normalized.lastIndexOf('/');
  return index < 0 ? normalized : normalized.slice(index + 1);
}

function parentPath({ path }: { path: string }): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

function mergeStatus({
  current,
  next,
}: {
  current: DiffCompareStatus,
  next: DiffCompareStatus,
}): DiffCompareStatus {
  switch (next) {
  case 'trouble':
    return 'trouble';
  case 'different':
    switch (current) {
    case 'trouble': return 'trouble';
    case 'different':
    case 'same': return 'different';
    default: {
      const _ex: never = current;
      throw new Error(`Unhandled compare status: ${_ex}`);
    }
    }
  case 'same':
    return current;
  default: {
    const _ex: never = next;
    throw new Error(`Unhandled compare status: ${_ex}`);
  }
  }
}

function normalizeEntryName({
  name,
  mode,
}: {
  name: string,
  mode: DiffDirectoryOptions['fileNameCaseMode'],
}): string {
  switch (mode) {
  case 'sensitive':
    return name;
  case 'insensitive':
    return foldAsciiCase({ value: name });
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled file-name case mode: ${_ex}`);
  }
  }
}

function shouldTreatMissingAsEmpty({
  mode,
  existingSide,
}: {
  mode: DiffDirectoryOptions['missingFileMode'],
  existingSide: 'left' | 'right',
}): boolean {
  switch (mode) {
  case 'report':
    return false;
  case 'both-empty':
    return true;
  case 'left-empty':
    switch (existingSide) {
    case 'left': return false;
    case 'right': return true;
    default: {
      const _ex: never = existingSide;
      throw new Error(`Unhandled existing side: ${_ex}`);
    }
    }
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled missing-file mode: ${_ex}`);
  }
  }
}

function classifyEntryPair({
  leftType,
  rightType,
}: {
  leftType: WeshFileType,
  rightType: WeshFileType,
}): EntryPairKind {
  switch (leftType) {
  case 'directory':
    switch (rightType) {
    case 'directory': return 'directories';
    case 'file':
    case 'fifo':
    case 'chardev':
    case 'symlink': return 'mismatched-types';
    default: {
      const _ex: never = rightType;
      throw new Error(`Unhandled right file type: ${_ex}`);
    }
    }
  case 'file':
    switch (rightType) {
    case 'file': return 'files';
    case 'directory':
    case 'fifo':
    case 'chardev':
    case 'symlink': return 'mismatched-types';
    default: {
      const _ex: never = rightType;
      throw new Error(`Unhandled right file type: ${_ex}`);
    }
    }
  case 'fifo':
    switch (rightType) {
    case 'directory':
    case 'file': return 'mismatched-types';
    case 'fifo': return 'special-files';
    case 'chardev':
    case 'symlink': return 'mismatched-types';
    default: {
      const _ex: never = rightType;
      throw new Error(`Unhandled right file type: ${_ex}`);
    }
    }
  case 'chardev':
    switch (rightType) {
    case 'directory':
    case 'file':
    case 'fifo':
    case 'symlink': return 'mismatched-types';
    case 'chardev': return 'special-files';
    default: {
      const _ex: never = rightType;
      throw new Error(`Unhandled right file type: ${_ex}`);
    }
    }
  case 'symlink':
    switch (rightType) {
    case 'directory':
    case 'file':
    case 'fifo':
    case 'chardev': return 'mismatched-types';
    case 'symlink': return 'special-files';
    default: {
      const _ex: never = rightType;
      throw new Error(`Unhandled right file type: ${_ex}`);
    }
    }
  default: {
    const _ex: never = leftType;
    throw new Error(`Unhandled left file type: ${_ex}`);
  }
  }
}

function shouldExclude({
  name,
  patterns,
}: {
  name: string,
  patterns: readonly RegExp[],
}): boolean {
  return patterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(name);
  });
}

async function collectDirectoryEntries({
  context,
  side,
  options,
  startingFile,
}: {
  context: WeshCommandContext,
  side: DirectorySide,
  options: DiffDirectoryOptions,
  startingFile: string | undefined,
}): Promise<Map<string, WeshDirEntry[]>> {
  const entries = new Map<string, WeshDirEntry[]>();
  if (side.actualPath === undefined) {
    return entries;
  }

  for await (const entry of context.files.readDir({ path: side.actualPath })) {
    if (shouldExclude({ name: entry.name, patterns: options.excludePatterns })) {
      continue;
    }
    if (startingFile !== undefined && entry.name < startingFile) {
      continue;
    }
    const key = normalizeEntryName({ name: entry.name, mode: options.fileNameCaseMode });
    const group = entries.get(key);
    if (group === undefined) {
      entries.set(key, [entry]);
    } else {
      group.push(entry);
    }
  }

  for (const group of entries.values()) {
    group.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  }
  return entries;
}

function pairEntryGroups({
  leftEntries,
  rightEntries,
}: {
  leftEntries: readonly WeshDirEntry[],
  rightEntries: readonly WeshDirEntry[],
}): DirectoryEntryPair[] {
  const pairs: DirectoryEntryPair[] = [];
  const unmatchedRight = [...rightEntries];
  const unmatchedLeft: WeshDirEntry[] = [];

  for (const left of leftEntries) {
    const exactIndex = unmatchedRight.findIndex((right) => right.name === left.name);
    if (exactIndex < 0) {
      unmatchedLeft.push(left);
      continue;
    }
    const [right] = unmatchedRight.splice(exactIndex, 1);
    pairs.push({ name: left.name, left, right });
  }

  const pairedCount = Math.min(unmatchedLeft.length, unmatchedRight.length);
  for (let index = 0; index < pairedCount; index++) {
    const left = unmatchedLeft[index];
    const right = unmatchedRight[index];
    if (left !== undefined && right !== undefined) {
      pairs.push({ name: left.name, left, right });
    }
  }
  for (let index = pairedCount; index < unmatchedLeft.length; index++) {
    const left = unmatchedLeft[index];
    if (left !== undefined) {
      pairs.push({ name: left.name, left, right: undefined });
    }
  }
  for (let index = pairedCount; index < unmatchedRight.length; index++) {
    const right = unmatchedRight[index];
    if (right !== undefined) {
      pairs.push({ name: right.name, left: undefined, right });
    }
  }

  return pairs;
}

function pairDirectoryEntries({
  leftEntries,
  rightEntries,
}: {
  leftEntries: ReadonlyMap<string, readonly WeshDirEntry[]>,
  rightEntries: ReadonlyMap<string, readonly WeshDirEntry[]>,
}): DirectoryEntryPair[] {
  const keys = new Set<string>([...leftEntries.keys(), ...rightEntries.keys()]);
  const pairs: DirectoryEntryPair[] = [];
  for (const key of [...keys].sort()) {
    const groupedPairs = pairEntryGroups({
      leftEntries: leftEntries.get(key) ?? [],
      rightEntries: rightEntries.get(key) ?? [],
    });
    for (const pair of groupedPairs) pairs.push(pair);
  }
  return pairs;
}

async function readInputAtSide({
  context,
  side,
}: {
  context: WeshCommandContext,
  side: FileSide,
}): Promise<DiffInput> {
  if (side.actualPath === undefined) {
    return createDiffInput({
      displayName: side.displayPath,
      resolvedPath: undefined,
      mtime: undefined,
      bytes: new Uint8Array(0),
    });
  }
  try {
    const bytes = await readAllFileBytes({ files: context.files, path: side.actualPath });
    return createDiffInput({
      displayName: side.displayPath,
      resolvedPath: side.actualPath,
      mtime: side.stat?.mtime,
      bytes,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${side.displayPath}: ${message}`);
  }
}

function isIfdefMode({ settings }: { settings: DiffCompareSettings }): boolean {
  switch (settings.outputOptions.mode.kind) {
  case 'ifdef': return true;
  case 'brief':
  case 'normal':
  case 'unified':
  case 'context':
  case 'side-by-side':
  case 'ed':
  case 'rcs': return false;
  default: {
    const _ex: never = settings.outputOptions.mode;
    throw new Error(`Unhandled output mode: ${JSON.stringify(_ex)}`);
  }
  }
}

function isBriefMode({ settings }: { settings: DiffCompareSettings }): boolean {
  switch (settings.outputOptions.mode.kind) {
  case 'brief': return true;
  case 'normal':
  case 'unified':
  case 'context':
  case 'side-by-side':
  case 'ed':
  case 'rcs':
  case 'ifdef': return false;
  default: {
    const _ex: never = settings.outputOptions.mode;
    throw new Error(`Unhandled output mode: ${JSON.stringify(_ex)}`);
  }
  }
}

function canUseStreamingBriefComparison({
  settings,
}: {
  settings: DiffCompareSettings,
}): boolean {
  if (!isBriefMode({ settings })) {
    return false;
  }
  if (settings.ignoreBlankLineChanges || settings.ignoreMatchingLinePatterns.length > 0) {
    return false;
  }
  const options = settings.comparisonOptions;
  return !options.stripTrailingCarriageReturn
    && !options.ignoreCase
    && !options.ignoreTabExpansion
    && !options.ignoreTrailingSpace
    && !options.ignoreSpaceChange
    && !options.ignoreAllSpace;
}

async function readFileChunkAt({
  handle,
  position,
  length,
}: {
  handle: WeshFileHandle,
  position: number,
  length: number,
}): Promise<Uint8Array> {
  const buffer = new Uint8Array(length);
  let bytesRead = 0;
  while (bytesRead < length) {
    const result = await handle.read({
      buffer,
      offset: bytesRead,
      length: length - bytesRead,
      position: position + bytesRead,
    });
    if (result.bytesRead === 0) {
      break;
    }
    bytesRead += result.bytesRead;
  }
  return bytesRead === buffer.byteLength ? buffer : buffer.subarray(0, bytesRead);
}

async function compareRegularFileBytesStreaming({
  context,
  left,
  right,
}: {
  context: WeshCommandContext,
  left: FileSide & { readonly actualPath: string, readonly stat: WeshStat },
  right: FileSide & { readonly actualPath: string, readonly stat: WeshStat },
}): Promise<boolean> {
  if (left.stat.size !== right.stat.size) {
    return false;
  }
  if (left.actualPath === right.actualPath || left.stat.ino === right.stat.ino) {
    return true;
  }

  const readFlags = {
    access: 'read',
    creation: 'never',
    truncate: 'preserve',
    append: 'preserve',
  } as const;
  let leftHandle: WeshFileHandle | undefined;
  let rightHandle: WeshFileHandle | undefined;
  try {
    leftHandle = await context.files.open({ path: left.actualPath, flags: readFlags });
    rightHandle = await context.files.open({ path: right.actualPath, flags: readFlags });
    for (let position = 0; position < left.stat.size; position += BRIEF_COMPARE_CHUNK_SIZE) {
      const length = Math.min(BRIEF_COMPARE_CHUNK_SIZE, left.stat.size - position);
      const chunks = await promiseAllKeyed({
        left: readFileChunkAt({ handle: leftHandle, position, length }),
        right: readFileChunkAt({ handle: rightHandle, position, length }),
      });
      if (chunks.left.byteLength !== length || chunks.right.byteLength !== length) {
        throw new Error('unexpected end of file while comparing');
      }
      for (let index = 0; index < length; index++) {
        if (chunks.left[index] !== chunks.right[index]) {
          return false;
        }
      }
    }
    return true;
  } finally {
    if (leftHandle !== undefined && rightHandle !== undefined) {
      await promiseAllKeyed({
        left: leftHandle.close(),
        right: rightHandle.close(),
      });
    } else if (leftHandle !== undefined) {
      await leftHandle.close();
    }
  }
}

async function compareSymbolicLinks({
  context,
  stdout,
  left,
  right,
  settings,
}: {
  context: WeshCommandContext,
  stdout: DiffByteWriter,
  left: DirectorySide & { readonly actualPath: string },
  right: DirectorySide & { readonly actualPath: string },
  settings: DiffCompareSettings,
}): Promise<DiffCompareStatus> {
  const targets = await promiseAllKeyed({
    left: context.files.readlink({ path: left.actualPath }),
    right: context.files.readlink({ path: right.actualPath }),
  });
  if (targets.left === targets.right) {
    if (settings.reportIdenticalFiles) {
      await stdout.writeText({ text: `Files ${left.displayPath} and ${right.displayPath} are identical\n` });
      await stdout.flush();
    }
    return 'same';
  }
  await stdout.writeText({ text: `Symbolic links ${left.displayPath} and ${right.displayPath} differ\n` });
  await stdout.flush();
  return 'different';
}

async function compareRegularFiles({
  context,
  stdout,
  stderr,
  left,
  right,
  settings,
  recursiveCommandPrefix,
}: {
  context: WeshCommandContext,
  stdout: DiffByteWriter,
  stderr: DiffByteWriter,
  left: FileSide,
  right: FileSide,
  settings: DiffCompareSettings,
  recursiveCommandPrefix: string | undefined,
}): Promise<DiffCompareStatus> {
  try {
    if (
      canUseStreamingBriefComparison({ settings })
      && left.actualPath !== undefined
      && right.actualPath !== undefined
      && left.stat !== undefined
      && right.stat !== undefined
    ) {
      const identical = await compareRegularFileBytesStreaming({
        context,
        left: {
          ...left,
          actualPath: left.actualPath,
          stat: left.stat,
        },
        right: {
          ...right,
          actualPath: right.actualPath,
          stat: right.stat,
        },
      });
      if (identical) {
        if (settings.reportIdenticalFiles) {
          await stdout.writeText({ text: `Files ${left.displayPath} and ${right.displayPath} are identical\n` });
          await stdout.flush();
        }
        return 'same';
      }
      await stdout.writeText({ text: `Files ${left.displayPath} and ${right.displayPath} differ\n` });
      await stdout.flush();
      return 'different';
    }

    const inputs = await promiseAllKeyed({
      left: readInputAtSide({ context, side: left }),
      right: readInputAtSide({ context, side: right }),
    });

    const result = await compareDiffInputs({
      writer: stdout,
      left: inputs.left,
      right: inputs.right,
      settings,
      beforeDetailedOutput: recursiveCommandPrefix === undefined || isBriefMode({ settings })
        ? undefined
        : async () => {
          await stdout.writeText({ text: `${recursiveCommandPrefix} ${quoteDiffFileName({ value: left.displayPath })} ${quoteDiffFileName({ value: right.displayPath })}\n` });
          await stdout.flush();
        },
    });
    return result.different ? 'different' : 'same';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await stderr.writeText({ text: `diff: ${message}\n` });
    await stderr.flush();
    return 'trouble';
  }
}

function createFileSidesForExistingEntry({
  existingEntry,
  existingDisplayPath,
  missingDisplayPath,
  existingStat,
  existingSide,
}: {
  existingEntry: WeshDirEntry,
  existingDisplayPath: string,
  missingDisplayPath: string,
  existingStat: WeshStat,
  existingSide: 'left' | 'right',
}): { left: FileSide, right: FileSide } {
  switch (existingSide) {
  case 'left':
    return {
      left: {
        actualPath: existingEntry.fullPath,
        displayPath: existingDisplayPath,
        stat: existingStat,
      },
      right: {
        actualPath: undefined,
        displayPath: missingDisplayPath,
        stat: undefined,
      },
    };
  case 'right':
    return {
      left: {
        actualPath: undefined,
        displayPath: missingDisplayPath,
        stat: undefined,
      },
      right: {
        actualPath: existingEntry.fullPath,
        displayPath: existingDisplayPath,
        stat: existingStat,
      },
    };
  default: {
    const _ex: never = existingSide;
    throw new Error(`Unhandled existing side: ${_ex}`);
  }
  }
}

async function handleOnlyEntry({
  context,
  stdout,
  stderr,
  existingEntry,
  existingDisplayPath,
  missingDisplayPath,
  existingSide,
  options,
  settings,
  recursiveCommandPrefix,
  pendingDirectories,
  leftAncestorInodes,
  rightAncestorInodes,
}: {
  context: WeshCommandContext,
  stdout: DiffByteWriter,
  stderr: DiffByteWriter,
  existingEntry: WeshDirEntry,
  existingDisplayPath: string,
  missingDisplayPath: string,
  existingSide: 'left' | 'right',
  options: DiffDirectoryOptions,
  settings: DiffCompareSettings,
  recursiveCommandPrefix: string,
  pendingDirectories: PendingDirectory[],
  leftAncestorInodes: ReadonlySet<number>,
  rightAncestorInodes: ReadonlySet<number>,
}): Promise<DiffCompareStatus> {
  if (!shouldTreatMissingAsEmpty({ mode: options.missingFileMode, existingSide })) {
    await stdout.writeText({ text: `Only in ${parentPath({ path: existingDisplayPath })}: ${existingEntry.name}\n` });
    await stdout.flush();
    return 'different';
  }

  const existingStat = await getComparisonStat({
    context,
    path: existingEntry.fullPath,
    noDereference: options.noDereference,
  });
  switch (existingStat.type) {
  case 'directory':
    if (!options.recursive) {
      await stdout.writeText({ text: `Only in ${parentPath({ path: existingDisplayPath })}: ${existingEntry.name}\n` });
      await stdout.flush();
      return 'different';
    }
    switch (existingSide) {
    case 'left':
      pendingDirectories.push({
        left: { actualPath: existingEntry.fullPath, displayPath: existingDisplayPath },
        right: { actualPath: undefined, displayPath: missingDisplayPath },
        leftAncestorInodes,
        rightAncestorInodes,
        startingFile: undefined,
      });
      return 'same';
    case 'right':
      pendingDirectories.push({
        left: { actualPath: undefined, displayPath: missingDisplayPath },
        right: { actualPath: existingEntry.fullPath, displayPath: existingDisplayPath },
        leftAncestorInodes,
        rightAncestorInodes,
        startingFile: undefined,
      });
      return 'same';
    default: {
      const _ex: never = existingSide;
      throw new Error(`Unhandled existing side: ${_ex}`);
    }
    }
  case 'file': {
    const sides = createFileSidesForExistingEntry({
      existingEntry,
      existingDisplayPath,
      missingDisplayPath,
      existingStat,
      existingSide,
    });
    return await compareRegularFiles({
      context,
      stdout,
      stderr,
      left: sides.left,
      right: sides.right,
      settings,
      recursiveCommandPrefix,
    });
  }
  case 'fifo':
  case 'chardev':
  case 'symlink':
    await stdout.writeText({ text: `File ${existingDisplayPath} is not a regular file\n` });
    await stdout.flush();
    return 'different';
  default: {
    const _ex: never = existingStat.type;
    throw new Error(`Unhandled file type: ${_ex}`);
  }
  }
}

export async function compareDirectories({
  context,
  stdout,
  stderr,
  left,
  right,
  options,
  settings,
  recursiveCommandPrefix,
}: {
  context: WeshCommandContext,
  stdout: DiffByteWriter,
  stderr: DiffByteWriter,
  left: DirectorySide,
  right: DirectorySide,
  options: DiffDirectoryOptions,
  settings: DiffCompareSettings,
  recursiveCommandPrefix: string,
}): Promise<DiffCompareStatus> {
  if (isIfdefMode({ settings })) {
    await stderr.writeText({ text: 'diff: -D option not supported with directories\n' });
    await stderr.flush();
    return 'trouble';
  }

  const pending: PendingDirectory[] = [{
    left,
    right,
    leftAncestorInodes: new Set<number>(),
    rightAncestorInodes: new Set<number>(),
    startingFile: options.startingFile,
  }];
  let overall: DiffCompareStatus = 'same';

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }

    let leftEntries: Map<string, WeshDirEntry[]>;
    let rightEntries: Map<string, WeshDirEntry[]>;
    let leftAncestorInodes: ReadonlySet<number>;
    let rightAncestorInodes: ReadonlySet<number>;
    try {
      const ancestorResults = await promiseAllKeyed({
        left: extendDirectoryAncestors({
          context,
          side: current.left,
          ancestors: current.leftAncestorInodes,
          noDereference: options.noDereference,
        }),
        right: extendDirectoryAncestors({
          context,
          side: current.right,
          ancestors: current.rightAncestorInodes,
          noDereference: options.noDereference,
        }),
      });
      let hasLoop = false;
      if (ancestorResults.left.loopPath !== undefined) {
        await stderr.writeText({ text: `diff: ${ancestorResults.left.loopPath}: recursive directory loop\n` });
        hasLoop = true;
      }
      if (ancestorResults.right.loopPath !== undefined) {
        await stderr.writeText({ text: `diff: ${ancestorResults.right.loopPath}: recursive directory loop\n` });
        hasLoop = true;
      }
      if (hasLoop) {
        await stderr.flush();
        overall = 'trouble';
        continue;
      }
      leftAncestorInodes = ancestorResults.left.ancestors;
      rightAncestorInodes = ancestorResults.right.ancestors;

      const entries = await promiseAllKeyed({
        left: collectDirectoryEntries({ context, side: current.left, options, startingFile: current.startingFile }),
        right: collectDirectoryEntries({ context, side: current.right, options, startingFile: current.startingFile }),
      });
      leftEntries = entries.left;
      rightEntries = entries.right;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await stderr.writeText({ text: `diff: ${message}\n` });
      await stderr.flush();
      overall = 'trouble';
      continue;
    }

    const pairs = pairDirectoryEntries({ leftEntries, rightEntries });
    const childDirectories: PendingDirectory[] = [];
    for (const pair of pairs) {
      if (pair.left === undefined && pair.right !== undefined) {
        const result = await handleOnlyEntry({
          context,
          stdout,
          stderr,
          existingEntry: pair.right,
          existingDisplayPath: joinPath({ parent: current.right.displayPath, name: pair.right.name }),
          missingDisplayPath: joinPath({ parent: current.left.displayPath, name: pair.right.name }),
          existingSide: 'right',
          options,
          settings,
          recursiveCommandPrefix,
          pendingDirectories: childDirectories,
          leftAncestorInodes,
          rightAncestorInodes,
        });
        overall = mergeStatus({ current: overall, next: result });
        continue;
      }
      if (pair.right === undefined && pair.left !== undefined) {
        const result = await handleOnlyEntry({
          context,
          stdout,
          stderr,
          existingEntry: pair.left,
          existingDisplayPath: joinPath({ parent: current.left.displayPath, name: pair.left.name }),
          missingDisplayPath: joinPath({ parent: current.right.displayPath, name: pair.left.name }),
          existingSide: 'left',
          options,
          settings,
          recursiveCommandPrefix,
          pendingDirectories: childDirectories,
          leftAncestorInodes,
          rightAncestorInodes,
        });
        overall = mergeStatus({ current: overall, next: result });
        continue;
      }
      if (pair.left === undefined || pair.right === undefined) {
        continue;
      }

      const leftDisplayPath = joinPath({ parent: current.left.displayPath, name: pair.left.name });
      const rightDisplayPath = joinPath({ parent: current.right.displayPath, name: pair.right.name });
      const stats = await promiseAllKeyed({
        left: getComparisonStat({
          context,
          path: pair.left.fullPath,
          noDereference: options.noDereference,
        }),
        right: getComparisonStat({
          context,
          path: pair.right.fullPath,
          noDereference: options.noDereference,
        }),
      });
      const pairKind = classifyEntryPair({ leftType: stats.left.type, rightType: stats.right.type });
      switch (pairKind) {
      case 'directories':
        if (options.recursive) {
          childDirectories.push({
            left: { actualPath: pair.left.fullPath, displayPath: leftDisplayPath },
            right: { actualPath: pair.right.fullPath, displayPath: rightDisplayPath },
            leftAncestorInodes,
            rightAncestorInodes,
            startingFile: undefined,
          });
        } else {
          await stdout.writeText({ text: `Common subdirectories: ${leftDisplayPath} and ${rightDisplayPath}\n` });
          await stdout.flush();
        }
        break;
      case 'mismatched-types':
        await stdout.writeText({ text: `File ${leftDisplayPath} is a ${pair.left.type} while file ${rightDisplayPath} is a ${pair.right.type}\n` });
        await stdout.flush();
        overall = mergeStatus({ current: overall, next: 'different' });
        break;
      case 'special-files':
        switch (stats.left.type) {
        case 'symlink': {
          const result = await compareSymbolicLinks({
            context,
            stdout,
            left: { actualPath: pair.left.fullPath, displayPath: leftDisplayPath },
            right: { actualPath: pair.right.fullPath, displayPath: rightDisplayPath },
            settings,
          });
          overall = mergeStatus({ current: overall, next: result });
          break;
        }
        case 'fifo':
        case 'chardev':
          await stdout.writeText({ text: `Files ${leftDisplayPath} and ${rightDisplayPath} are special files\n` });
          await stdout.flush();
          overall = mergeStatus({ current: overall, next: 'different' });
          break;
        case 'directory':
        case 'file':
          throw new Error(`Unexpected special-file classification for ${stats.left.type}`);
        default: {
          const _ex: never = stats.left.type;
          throw new Error(`Unhandled file type: ${_ex}`);
        }
        }
        break;
      case 'files': {
        const result = await compareRegularFiles({
          context,
          stdout,
          stderr,
          left: { actualPath: pair.left.fullPath, displayPath: leftDisplayPath, stat: stats.left },
          right: { actualPath: pair.right.fullPath, displayPath: rightDisplayPath, stat: stats.right },
          settings,
          recursiveCommandPrefix,
        });
        overall = mergeStatus({ current: overall, next: result });
        break;
      }
      default: {
        const _ex: never = pairKind;
        throw new Error(`Unhandled entry pair kind: ${_ex}`);
      }
      }
    }

    for (let index = childDirectories.length - 1; index >= 0; index--) {
      const child = childDirectories[index];
      if (child !== undefined) pending.push(child);
    }
  }

  return overall;
}

function classifyTopLevelPair({
  leftType,
  rightType,
}: {
  leftType: WeshFileType,
  rightType: WeshFileType,
}): EntryPairKind {
  return classifyEntryPair({ leftType, rightType });
}

async function compareMissingTopLevelOperand({
  context,
  stdout,
  stderr,
  missingDisplayPath,
  missingMessage,
  existingPath,
  existingDisplayPath,
  existingStat,
  existingSide,
  options,
  settings,
  recursiveCommandPrefix,
}: {
  context: WeshCommandContext,
  stdout: DiffByteWriter,
  stderr: DiffByteWriter,
  missingDisplayPath: string,
  missingMessage: string,
  existingPath: string,
  existingDisplayPath: string,
  existingStat: WeshStat,
  existingSide: 'left' | 'right',
  options: DiffDirectoryOptions,
  settings: DiffCompareSettings,
  recursiveCommandPrefix: string,
}): Promise<DiffCompareStatus> {
  if (!shouldTreatMissingAsEmpty({ mode: options.missingFileMode, existingSide })) {
    await stderr.writeText({ text: `diff: ${missingMessage}\n` });
    await stderr.flush();
    return 'trouble';
  }

  switch (existingStat.type) {
  case 'file': {
    const emptySide: FileSide = {
      actualPath: undefined,
      displayPath: missingDisplayPath,
      stat: undefined,
    };
    const existingFileSide: FileSide = {
      actualPath: existingPath,
      displayPath: existingDisplayPath,
      stat: existingStat,
    };
    switch (existingSide) {
    case 'left':
      return await compareRegularFiles({
        context,
        stdout,
        stderr,
        left: existingFileSide,
        right: emptySide,
        settings,
        recursiveCommandPrefix: undefined,
      });
    case 'right':
      return await compareRegularFiles({
        context,
        stdout,
        stderr,
        left: emptySide,
        right: existingFileSide,
        settings,
        recursiveCommandPrefix: undefined,
      });
    default: {
      const _ex: never = existingSide;
      throw new Error(`Unhandled existing side: ${_ex}`);
    }
    }
  }
  case 'directory':
    switch (existingSide) {
    case 'left':
      return await compareDirectories({
        context,
        stdout,
        stderr,
        left: { actualPath: existingPath, displayPath: existingDisplayPath },
        right: { actualPath: undefined, displayPath: missingDisplayPath },
        options,
        settings,
        recursiveCommandPrefix,
      });
    case 'right':
      return await compareDirectories({
        context,
        stdout,
        stderr,
        left: { actualPath: undefined, displayPath: missingDisplayPath },
        right: { actualPath: existingPath, displayPath: existingDisplayPath },
        options,
        settings,
        recursiveCommandPrefix,
      });
    default: {
      const _ex: never = existingSide;
      throw new Error(`Unhandled existing side: ${_ex}`);
    }
    }
  case 'fifo':
  case 'chardev':
  case 'symlink':
    await stdout.writeText({ text: `File ${existingDisplayPath} is not a regular file while file ${missingDisplayPath} is absent\n` });
    await stdout.flush();
    return 'different';
  default: {
    const _ex: never = existingStat.type;
    throw new Error(`Unhandled file type: ${_ex}`);
  }
  }
}

export async function comparePathOperands({
  context,
  stdout,
  stderr,
  leftOperand,
  rightOperand,
  options,
  settings,
  recursiveCommandPrefix,
}: {
  context: WeshCommandContext,
  stdout: DiffByteWriter,
  stderr: DiffByteWriter,
  leftOperand: string,
  rightOperand: string,
  options: DiffDirectoryOptions,
  settings: DiffCompareSettings,
  recursiveCommandPrefix: string,
}): Promise<DiffCompareStatus> {
  let leftPath = resolvePath({ cwd: context.cwd, path: leftOperand });
  let rightPath = resolvePath({ cwd: context.cwd, path: rightOperand });
  let leftDisplayPath = leftOperand;
  let rightDisplayPath = rightOperand;

  try {
    const statResults = await promiseAllKeyed({
      left: tryGetComparisonStat({ context, path: leftPath, noDereference: options.noDereference }),
      right: tryGetComparisonStat({ context, path: rightPath, noDereference: options.noDereference }),
    });
    let stats: { left: WeshStat, right: WeshStat };
    switch (statResults.left.kind) {
    case 'missing':
      switch (statResults.right.kind) {
      case 'missing':
        await stderr.writeText({ text: `diff: ${statResults.left.message}\n` });
        await stderr.writeText({ text: `diff: ${statResults.right.message}\n` });
        await stderr.flush();
        return 'trouble';
      case 'found':
        return await compareMissingTopLevelOperand({
          context,
          stdout,
          stderr,
          missingDisplayPath: leftDisplayPath,
          missingMessage: statResults.left.message.replace(leftPath, leftDisplayPath),
          existingPath: rightPath,
          existingDisplayPath: rightDisplayPath,
          existingStat: statResults.right.stat,
          existingSide: 'right',
          options,
          settings,
          recursiveCommandPrefix,
        });
      default: {
        const _ex: never = statResults.right;
        throw new Error(`Unhandled stat result: ${JSON.stringify(_ex)}`);
      }
      }
    case 'found':
      switch (statResults.right.kind) {
      case 'missing':
        return await compareMissingTopLevelOperand({
          context,
          stdout,
          stderr,
          missingDisplayPath: rightDisplayPath,
          missingMessage: statResults.right.message.replace(rightPath, rightDisplayPath),
          existingPath: leftPath,
          existingDisplayPath: leftDisplayPath,
          existingStat: statResults.left.stat,
          existingSide: 'left',
          options,
          settings,
          recursiveCommandPrefix,
        });
      case 'found':
        stats = {
          left: statResults.left.stat,
          right: statResults.right.stat,
        };
        break;
      default: {
        const _ex: never = statResults.right;
        throw new Error(`Unhandled stat result: ${JSON.stringify(_ex)}`);
      }
      }
      break;
    default: {
      const _ex: never = statResults.left;
      throw new Error(`Unhandled stat result: ${JSON.stringify(_ex)}`);
    }
    }

    const initialPairKind = classifyTopLevelPair({ leftType: stats.left.type, rightType: stats.right.type });
    switch (initialPairKind) {
    case 'directories':
      return await compareDirectories({
        context,
        stdout,
        stderr,
        left: { actualPath: leftPath, displayPath: leftDisplayPath },
        right: { actualPath: rightPath, displayPath: rightDisplayPath },
        options,
        settings,
        recursiveCommandPrefix,
      });
    case 'files':
      return await compareRegularFiles({
        context,
        stdout,
        stderr,
        left: { actualPath: leftPath, displayPath: leftDisplayPath, stat: stats.left },
        right: { actualPath: rightPath, displayPath: rightDisplayPath, stat: stats.right },
        settings,
        recursiveCommandPrefix: undefined,
      });
    case 'special-files':
      switch (stats.left.type) {
      case 'symlink':
        return await compareSymbolicLinks({
          context,
          stdout,
          left: { actualPath: leftPath, displayPath: leftDisplayPath },
          right: { actualPath: rightPath, displayPath: rightDisplayPath },
          settings,
        });
      case 'fifo':
      case 'chardev':
        await stdout.writeText({ text: `Files ${leftDisplayPath} and ${rightDisplayPath} are special files\n` });
        await stdout.flush();
        return 'different';
      case 'directory':
      case 'file':
        throw new Error(`Unexpected special-file classification for ${stats.left.type}`);
      default: {
        const _ex: never = stats.left.type;
        throw new Error(`Unhandled file type: ${_ex}`);
      }
      }
    case 'mismatched-types':
      break;
    default: {
      const _ex: never = initialPairKind;
      throw new Error(`Unhandled top-level pair kind: ${_ex}`);
    }
    }

    switch (stats.left.type) {
    case 'directory':
      leftPath = joinPath({ parent: leftPath, name: basename({ path: rightPath }) });
      leftDisplayPath = joinPath({ parent: leftDisplayPath, name: basename({ path: rightDisplayPath }) });
      stats = await promiseAllKeyed({
        left: getComparisonStat({ context, path: leftPath, noDereference: options.noDereference }),
        right: Promise.resolve(stats.right),
      });
      break;
    case 'file':
    case 'fifo':
    case 'chardev':
    case 'symlink':
      switch (stats.right.type) {
      case 'directory':
        rightPath = joinPath({ parent: rightPath, name: basename({ path: leftPath }) });
        rightDisplayPath = joinPath({ parent: rightDisplayPath, name: basename({ path: leftDisplayPath }) });
        stats = await promiseAllKeyed({
          left: Promise.resolve(stats.left),
          right: getComparisonStat({ context, path: rightPath, noDereference: options.noDereference }),
        });
        break;
      case 'file':
      case 'fifo':
      case 'chardev':
      case 'symlink':
        break;
      default: {
        const _ex: never = stats.right.type;
        throw new Error(`Unhandled right file type: ${_ex}`);
      }
      }
      break;
    default: {
      const _ex: never = stats.left.type;
      throw new Error(`Unhandled left file type: ${_ex}`);
    }
    }

    const resolvedPairKind = classifyTopLevelPair({ leftType: stats.left.type, rightType: stats.right.type });
    switch (resolvedPairKind) {
    case 'files':
      return await compareRegularFiles({
        context,
        stdout,
        stderr,
        left: { actualPath: leftPath, displayPath: leftDisplayPath, stat: stats.left },
        right: { actualPath: rightPath, displayPath: rightDisplayPath, stat: stats.right },
        settings,
        recursiveCommandPrefix: undefined,
      });
    case 'directories':
      return await compareDirectories({
        context,
        stdout,
        stderr,
        left: { actualPath: leftPath, displayPath: leftDisplayPath },
        right: { actualPath: rightPath, displayPath: rightDisplayPath },
        options,
        settings,
        recursiveCommandPrefix,
      });
    case 'mismatched-types':
    case 'special-files':
      await stdout.writeText({ text: `Files ${leftDisplayPath} and ${rightDisplayPath} are not both regular files\n` });
      await stdout.flush();
      return 'different';
    default: {
      const _ex: never = resolvedPairKind;
      throw new Error(`Unhandled top-level pair kind: ${_ex}`);
    }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await stderr.writeText({ text: `diff: ${message}\n` });
    await stderr.flush();
    return 'trouble';
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  pairDirectoryEntries,
};
