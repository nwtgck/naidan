import { promiseAllKeyed } from '@/utils/promise';
import {
  TransitionNamespaceContractError,
  validateTransitionNamespaceDirectoryPage,
  validateTransitionNamespaceEntryName,
  validateTransitionSymlinkTarget,
} from '@/00-storage/service/naidan-persistence-control/transition/namespace-contracts';
import type {
  TransitionNamespaceActiveFile,
  TransitionNamespaceDirectoryFrame,
  TransitionNamespaceEntry,
  TransitionNamespacePath,
  TransitionNamespaceSourcePort,
} from '@/00-storage/service/naidan-persistence-control/transition/namespace-copy';

export type TransitionNamespaceVerificationCursor = Readonly<{
  activeFile: TransitionNamespaceActiveFile | undefined;
  directories: readonly TransitionNamespaceDirectoryFrame[];
  state: 'complete' | 'verifying';
  verifiedBytes: bigint;
  verifiedEntries: bigint;
}>;

export type TransitionNamespaceVerificationPolicy = Readonly<{
  maximumBytesPerSlice: number;
  maximumDirectoryEntriesPerRead: number;
  maximumOperationsPerSlice: number;
  maximumPathComponents: number;
}>;

export class TransitionNamespaceVerificationError extends Error {
  public constructor({ code, message }: {
    code: 'budget_invalid' | 'content_mismatch' | 'directory_mismatch' | 'invalid_directory_page' | 'invalid_entry_name' | 'invalid_symlink_target' | 'metadata_mismatch' | 'path_too_deep' | 'source_changed';
    message: string;
  }) {
    super(message);
    this.code = code;
    this.name = 'TransitionNamespaceVerificationError';
  }

  public readonly code: 'budget_invalid' | 'content_mismatch' | 'directory_mismatch' | 'invalid_directory_page' | 'invalid_entry_name' | 'invalid_symlink_target' | 'metadata_mismatch' | 'path_too_deep' | 'source_changed';
}

function validatePolicy({ policy }: { policy: TransitionNamespaceVerificationPolicy }): void {
  for (const value of [
    policy.maximumBytesPerSlice,
    policy.maximumDirectoryEntriesPerRead,
    policy.maximumOperationsPerSlice,
    policy.maximumPathComponents,
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TransitionNamespaceVerificationError({ code: 'budget_invalid', message: 'verification budgets must be positive safe integers' });
    }
  }
}

function sameMetadata({ left, right }: {
  left: TransitionNamespaceEntry['metadata'];
  right: TransitionNamespaceEntry['metadata'];
}): boolean {
  return left.createdAt === right.createdAt && left.modifiedAt === right.modifiedAt;
}

function compareEntries({ sourceEntries, targetEntries }: {
  sourceEntries: readonly TransitionNamespaceEntry[];
  targetEntries: readonly TransitionNamespaceEntry[];
}): void {
  if (sourceEntries.length !== targetEntries.length) {
    throw new TransitionNamespaceVerificationError({ code: 'directory_mismatch', message: 'source and target directory page lengths differ' });
  }
  for (let index = 0; index < sourceEntries.length; index += 1) {
    const sourceEntry = sourceEntries[index];
    const targetEntry = targetEntries[index];
    if (sourceEntry === undefined || targetEntry === undefined
      || sourceEntry.name !== targetEntry.name || sourceEntry.kind !== targetEntry.kind) {
      throw new TransitionNamespaceVerificationError({ code: 'directory_mismatch', message: 'source and target directory entries differ' });
    }
    if (!sameMetadata({ left: sourceEntry.metadata, right: targetEntry.metadata })) {
      throw new TransitionNamespaceVerificationError({ code: 'metadata_mismatch', message: 'source and target entry metadata differ' });
    }
    switch (sourceEntry.kind) {
    case 'directory': break;
    case 'file': {
      if (targetEntry.kind !== 'file' || sourceEntry.size !== targetEntry.size) {
        throw new TransitionNamespaceVerificationError({ code: 'content_mismatch', message: 'source and target file sizes differ' });
      }
      break;
    }
    case 'symlink': break;
    default: return sourceEntry satisfies never;
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
      throw new TransitionNamespaceVerificationError({ code: cause.code, message: cause.message });
    }
    throw cause;
  }
  if (path.length >= maximumPathComponents) {
    throw new TransitionNamespaceVerificationError({ code: 'path_too_deep', message: 'verification path exceeds its explicit component bound' });
  }
  return [...path, name];
}

function equalBytes({ left, right }: { left: Uint8Array; right: Uint8Array }): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function createTransitionNamespaceVerificationCursor(): TransitionNamespaceVerificationCursor {
  return {
    activeFile: undefined,
    directories: [{ afterName: undefined, path: [] }],
    state: 'verifying',
    verifiedBytes: 0n,
    verifiedEntries: 0n,
  };
}

export async function runTransitionNamespaceVerificationSlice({ cursor, policy, signal, source, target }: {
  cursor: TransitionNamespaceVerificationCursor;
  policy: TransitionNamespaceVerificationPolicy;
  signal: AbortSignal | undefined;
  source: TransitionNamespaceSourcePort;
  target: TransitionNamespaceSourcePort;
}): Promise<TransitionNamespaceVerificationCursor> {
  validatePolicy({ policy });
  switch (cursor.state) {
  case 'complete': return cursor;
  case 'verifying': break;
  default: return cursor.state satisfies never;
  }
  const { sourceRootMetadata, targetRootMetadata } = await promiseAllKeyed({
    sourceRootMetadata: source.readRootMetadata(),
    targetRootMetadata: target.readRootMetadata(),
  });
  if (!sameMetadata({ left: sourceRootMetadata, right: targetRootMetadata })) {
    throw new TransitionNamespaceVerificationError({ code: 'metadata_mismatch', message: 'source and target root directory metadata differ' });
  }

  let activeFile = cursor.activeFile;
  const directories: TransitionNamespaceDirectoryFrame[] = cursor.directories.map(frame => ({
    afterName: frame.afterName,
    path: [...frame.path],
  }));
  let verifiedBytes = cursor.verifiedBytes;
  let verifiedEntries = cursor.verifiedEntries;
  let remainingBytes = policy.maximumBytesPerSlice;
  let remainingOperations = policy.maximumOperationsPerSlice;

  while (remainingOperations > 0 && remainingBytes > 0) {
    signal?.throwIfAborted();
    if (activeFile !== undefined) {
      const remaining = activeFile.size - activeFile.offset;
      if (remaining < 0n) throw new TransitionNamespaceVerificationError({ code: 'source_changed', message: 'verification offset exceeds captured file size' });
      if (remaining === 0n) {
        activeFile = undefined;
        verifiedEntries += 1n;
        remainingOperations -= 1;
        continue;
      }
      const maximumBytes = Number(remaining < BigInt(remainingBytes) ? remaining : BigInt(remainingBytes));
      const { sourceChunk, targetChunk } = await promiseAllKeyed({
        sourceChunk: source.readFileChunk({ maximumBytes, offset: activeFile.offset, path: activeFile.path }),
        targetChunk: target.readFileChunk({ maximumBytes, offset: activeFile.offset, path: activeFile.path }),
      });
      if (sourceChunk.bytes.byteLength > maximumBytes || targetChunk.bytes.byteLength > maximumBytes) {
        throw new TransitionNamespaceVerificationError({ code: 'source_changed', message: 'verification endpoint exceeded the requested bounded chunk length' });
      }
      if (!equalBytes({ left: sourceChunk.bytes, right: targetChunk.bytes }) || sourceChunk.state !== targetChunk.state) {
        throw new TransitionNamespaceVerificationError({ code: 'content_mismatch', message: 'source and target file chunks differ' });
      }
      const nextOffset = activeFile.offset + BigInt(sourceChunk.bytes.byteLength);
      if (sourceChunk.bytes.byteLength < 1
        || (sourceChunk.state === 'complete' && nextOffset !== activeFile.size)
        || (sourceChunk.state === 'more' && nextOffset >= activeFile.size)) {
        throw new TransitionNamespaceVerificationError({ code: 'source_changed', message: 'file completion no longer matches captured size' });
      }
      activeFile = { ...activeFile, offset: nextOffset };
      verifiedBytes += BigInt(sourceChunk.bytes.byteLength);
      remainingBytes -= sourceChunk.bytes.byteLength;
      remainingOperations -= 1;
      continue;
    }

    const frame = directories.at(-1);
    if (frame === undefined) {
      return { activeFile: undefined, directories: [], state: 'complete', verifiedBytes, verifiedEntries };
    }
    const maximumEntries = Math.min(policy.maximumDirectoryEntriesPerRead, remainingOperations);
    const { sourcePage, targetPage } = await promiseAllKeyed({
      sourcePage: source.listDirectory({ afterName: frame.afterName, maximumEntries, path: frame.path }),
      targetPage: target.listDirectory({ afterName: frame.afterName, maximumEntries, path: frame.path }),
    });
    try {
      validateTransitionNamespaceDirectoryPage({ afterName: frame.afterName, entries: sourcePage.entries, maximumEntries, state: sourcePage.state });
      validateTransitionNamespaceDirectoryPage({ afterName: frame.afterName, entries: targetPage.entries, maximumEntries, state: targetPage.state });
    } catch (cause: unknown) {
      if (cause instanceof TransitionNamespaceContractError) {
        throw new TransitionNamespaceVerificationError({ code: cause.code, message: cause.message });
      }
      throw cause;
    }
    if (sourcePage.state !== targetPage.state) {
      throw new TransitionNamespaceVerificationError({ code: 'directory_mismatch', message: 'source and target directory completion differs' });
    }
    compareEntries({ sourceEntries: sourcePage.entries, targetEntries: targetPage.entries });
    if (sourcePage.entries.length === 0) {
      switch (sourcePage.state) {
      case 'complete': break;
      case 'more':
        throw new TransitionNamespaceVerificationError({ code: 'directory_mismatch', message: 'empty nonterminal directory page is invalid' });
      default: return sourcePage.state satisfies never;
      }
      directories.pop();
      remainingOperations -= 1;
      continue;
    }
    for (const sourceEntry of sourcePage.entries) {
      if (remainingOperations < 1) break;
      const path = appendPath({ maximumPathComponents: policy.maximumPathComponents, name: sourceEntry.name, path: frame.path });
      directories[directories.length - 1] = { afterName: sourceEntry.name, path: frame.path };
      switch (sourceEntry.kind) {
      case 'directory':
        directories.push({ afterName: undefined, path });
        verifiedEntries += 1n;
        remainingOperations -= 1;
        break;
      case 'file':
        activeFile = { metadata: sourceEntry.metadata, offset: 0n, path, size: sourceEntry.size };
        remainingOperations -= 1;
        break;
      case 'symlink': {
        const { sourceTarget, targetTarget } = await promiseAllKeyed({
          sourceTarget: source.readSymlink({ path }),
          targetTarget: target.readSymlink({ path }),
        });
        try {
          validateTransitionSymlinkTarget({ target: sourceTarget });
          validateTransitionSymlinkTarget({ target: targetTarget });
        } catch (cause: unknown) {
          if (cause instanceof TransitionNamespaceContractError) {
            throw new TransitionNamespaceVerificationError({ code: cause.code, message: cause.message });
          }
          throw cause;
        }
        if (sourceTarget !== targetTarget) {
          throw new TransitionNamespaceVerificationError({ code: 'content_mismatch', message: 'source and target symbolic link targets differ' });
        }
        verifiedEntries += 1n;
        remainingOperations -= 1;
        break;
      }
      default: return sourceEntry satisfies never;
      }
      if (activeFile !== undefined || directories.at(-1)?.path === path) break;
    }
  }

  return {
    activeFile,
    directories,
    state: directories.length === 0 && activeFile === undefined ? 'complete' : 'verifying',
    verifiedBytes,
    verifiedEntries,
  };
}

export const TEST_ONLY = {
  compareEntries,
};
