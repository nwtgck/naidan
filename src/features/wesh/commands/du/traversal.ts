import type {
  WeshCommandContext,
  WeshEntryRef,
  WeshStat,
} from '@/features/wesh/types';
import type { DuOptions } from './options';
import {
  duPatternsMatch,
  type CompiledDuPattern,
} from './pattern';

const utf8Encoder = new TextEncoder();

interface DuTraversalFrame {
  entry: WeshEntryRef,
  displayPath: string,
  depth: number,
  isOperand: boolean,
  phase: 'enter' | 'children' | 'exit',
  identity: string,
  inclusiveValue: bigint,
  directValue: bigint,
  directoryIterator: AsyncIterator<WeshEntryRef> | undefined,
  isDirectory: boolean,
}

export interface DuTraversalResult {
  value: bigint,
  exitCode: number,
  processed: boolean,
}

function basenameOfDisplayPath({ displayPath }: { displayPath: string }): string {
  const slashIndex = displayPath.lastIndexOf('/');
  return slashIndex < 0 ? displayPath : displayPath.slice(slashIndex + 1);
}

function joinDisplayPath({ parent, name }: { parent: string, name: string }): string {
  if (parent === '/') {
    return `/${name}`;
  }
  return parent.endsWith('/') ? `${parent}${name}` : `${parent}/${name}`;
}

function isExcluded({
  patterns,
  displayPath,
}: {
  patterns: CompiledDuPattern[],
  displayPath: string,
}): boolean {
  const basename = basenameOfDisplayPath({ displayPath });
  return duPatternsMatch({
    patterns,
    displayPath,
    basename,
  });
}

function asDirectoryEntry({ entry }: { entry: WeshEntryRef }): WeshEntryRef<'directory'> {
  switch (entry.type) {
  case 'directory':
    return entry as WeshEntryRef<'directory'>;
  case 'file':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    throw new Error(`Not a directory: ${entry.fullPath}`);
  default: {
    const _ex: never = entry;
    throw new Error(`Unhandled du entry type: ${String(_ex)}`);
  }
  }
}

function asSymlinkEntry({ entry }: { entry: WeshEntryRef }): WeshEntryRef<'symlink'> {
  switch (entry.type) {
  case 'symlink':
    return entry as WeshEntryRef<'symlink'>;
  case 'directory':
  case 'file':
  case 'fifo':
  case 'chardev':
    throw new Error(`Not a symbolic link: ${entry.fullPath}`);
  default: {
    const _ex: never = entry;
    throw new Error(`Unhandled du entry type: ${String(_ex)}`);
  }
  }
}

async function getLogicalValue({
  context,
  entry,
  stat,
  metric,
  displayPath,
}: {
  context: WeshCommandContext,
  entry: WeshEntryRef,
  stat: WeshStat,
  metric: DuOptions['metric'],
  displayPath: string,
}): Promise<bigint> {
  switch (metric) {
  case 'inodes':
    return 1n;
  case 'logical-bytes':
    switch (stat.type) {
    case 'file':
      if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
        throw new Error(`invalid file size for '${displayPath}'`);
      }
      return BigInt(stat.size);
    case 'symlink': {
      const target = await context.files.readlinkEntry({
        entry: asSymlinkEntry({ entry }),
      });
      return BigInt(utf8Encoder.encode(target).byteLength);
    }
    case 'directory':
    case 'fifo':
    case 'chardev':
      return 0n;
    default: {
      const _ex: never = stat.type;
      throw new Error(`Unhandled du stat type: ${_ex}`);
    }
    }
  default: {
    const _ex: never = metric;
    throw new Error(`Unhandled du metric: ${_ex}`);
  }
  }
}

function shouldFollowSymlink({
  mode,
  isOperand,
}: {
  mode: DuOptions['symlinkMode'],
  isOperand: boolean,
}): boolean {
  switch (mode) {
  case 'physical':
    return false;
  case 'command-line':
    return isOperand;
  case 'logical':
    return true;
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled du symlink mode: ${_ex}`);
  }
  }
}

async function resolveTraversalEntry({
  context,
  path,
  providedEntry,
  options,
  isOperand,
  requireDirectory,
}: {
  context: WeshCommandContext,
  path: string,
  providedEntry: WeshEntryRef | undefined,
  options: DuOptions,
  isOperand: boolean,
  requireDirectory: boolean,
}): Promise<WeshEntryRef> {
  const follow = requireDirectory || shouldFollowSymlink({
    mode: options.symlinkMode,
    isOperand,
  });
  if (providedEntry !== undefined && (!follow || providedEntry.type !== 'symlink')) {
    return providedEntry;
  }

  return context.files.resolveEntry({
    path,
    finalSymlinkTreatment: follow ? 'follow' : 'no-follow',
  });
}

function shouldDisplayFrame({
  frame,
  options,
}: {
  frame: DuTraversalFrame,
  options: DuOptions,
}): boolean {
  if (options.summarize) {
    return frame.isOperand;
  }
  if (options.maxDepth !== undefined && frame.depth > options.maxDepth) {
    return false;
  }
  return frame.isDirectory || options.showAll || frame.isOperand;
}

async function closeIterator({ iterator }: { iterator: AsyncIterator<WeshEntryRef> | undefined }): Promise<void> {
  if (iterator?.return !== undefined) {
    await iterator.return();
  }
}

export async function traverseDuOperand({
  context,
  operand,
  operationPath,
  providedEntry,
  operandRequiresDirectory,
  options,
  patterns,
  seenIdentities,
  emit,
  reportError,
}: {
  context: WeshCommandContext,
  operand: string,
  operationPath: string,
  providedEntry: WeshEntryRef | undefined,
  operandRequiresDirectory: boolean,
  options: DuOptions,
  patterns: CompiledDuPattern[],
  seenIdentities: Set<string> | undefined,
  emit({ value, displayPath }: { value: bigint, displayPath: string }): Promise<void>,
  reportError({ displayPath, message }: { displayPath: string, message: string }): Promise<void>,
}): Promise<DuTraversalResult> {
  if (isExcluded({ patterns, displayPath: operand })) {
    return {
      value: 0n,
      exitCode: 0,
      processed: false,
    };
  }

  let rootEntry: WeshEntryRef;
  try {
    rootEntry = await resolveTraversalEntry({
      context,
      path: operationPath,
      providedEntry,
      options,
      isOperand: true,
      requireDirectory: operandRequiresDirectory,
    });
  } catch (error: unknown) {
    await reportError({
      displayPath: operand,
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      value: 0n,
      exitCode: 1,
      processed: false,
    };
  }

  if (operandRequiresDirectory && rootEntry.type !== 'directory') {
    await reportError({
      displayPath: operand,
      message: 'Not a directory',
    });
    return {
      value: 0n,
      exitCode: 1,
      processed: false,
    };
  }

  const rootIdentity = rootEntry.fullPath;
  if (seenIdentities?.has(rootIdentity) === true) {
    return {
      value: 0n,
      exitCode: 0,
      processed: false,
    };
  }
  seenIdentities?.add(rootIdentity);

  const stack: DuTraversalFrame[] = [{
    entry: rootEntry,
    displayPath: operand,
    depth: 0,
    isOperand: true,
    phase: 'enter',
    identity: rootIdentity,
    inclusiveValue: 0n,
    directValue: 0n,
    directoryIterator: undefined,
    isDirectory: rootEntry.type === 'directory',
  }];
  const activeIdentities = new Set<string>();
  let exitCode = 0;
  let rootValue = 0n;

  const finishFrame = async ({ frame }: { frame: DuTraversalFrame }): Promise<void> => {
    if (frame.isDirectory) {
      activeIdentities.delete(frame.identity);
    }

    const displayValue = options.separateDirs && frame.isDirectory
      ? frame.directValue
      : frame.inclusiveValue;
    if (shouldDisplayFrame({ frame, options })) {
      await emit({ value: displayValue, displayPath: frame.displayPath });
    }

    stack.pop();
    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      rootValue = frame.inclusiveValue;
      return;
    }

    parent.inclusiveValue += frame.inclusiveValue;
    if (!frame.isDirectory) {
      parent.directValue += frame.inclusiveValue;
    }
  };

  try {
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) {
        break;
      }

      switch (frame.phase) {
      case 'enter': {
        let stat: WeshStat;
        try {
          stat = await context.files.statEntry({ entry: frame.entry });
          const ownValue = await getLogicalValue({
            context,
            entry: frame.entry,
            stat,
            metric: options.metric,
            displayPath: frame.displayPath,
          });
          frame.inclusiveValue = ownValue;
          frame.directValue = ownValue;
          frame.isDirectory = stat.type === 'directory';
        } catch (error: unknown) {
          await reportError({
            displayPath: frame.displayPath,
            message: error instanceof Error ? error.message : String(error),
          });
          exitCode = 1;
          seenIdentities?.delete(frame.identity);
          stack.pop();
          continue;
        }

        if (!frame.isDirectory) {
          await finishFrame({ frame });
          continue;
        }

        activeIdentities.add(frame.identity);
        frame.directoryIterator = context.files.readDirEntry({
          entry: asDirectoryEntry({ entry: frame.entry }),
        })[Symbol.asyncIterator]();
        frame.phase = 'children';
        continue;
      }
      case 'children': {
        let next: IteratorResult<WeshEntryRef>;
        try {
          const iterator = frame.directoryIterator;
          if (iterator === undefined) {
            throw new Error(`Missing directory iterator for ${frame.displayPath}`);
          }
          next = await iterator.next();
        } catch (error: unknown) {
          await reportError({
            displayPath: frame.displayPath,
            message: error instanceof Error ? error.message : String(error),
          });
          exitCode = 1;
          await closeIterator({ iterator: frame.directoryIterator });
          frame.phase = 'exit';
          continue;
        }

        if (next.done) {
          frame.phase = 'exit';
          continue;
        }

        const child = next.value;
        const childDisplayPath = joinDisplayPath({
          parent: frame.displayPath,
          name: child.name,
        });
        if (isExcluded({ patterns, displayPath: childDisplayPath })) {
          continue;
        }

        let resolvedChild: WeshEntryRef;
        try {
          resolvedChild = await resolveTraversalEntry({
            context,
            path: child.fullPath,
            providedEntry: child,
            options,
            isOperand: false,
            requireDirectory: false,
          });
        } catch (error: unknown) {
          await reportError({
            displayPath: childDisplayPath,
            message: error instanceof Error ? error.message : String(error),
          });
          exitCode = 1;
          continue;
        }

        const identity = resolvedChild.fullPath;
        if (activeIdentities.has(identity)) {
          await reportError({
            displayPath: childDisplayPath,
            message: 'symbolic link cycle',
          });
          exitCode = 1;
          continue;
        }
        if (seenIdentities?.has(identity) === true) {
          continue;
        }
        seenIdentities?.add(identity);

        stack.push({
          entry: resolvedChild,
          displayPath: childDisplayPath,
          depth: frame.depth + 1,
          isOperand: false,
          phase: 'enter',
          identity,
          inclusiveValue: 0n,
          directValue: 0n,
          directoryIterator: undefined,
          isDirectory: resolvedChild.type === 'directory',
        });
        continue;
      }
      case 'exit':
        await finishFrame({ frame });
        continue;
      default: {
        const _ex: never = frame.phase;
        throw new Error(`Unhandled du traversal phase: ${_ex}`);
      }
      }
    }
  } finally {
    for (const frame of stack) {
      await closeIterator({ iterator: frame.directoryIterator });
    }
  }

  return {
    value: rootValue,
    exitCode,
    processed: true,
  };
}

export function shouldTrackDuIdentities({
  options,
  operandSource,
}: {
  options: DuOptions,
  operandSource: 'single' | 'multiple-or-streaming',
}): boolean {
  if (options.countLinks) {
    return false;
  }
  return operandSource === 'multiple-or-streaming' || options.symlinkMode !== 'physical';
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
