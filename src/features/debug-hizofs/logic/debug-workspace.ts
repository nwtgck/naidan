import type { StorageDirectoryHandle, StorageFileSystemSession } from '@/00-storage/service/storage-file-system/types';
import {
  createHizoFS,
  createHizoFSInspectionReader,
  readHizoFSFileSystemId,
  type HizoFSInspectionReader,
} from '@/00-storage/service/hizofs';

/**
 * This Naidan-specific backing location belongs to the debug feature rather
 * than the generic HizoFS core. The core still accepts an arbitrary
 * directory handle and must not learn about Naidan paths or workspace policy.
 */
const DEBUG_WORKSPACE_DIRECTORY_NAME = 'naidan-debug-hizofs';
const DEBUG_WORKSPACE_DIRECTORY_SUFFIX = '.hizofs';
const DEBUG_WORKSPACE_NAME_PREFIX = 'runtime-';
const ROOT_KEY_BYTE_LENGTH = 32;

type LiveHizoFSDebugWorkspace = {
  readonly workspaceId: string;
  readonly createdAt: number;
  readonly fileSystemId: string;
  readonly backingDirectory: FileSystemDirectoryHandle;
  readonly fileSystemSession: StorageFileSystemSession;
  readonly fileSystemRootKey: Uint8Array;
};

const liveWorkspaces = new Map<string, LiveHizoFSDebugWorkspace>();

export type HizoFSDebugWorkspaceSummary =
  | {
      readonly status: 'live';
      readonly workspaceId: string;
      readonly createdAt: number;
      readonly fileSystemId: string;
      readonly physicalPath: readonly string[];
    }
  | {
      readonly status: 'stale';
      readonly workspaceId: string;
      readonly fileSystemId: string | undefined;
      readonly physicalPath: readonly string[];
    };

export interface HizoFSDebugWorkspaceSession {
  readonly source: Extract<HizoFSDebugWorkspaceSummary, { readonly status: 'live' }>;
  readonly decryptedRoot: StorageDirectoryHandle;
  readonly hizoFSReader: HizoFSInspectionReader;

  dispose(): Promise<void>;
}

/**
 * Creates a disposable HizoFS instance whose root key exists only in
 * this module's memory.
 *
 * The workspace is intentionally independent from Naidan OPFS encryption.
 * Its purpose is to let filesystem developers inspect HizoFS behavior
 * before trusting or enabling encryption for Naidan data. Routing this through
 * key slots, a passphrase, or the Naidan store header would mix credential
 * management into a test environment that only needs one temporary root key.
 */
export async function createHizoFSDebugWorkspace({ nativeOpfsRoot }: {
  nativeOpfsRoot: FileSystemDirectoryHandle | undefined;
}): Promise<Extract<HizoFSDebugWorkspaceSummary, { readonly status: 'live' }>> {
  const opfsRoot = nativeOpfsRoot ?? await navigator.storage.getDirectory();
  const parent = await opfsRoot.getDirectoryHandle(DEBUG_WORKSPACE_DIRECTORY_NAME, { create: true });
  const workspaceId = createWorkspaceId();
  const physicalDirectoryName = getPhysicalDirectoryName({ workspaceId });
  const backingDirectory = await parent.getDirectoryHandle(physicalDirectoryName, { create: true });
  const fileSystemRootKey = crypto.getRandomValues(new Uint8Array(ROOT_KEY_BYTE_LENGTH));

  let fileSystemSession: StorageFileSystemSession | undefined;
  try {
    fileSystemSession = await createHizoFS({
      backingDirectory,
      fileSystemRootKey,
    });
    const fileSystemId = await readHizoFSFileSystemId({ backingDirectory });
    const createdAt = Date.now();
    liveWorkspaces.set(workspaceId, {
      workspaceId,
      createdAt,
      fileSystemId,
      backingDirectory,
      fileSystemSession,
      fileSystemRootKey,
    });
    return createLiveSummary({ workspaceId, createdAt, fileSystemId });
  } catch (error) {
    fileSystemRootKey.fill(0);
    await fileSystemSession?.close().catch(() => undefined);
    await parent.removeEntry(physicalDirectoryName, { recursive: true }).catch(() => undefined);
    throw error;
  }
}

export async function listHizoFSDebugWorkspaces({ nativeOpfsRoot }: {
  nativeOpfsRoot: FileSystemDirectoryHandle | undefined;
}): Promise<readonly HizoFSDebugWorkspaceSummary[]> {
  const result: HizoFSDebugWorkspaceSummary[] = [];
  for (const workspace of liveWorkspaces.values()) {
    result.push(createLiveSummary({
      workspaceId: workspace.workspaceId,
      createdAt: workspace.createdAt,
      fileSystemId: workspace.fileSystemId,
    }));
  }

  const opfsRoot = nativeOpfsRoot ?? await navigator.storage.getDirectory();
  let parent: FileSystemDirectoryHandle;
  try {
    parent = await opfsRoot.getDirectoryHandle(DEBUG_WORKSPACE_DIRECTORY_NAME);
  } catch (error) {
    if (isNotFoundError({ error })) {
      return sortWorkspaceSummaries({ summaries: result });
    }
    throw error;
  }

  for await (const [name, handle] of parent.entries()) {
    let directoryHandle: FileSystemDirectoryHandle;
    switch (handle.kind) {
    case 'directory':
      directoryHandle = handle as FileSystemDirectoryHandle;
      break;
    case 'file':
      continue;
    default: {
      const _ex: never = handle;
      throw new Error(
        `Unhandled file system handle kind: ${((_ex satisfies never) as { readonly kind: string }).kind}`,
      );
    }
    }
    const workspaceId = parseWorkspaceId({ physicalDirectoryName: name });
    if (workspaceId === undefined) {
      continue;
    }
    if (liveWorkspaces.has(workspaceId)) {
      continue;
    }
    let fileSystemId: string | undefined;
    try {
      fileSystemId = await readHizoFSFileSystemId({
        backingDirectory: directoryHandle,
      });
    } catch {
      // A stale debug directory may have been interrupted before descriptor
      // creation. It remains visible so its raw physical state can be audited.
    }
    /**
     * Do not delete a keyless workspace automatically. A crash or reload may
     * itself be the condition under investigation, and filesystem developers
     * may still need to inspect the encrypted backing files through Raw OPFS.
     * The Workbench therefore exposes it as stale and requires explicit
     * deletion even though it can no longer be decrypted.
     */
    result.push({
      status: 'stale',
      workspaceId,
      fileSystemId,
      physicalPath: [DEBUG_WORKSPACE_DIRECTORY_NAME, name],
    });
  }
  return sortWorkspaceSummaries({ summaries: result });
}

export async function openHizoFSDebugWorkspace({ workspaceId }: {
  workspaceId: string;
}): Promise<HizoFSDebugWorkspaceSession> {
  const workspace = liveWorkspaces.get(workspaceId);
  if (workspace === undefined) {
    throw new Error(`HizoFS debug workspace is not live: ${workspaceId}`);
  }
  const hizoFSReader = await createHizoFSInspectionReader({
    backingDirectory: workspace.backingDirectory,
    fileSystemRootKey: workspace.fileSystemRootKey,
  });
  let disposed = false;
  return {
    source: createLiveSummary({
      workspaceId: workspace.workspaceId,
      createdAt: workspace.createdAt,
      fileSystemId: workspace.fileSystemId,
    }),
    decryptedRoot: workspace.fileSystemSession.root,
    hizoFSReader,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await hizoFSReader.dispose();
    },
  };
}

export async function destroyHizoFSDebugWorkspace({ workspaceId, nativeOpfsRoot }: {
  workspaceId: string;
  nativeOpfsRoot: FileSystemDirectoryHandle | undefined;
}): Promise<void> {
  const live = liveWorkspaces.get(workspaceId);
  if (live !== undefined) {
    liveWorkspaces.delete(workspaceId);
    try {
      await live.fileSystemSession.close();
    } finally {
      live.fileSystemRootKey.fill(0);
    }
  }

  const opfsRoot = nativeOpfsRoot ?? await navigator.storage.getDirectory();
  try {
    const parent = await opfsRoot.getDirectoryHandle(DEBUG_WORKSPACE_DIRECTORY_NAME);
    const matchingPhysicalDirectoryNames: string[] = [];
    for await (const [name, handle] of parent.entries()) {
      switch (handle.kind) {
      case 'directory':
        if (parseWorkspaceId({ physicalDirectoryName: name }) === workspaceId) {
          matchingPhysicalDirectoryNames.push(name);
        }
        break;
      case 'file':
        break;
      default: {
        const _ex: never = handle;
        throw new Error(
          `Unhandled file system handle kind: ${((_ex satisfies never) as { readonly kind: string }).kind}`,
        );
      }
      }
    }
    for (const physicalDirectoryName of matchingPhysicalDirectoryNames) {
      await parent.removeEntry(physicalDirectoryName, { recursive: true });
    }
  } catch (error) {
    if (!isNotFoundError({ error })) {
      throw error;
    }
  }
}

function createLiveSummary({ workspaceId, createdAt, fileSystemId }: {
  workspaceId: string;
  createdAt: number;
  fileSystemId: string;
}): Extract<HizoFSDebugWorkspaceSummary, { readonly status: 'live' }> {
  return {
    status: 'live',
    workspaceId,
    createdAt,
    fileSystemId,
    physicalPath: [DEBUG_WORKSPACE_DIRECTORY_NAME, getPhysicalDirectoryName({ workspaceId })],
  };
}

function sortWorkspaceSummaries({ summaries }: {
  summaries: readonly HizoFSDebugWorkspaceSummary[];
}): readonly HizoFSDebugWorkspaceSummary[] {
  return [...summaries].sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
}

function createWorkspaceId(): string {
  return crypto.randomUUID();
}

function getPhysicalDirectoryName({ workspaceId }: { workspaceId: string }): string {
  return `${DEBUG_WORKSPACE_NAME_PREFIX}${workspaceId}${DEBUG_WORKSPACE_DIRECTORY_SUFFIX}`;
}

function parseWorkspaceId({ physicalDirectoryName }: {
  physicalDirectoryName: string;
}): string | undefined {
  if (!physicalDirectoryName.startsWith(DEBUG_WORKSPACE_NAME_PREFIX)) {
    return undefined;
  }
  const nameAfterPrefix = physicalDirectoryName.slice(DEBUG_WORKSPACE_NAME_PREFIX.length);
  const suffixSeparatorIndex = nameAfterPrefix.indexOf('.');
  const workspaceId = suffixSeparatorIndex === -1
    ? nameAfterPrefix
    : nameAfterPrefix.slice(0, suffixSeparatorIndex);
  return workspaceId.length === 0 ? undefined : workspaceId;
}


function isNotFoundError({ error }: { error: unknown }): boolean {
  return error instanceof DOMException
    ? error.name === 'NotFoundError'
    : error instanceof Error && error.name === 'NotFoundError';
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  DEBUG_WORKSPACE_DIRECTORY_NAME,
  getPhysicalDirectoryName,
};
