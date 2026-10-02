import {
  TransitionNamespaceContractError,
  validateTransitionNamespaceDirectoryPage,
  validateTransitionNamespaceEntryName,
  validateTransitionSymlinkTarget,
} from '@/00-storage/service/naidan-persistence-control/transition/namespace-contracts';
import type {
  BoundedNamespaceEntry as TransitionNamespaceEntry,
  BoundedNamespaceMetadata as TransitionNamespaceMetadata,
  BoundedNamespacePath as TransitionNamespacePath,
  BoundedNamespaceSourcePort as TransitionNamespaceSourcePort,
  BoundedNamespaceTargetPort as TransitionNamespaceTargetPort,
} from '@/00-storage/service/hizofs/api';

export type {
  TransitionNamespaceEntry,
  TransitionNamespaceMetadata,
  TransitionNamespacePath,
  TransitionNamespaceSourcePort,
  TransitionNamespaceTargetPort,
};

export type TransitionNamespaceDirectoryFrame = Readonly<{
  afterName: string | undefined;
  path: TransitionNamespacePath;
}>;

export type TransitionNamespaceActiveFile = Readonly<{
  metadata: TransitionNamespaceMetadata;
  offset: bigint;
  path: TransitionNamespacePath;
  size: bigint;
}>;

export type TransitionNamespaceCopyCursor = Readonly<{
  activeFile: TransitionNamespaceActiveFile | undefined;
  completedBytes: bigint;
  completedEntries: bigint;
  directories: readonly TransitionNamespaceDirectoryFrame[];
  state: 'copying' | 'complete';
}>;

export type TransitionNamespaceCopyPolicy = Readonly<{
  maximumBytesPerSlice: number;
  maximumDirectoryEntriesPerRead: number;
  maximumOperationsPerSlice: number;
  maximumPathComponents: number;
}>;

export class TransitionNamespaceCopyError extends Error {
  public constructor({ code, message }: {
    code: 'budget_invalid' | 'file_size_mismatch' | 'invalid_directory_page' | 'invalid_entry_name' | 'invalid_symlink_target' | 'path_too_deep' | 'source_changed';
    message: string;
  }) {
    super(message);
    this.code = code;
    this.name = 'TransitionNamespaceCopyError';
  }

  public readonly code: 'budget_invalid' | 'file_size_mismatch' | 'invalid_directory_page' | 'invalid_entry_name' | 'invalid_symlink_target' | 'path_too_deep' | 'source_changed';
}

function validatePolicy({ policy }: { policy: TransitionNamespaceCopyPolicy }): void {
  for (const [label, value] of [
    ['maximum bytes per slice', policy.maximumBytesPerSlice],
    ['maximum directory entries per read', policy.maximumDirectoryEntriesPerRead],
    ['maximum operations per slice', policy.maximumOperationsPerSlice],
    ['maximum path components', policy.maximumPathComponents],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TransitionNamespaceCopyError({ code: 'budget_invalid', message: `${label} must be a positive safe integer` });
    }
  }
}

function appendPath({ maximumPathComponents, name, path }: {
  maximumPathComponents: number;
  name: string;
  path: TransitionNamespacePath;
}): TransitionNamespacePath {
  try {
    validateTransitionNamespaceEntryName({ name });
  } catch (cause: unknown) {
    if (cause instanceof TransitionNamespaceContractError) {
      throw new TransitionNamespaceCopyError({ code: cause.code, message: cause.message });
    }
    throw cause;
  }
  if (path.length >= maximumPathComponents) {
    throw new TransitionNamespaceCopyError({ code: 'path_too_deep', message: 'namespace copy path exceeds its explicit component bound' });
  }
  return [...path, name];
}

export function createTransitionNamespaceCopyCursor(): TransitionNamespaceCopyCursor {
  return {
    activeFile: undefined,
    completedBytes: 0n,
    completedEntries: 0n,
    directories: [{ afterName: undefined, path: [] }],
    state: 'copying',
  };
}

export async function runTransitionNamespaceCopySlice({ cursor, policy, signal, source, target }: {
  cursor: TransitionNamespaceCopyCursor;
  policy: TransitionNamespaceCopyPolicy;
  signal: AbortSignal | undefined;
  source: TransitionNamespaceSourcePort;
  target: TransitionNamespaceTargetPort;
}): Promise<TransitionNamespaceCopyCursor> {
  validatePolicy({ policy });
  switch (cursor.state) {
  case 'complete': return cursor;
  case 'copying': break;
  default: return cursor.state satisfies never;
  }
  let activeFile = cursor.activeFile;
  let completedBytes = cursor.completedBytes;
  let completedEntries = cursor.completedEntries;
  const directories: TransitionNamespaceDirectoryFrame[] = cursor.directories.map(frame => ({
    afterName: frame.afterName,
    path: [...frame.path],
  }));
  const rootMetadata = await source.readRootMetadata();
  await target.setRootMetadata({ metadata: rootMetadata });

  let remainingBytes = policy.maximumBytesPerSlice;
  let remainingOperations = policy.maximumOperationsPerSlice;

  while (remainingOperations > 0 && remainingBytes > 0) {
    signal?.throwIfAborted();
    if (activeFile !== undefined) {
      const remainingFileBytes = activeFile.size - activeFile.offset;
      if (remainingFileBytes < 0n) {
        throw new TransitionNamespaceCopyError({ code: 'source_changed', message: 'active file offset exceeds captured file size' });
      }
      if (remainingFileBytes === 0n) {
        await target.finalizeFile({ metadata: activeFile.metadata, path: activeFile.path, size: activeFile.size });
        activeFile = undefined;
        completedEntries += 1n;
        remainingOperations -= 1;
        continue;
      }
      const maximumBytes = Number(remainingFileBytes < BigInt(remainingBytes) ? remainingFileBytes : BigInt(remainingBytes));
      const result = await source.readFileChunk({ maximumBytes, offset: activeFile.offset, path: activeFile.path });
      if (result.bytes.byteLength === 0 || result.bytes.byteLength > maximumBytes) {
        throw new TransitionNamespaceCopyError({ code: 'file_size_mismatch', message: 'source returned an invalid file chunk length' });
      }
      const nextOffset = activeFile.offset + BigInt(result.bytes.byteLength);
      if ((result.state === 'complete' && nextOffset !== activeFile.size)
        || (result.state === 'more' && nextOffset >= activeFile.size)) {
        throw new TransitionNamespaceCopyError({ code: 'file_size_mismatch', message: 'source file completion does not match its captured size' });
      }
      await target.writeFileChunk({ bytes: result.bytes.slice(), offset: activeFile.offset, path: activeFile.path });
      activeFile = { ...activeFile, offset: nextOffset };
      completedBytes += BigInt(result.bytes.byteLength);
      remainingBytes -= result.bytes.byteLength;
      remainingOperations -= 1;
      continue;
    }

    const frame = directories.at(-1);
    if (frame === undefined) {
      await target.completeNamespace();
      return { activeFile: undefined, completedBytes, completedEntries, directories: [], state: 'complete' };
    }
    const page = await source.listDirectory({
      afterName: frame.afterName,
      maximumEntries: Math.min(policy.maximumDirectoryEntriesPerRead, remainingOperations),
      path: frame.path,
    });
    try {
      validateTransitionNamespaceDirectoryPage({
        afterName: frame.afterName,
        entries: page.entries,
        maximumEntries: Math.min(policy.maximumDirectoryEntriesPerRead, remainingOperations),
        state: page.state,
      });
    } catch (cause: unknown) {
      if (cause instanceof TransitionNamespaceContractError) {
        throw new TransitionNamespaceCopyError({ code: cause.code, message: cause.message });
      }
      throw cause;
    }
    if (page.entries.length === 0) {
      directories.pop();
      remainingOperations -= 1;
      continue;
    }

    for (const entry of page.entries) {
      if (remainingOperations < 1) break;
      const path = appendPath({ maximumPathComponents: policy.maximumPathComponents, name: entry.name, path: frame.path });
      directories[directories.length - 1] = { afterName: entry.name, path: frame.path };
      switch (entry.kind) {
      case 'directory':
        await target.ensureDirectory({ metadata: entry.metadata, path });
        directories.push({ afterName: undefined, path });
        completedEntries += 1n;
        remainingOperations -= 1;
        break;
      case 'file':
        if (entry.size < 0n) throw new TransitionNamespaceCopyError({ code: 'file_size_mismatch', message: 'source file size cannot be negative' });
        activeFile = { metadata: entry.metadata, offset: 0n, path, size: entry.size };
        remainingOperations -= 1;
        break;
      case 'symlink': {
        const linkTarget = await source.readSymlink({ path });
        try {
          validateTransitionSymlinkTarget({ target: linkTarget });
        } catch (cause: unknown) {
          if (cause instanceof TransitionNamespaceContractError) {
            throw new TransitionNamespaceCopyError({ code: cause.code, message: cause.message });
          }
          throw cause;
        }
        await target.writeSymlink({ metadata: entry.metadata, path, target: linkTarget });
        completedEntries += 1n;
        remainingOperations -= 1;
        break;
      }
      default: {
        const unhandled: never = entry;
        throw new Error(`unhandled namespace entry: ${String(unhandled)}`);
      }
      }
      if (activeFile !== undefined || directories.at(-1)?.path === path) break;
    }
  }

  const state: TransitionNamespaceCopyCursor['state'] = directories.length === 0 && activeFile === undefined
    ? 'complete'
    : 'copying';
  switch (state) {
  case 'complete': await target.completeNamespace(); break;
  case 'copying': break;
  default: state satisfies never;
  }
  return {
    activeFile,
    completedBytes,
    completedEntries,
    directories,
    state,
  };
}

export const TEST_ONLY = {
};
