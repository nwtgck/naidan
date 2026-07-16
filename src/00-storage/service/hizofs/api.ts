import type {
  HizoFSCommitDto,
  HizoFSDescriptorDto,
  HizoFSSuperblockDto,
} from "@/00-storage/00-dto/hizofs.dto";
import type {
  StorageDirectoryWorkerMountSession,
  StorageDirectoryWorkerMountSource,
  StorageFileSystemSession,
} from "@/00-storage/service/storage-file-system/types";
import { NativeOpfsHizoFSBackingStore } from "./backing-store/native-opfs-backing-store";
import {
  deriveHizoFSFileSystemId,
  importHizoFSRootKey,
  importHizoFSWorkerRootKey,
} from "./crypto/object-crypto";
import {
  createHizoFSDescriptor,
  HizoFSDescriptorCorruptionError,
  getCanonicalHizoFSDescriptor,
  readHizoFSDescriptor,
  restoreHizoFSDescriptor,
} from "./format/descriptor-store";
import { createHizoFSStableId } from "./id";
import { DEFAULT_HIZOFS_POLICY, type HizoFSPolicy } from "./file-system/policy";
import { createHizoFSRuntime } from "./file-system/runtime";
import { HizoFSSession } from "./file-system/session";
import { HizoFSBulkBuilder } from './file-system/bulk-builder';
import type { HizoFSRuntimeDiagnostics } from './file-system/diagnostics';

export async function createHizoFS({
  backingDirectory,
  fileSystemRootKey,
}: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemRootKey: Uint8Array;
}): Promise<StorageFileSystemSession> {
  return createHizoFSInternal({
    backingDirectory,
    fileSystemRootKey,
    policy: DEFAULT_HIZOFS_POLICY,
    now: () => Date.now(),
    diagnostics: undefined,
  });
}

export async function createHizoFSDiagnosticSession({
  backingDirectory,
  fileSystemRootKey,
  policy,
  diagnostics,
}: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemRootKey: Uint8Array;
  policy: HizoFSPolicy;
  diagnostics: HizoFSRuntimeDiagnostics;
}): Promise<StorageFileSystemSession> {
  return createHizoFSInternal({
    backingDirectory,
    fileSystemRootKey,
    policy,
    now: () => Date.now(),
    diagnostics,
  });
}

export async function openHizoFS({
  backingDirectory,
  fileSystemRootKey,
}: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemRootKey: Uint8Array;
}): Promise<StorageFileSystemSession> {
  return openHizoFSInternal({
    backingDirectory,
    fileSystemRootKey,
    policy: DEFAULT_HIZOFS_POLICY,
    now: () => Date.now(),
    diagnostics: undefined,
  });
}

export async function openHizoFSDiagnosticSession({
  backingDirectory,
  fileSystemRootKey,
  policy,
  diagnostics,
}: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemRootKey: Uint8Array;
  policy: HizoFSPolicy;
  diagnostics: HizoFSRuntimeDiagnostics;
}): Promise<StorageFileSystemSession> {
  return openHizoFSInternal({
    backingDirectory,
    fileSystemRootKey,
    policy,
    now: () => Date.now(),
    diagnostics,
  });
}

export async function createHizoFSBulkBuilder({
  fileSystemSession,
}: {
  fileSystemSession: StorageFileSystemSession;
}): Promise<HizoFSBulkBuilder | undefined> {
  if (!(fileSystemSession instanceof HizoFSSession)) {
    return undefined;
  }
  fileSystemSession.assertOpen();
  return await HizoFSBulkBuilder.create({
    runtime: fileSystemSession.runtime,
    rootDirectoryNodeId: fileSystemSession.rootDirectoryNodeId,
  });
}

export async function openHizoFSWorkerMount({
  source,
}: {
  source: StorageDirectoryWorkerMountSource;
}): Promise<StorageDirectoryWorkerMountSession> {
  // The in-module fallback lock is isolated per realm. Allowing it here would
  // let the UI and Wesh Worker publish conflicting commits independently.
  if (
    typeof navigator === "undefined" ||
    navigator.locks?.request === undefined
  ) {
    throw new Error(
      "Worker-local HizoFS mounts require the Web Locks API for cross-realm consistency",
    );
  }
  switch (source.type) {
  case "hizofs":
    return openHizoFSWithImportedRootKey({
      backingDirectory: source.backingDirectory,
      fileSystemId: source.fileSystemId,
      rootKey: source.rootKey,
      rootDirectoryNodeId: source.rootDirectoryNodeId,
      policy: DEFAULT_HIZOFS_POLICY,
      now: () => Date.now(),
    });
  default: {
    const _ex: never = source.type;
    throw new Error(
      `Unhandled storage directory Worker mount: ${String(_ex)}`,
    );
  }
  }
}

export async function deriveHizoFSFileSystemIdFromRawRootKey({
  fileSystemRootKey,
}: {
  fileSystemRootKey: Uint8Array;
}): Promise<string> {
  const rootKey = await importHizoFSRootKey({ rawRootKey: fileSystemRootKey });
  return deriveHizoFSFileSystemId({ rootKey });
}

export interface HizoFSInspection {
  readonly descriptor: HizoFSDescriptorDto;
  readonly fileSystemId: string;
  readonly superblock: HizoFSSuperblockDto;
  readonly activeCommitObjectId: string;
  readonly activeCommit: HizoFSCommitDto;
}

export async function inspectHizoFS({
  backingDirectory,
  fileSystemRootKey,
}: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemRootKey: Uint8Array;
}): Promise<HizoFSInspection> {
  const backingStore = new NativeOpfsHizoFSBackingStore({
    root: backingDirectory,
    diagnostics: undefined,
  });
  let descriptor: HizoFSDescriptorDto;
  try {
    descriptor = await readHizoFSDescriptor({ backingStore })
      ?? getCanonicalHizoFSDescriptor();
  } catch (error) {
    if (!(error instanceof HizoFSDescriptorCorruptionError)) {
      throw error;
    }
    descriptor = getCanonicalHizoFSDescriptor();
  }
  const rootKey = await importHizoFSRootKey({ rawRootKey: fileSystemRootKey });
  const fileSystemId = await deriveHizoFSFileSystemId({ rootKey });
  const runtime = createHizoFSRuntime({
    backingStore,
    rootKey,
    fileSystemId,
    policy: DEFAULT_HIZOFS_POLICY,
    now: () => Date.now(),
    diagnostics: undefined,
  });
  const activeState = await runtime.core.loadActiveState();
  return {
    descriptor,
    fileSystemId,
    superblock: activeState.superblock,
    activeCommitObjectId: activeState.commitObjectId,
    activeCommit: activeState.commit,
  };
}

async function createHizoFSInternal({
  backingDirectory,
  fileSystemRootKey,
  policy,
  now,
  diagnostics,
}: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemRootKey: Uint8Array;
  policy: HizoFSPolicy;
  now: () => number;
  diagnostics?: HizoFSRuntimeDiagnostics;
}): Promise<StorageFileSystemSession> {
  const backingStore = new NativeOpfsHizoFSBackingStore({
    root: backingDirectory,
    diagnostics,
  });
  const rootKey = await importHizoFSRootKey({ rawRootKey: fileSystemRootKey });
  const workerRootKey = await importHizoFSWorkerRootKey({
    rawRootKey: fileSystemRootKey,
  });
  const fileSystemId = await deriveHizoFSFileSystemId({ rootKey });
  await createHizoFSDescriptor({ backingStore });
  const runtime = createHizoFSRuntime({
    backingStore,
    rootKey,
    fileSystemId,
    policy,
    now,
    diagnostics,
  });

  const rootDirectoryNodeId = createHizoFSStableId();
  const timestamp = now();
  const rootInodeObjectId = await runtime.inodeStore.writeDirectory({
    inode: {
      nodeId: rootDirectoryNodeId,
      revision: 0,
      createdAt: timestamp,
      modifiedAt: timestamp,
      storage: { type: "inline", entries: [] },
    },
  });
  const inodeIndexRootObjectId = await runtime.inodeIndex.buildFromSortedEntries({
    entries: [{ nodeId: rootDirectoryNodeId, inodeObjectId: rootInodeObjectId }],
  });
  const commitObjectId = await runtime.commitStore.write({
    commit: {
      revision: 0,
      rootDirectoryNodeId,
      inodeIndexRootObjectId,
    },
  });
  for (const sequence of [0, 1] as const) {
    await runtime.core.superblockStore.write({
      value: {
        sequence,
        fileSystemId,
        activeCommitObjectId: commitObjectId,
      },
    });
  }
  await runtime.core.loadActiveState();
  return new HizoFSSession({
    runtime,
    rootDirectoryNodeId,
    workerMountContext: {
      type: "hizofs",
      backingDirectory,
      fileSystemId,
      rootKey: workerRootKey,
    },
    fixedState: undefined,
    sessionLease: undefined,
  });
}

async function openHizoFSInternal({
  backingDirectory,
  fileSystemRootKey,
  policy,
  now,
  diagnostics,
}: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemRootKey: Uint8Array;
  policy: HizoFSPolicy;
  now: () => number;
  diagnostics?: HizoFSRuntimeDiagnostics;
}): Promise<StorageFileSystemSession> {
  const backingStore = new NativeOpfsHizoFSBackingStore({
    root: backingDirectory,
    diagnostics,
  });
  const rootKey = await importHizoFSRootKey({ rawRootKey: fileSystemRootKey });
  const workerRootKey = await importHizoFSWorkerRootKey({
    rawRootKey: fileSystemRootKey,
  });
  const fileSystemId = await deriveHizoFSFileSystemId({ rootKey });
  const runtime = createHizoFSRuntime({
    backingStore,
    rootKey,
    fileSystemId,
    policy,
    now,
    diagnostics,
  });
  const state = await runtime.core.loadActiveState();
  await restoreHizoFSDescriptor({ backingStore });
  return new HizoFSSession({
    runtime,
    rootDirectoryNodeId: state.commit.rootDirectoryNodeId,
    workerMountContext: {
      type: "hizofs",
      backingDirectory,
      fileSystemId,
      rootKey: workerRootKey,
    },
    fixedState: undefined,
    sessionLease: undefined,
  });
}

async function openHizoFSWithImportedRootKey({
  backingDirectory,
  fileSystemId,
  rootKey,
  rootDirectoryNodeId,
  policy,
  now,
}: {
  backingDirectory: FileSystemDirectoryHandle;
  fileSystemId: string;
  rootKey: CryptoKey;
  rootDirectoryNodeId: string;
  policy: HizoFSPolicy;
  now: () => number;
}): Promise<StorageDirectoryWorkerMountSession> {
  const backingStore = new NativeOpfsHizoFSBackingStore({
    root: backingDirectory,
    diagnostics: undefined,
  });
  const runtime = createHizoFSRuntime({
    backingStore,
    rootKey,
    fileSystemId,
    policy,
    now,
    diagnostics: undefined,
  });
  const state = await runtime.core.loadActiveState();
  await restoreHizoFSDescriptor({ backingStore });
  await runtime.nodeService.readDirectory({
    state,
    nodeId: rootDirectoryNodeId,
  });
  return new HizoFSSession({
    runtime,
    rootDirectoryNodeId,
    workerMountContext: {
      type: "hizofs",
      backingDirectory,
      fileSystemId,
      rootKey,
    },
    fixedState: undefined,
    sessionLease: undefined,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  createHizoFSInternal,
  openHizoFSInternal,
};
