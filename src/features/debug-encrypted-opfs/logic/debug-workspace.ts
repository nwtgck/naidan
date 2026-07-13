import type { StorageDirectoryHandle, StorageFileSystemSession } from '@/00-storage/service/storage-file-system/types';
import {
  createEncryptedOpfs,
  createEncryptedOpfsInspectionReader,
  readEncryptedOpfsFileSystemId,
  type EncryptedOpfsInspectionReader,
} from '@/00-storage/service/encrypted-opfs';

/**
 * This Naidan-specific backing location belongs to the debug feature rather
 * than the generic EncryptedOpfs core. The core still accepts an arbitrary
 * directory handle and must not learn about Naidan paths or workspace policy.
 */
const DEBUG_WORKSPACE_DIRECTORY_NAME = 'naidan-debug-encrypted-opfs';
const ROOT_KEY_BYTE_LENGTH = 32;

type LiveEncryptedOpfsDebugWorkspace = {
  readonly workspaceId: string;
  readonly createdAt: number;
  readonly fileSystemId: string;
  readonly backingDirectory: FileSystemDirectoryHandle;
  readonly fileSystemSession: StorageFileSystemSession;
  readonly fileSystemRootKey: Uint8Array;
};

const liveWorkspaces = new Map<string, LiveEncryptedOpfsDebugWorkspace>();

export type EncryptedOpfsDebugWorkspaceSummary =
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

export interface EncryptedOpfsDebugWorkspaceSession {
  readonly source: Extract<EncryptedOpfsDebugWorkspaceSummary, { readonly status: 'live' }>;
  readonly decryptedRoot: StorageDirectoryHandle;
  readonly encryptedOpfsReader: EncryptedOpfsInspectionReader;

  dispose(): Promise<void>;
}

/**
 * Creates a disposable EncryptedOpfs instance whose root key exists only in
 * this module's memory.
 *
 * The workspace is intentionally independent from Naidan OPFS encryption.
 * Its purpose is to let filesystem developers inspect EncryptedOpfs behavior
 * before trusting or enabling encryption for Naidan data. Routing this through
 * key slots, a passphrase, or the Naidan store header would mix credential
 * management into a test environment that only needs one temporary root key.
 */
export async function createEncryptedOpfsDebugWorkspace({ nativeOpfsRoot }: {
  nativeOpfsRoot: FileSystemDirectoryHandle | undefined;
}): Promise<Extract<EncryptedOpfsDebugWorkspaceSummary, { readonly status: 'live' }>> {
  const opfsRoot = nativeOpfsRoot ?? await navigator.storage.getDirectory();
  const parent = await opfsRoot.getDirectoryHandle(DEBUG_WORKSPACE_DIRECTORY_NAME, { create: true });
  const workspaceId = createWorkspaceId();
  const physicalDirectoryName = getPhysicalDirectoryName({ workspaceId });
  const backingDirectory = await parent.getDirectoryHandle(physicalDirectoryName, { create: true });
  const fileSystemRootKey = crypto.getRandomValues(new Uint8Array(ROOT_KEY_BYTE_LENGTH));

  let fileSystemSession: StorageFileSystemSession | undefined;
  try {
    fileSystemSession = await createEncryptedOpfs({
      backingDirectory,
      fileSystemRootKey,
    });
    const fileSystemId = await readEncryptedOpfsFileSystemId({ backingDirectory });
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

export async function listEncryptedOpfsDebugWorkspaces({ nativeOpfsRoot }: {
  nativeOpfsRoot: FileSystemDirectoryHandle | undefined;
}): Promise<readonly EncryptedOpfsDebugWorkspaceSummary[]> {
  const result: EncryptedOpfsDebugWorkspaceSummary[] = [];
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
    if (handle.kind !== 'directory' || !name.startsWith('runtime-')) {
      continue;
    }
    const workspaceId = name.slice('runtime-'.length);
    if (liveWorkspaces.has(workspaceId)) {
      continue;
    }
    let fileSystemId: string | undefined;
    try {
      fileSystemId = await readEncryptedOpfsFileSystemId({
        backingDirectory: handle as FileSystemDirectoryHandle,
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

export async function openEncryptedOpfsDebugWorkspace({ workspaceId }: {
  workspaceId: string;
}): Promise<EncryptedOpfsDebugWorkspaceSession> {
  const workspace = liveWorkspaces.get(workspaceId);
  if (workspace === undefined) {
    throw new Error(`EncryptedOpfs debug workspace is not live: ${workspaceId}`);
  }
  const encryptedOpfsReader = await createEncryptedOpfsInspectionReader({
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
    encryptedOpfsReader,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await encryptedOpfsReader.dispose();
    },
  };
}

export async function destroyEncryptedOpfsDebugWorkspace({ workspaceId, nativeOpfsRoot }: {
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
    await parent.removeEntry(getPhysicalDirectoryName({ workspaceId }), { recursive: true });
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
}): Extract<EncryptedOpfsDebugWorkspaceSummary, { readonly status: 'live' }> {
  return {
    status: 'live',
    workspaceId,
    createdAt,
    fileSystemId,
    physicalPath: [DEBUG_WORKSPACE_DIRECTORY_NAME, getPhysicalDirectoryName({ workspaceId })],
  };
}

function sortWorkspaceSummaries({ summaries }: {
  summaries: readonly EncryptedOpfsDebugWorkspaceSummary[];
}): readonly EncryptedOpfsDebugWorkspaceSummary[] {
  return [...summaries].sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
}

function createWorkspaceId(): string {
  return crypto.randomUUID();
}

function getPhysicalDirectoryName({ workspaceId }: { workspaceId: string }): string {
  return `runtime-${workspaceId}`;
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
};
