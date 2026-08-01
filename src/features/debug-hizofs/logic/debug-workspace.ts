import type {
  StorageDirectoryHandle,
  StorageFileSystemSession,
} from '@/00-storage/service/storage-file-system/types';

const DEBUG_WORKSPACE_DIRECTORY_NAME = 'naidan-debug-hizofs';
const DEBUG_WORKSPACE_DIRECTORY_SUFFIX = '.hizofs';
const DEBUG_WORKSPACE_NAME_PREFIX = 'runtime-';
const ROOT_KEY_BYTE_LENGTH = 32;

export type HizoFSDebugWorkspaceProduct = {
  readonly fileSystemId: string;
  readonly fileSystemSession: StorageFileSystemSession;
};

/**
 * Creates an isolated, disposable HizoFS workspace for low-level inspection.
 *
 * The workspace generates its own temporary root key and does not register
 * credentials, routing authority, or persistence state with Naidan. Developers
 * can therefore inspect HizoFS independently of the filesystem that stores
 * Naidan data.
 *
 * Construction remains behind an injected authority so this debug feature does
 * not own persisted-format policy, cryptographic composition, or physical-store
 * implementation. This module owns the original root-key buffer that it passes
 * to the authority and clears that buffer when creation fails or the workspace
 * is destroyed. The authority remains responsible for the lifetime of any
 * internal key material derived or copied from that input.
 */
export interface HizoFSDebugWorkspaceAuthority {
  create({ backingDirectory, fileSystemRootKey }: {
    backingDirectory: FileSystemDirectoryHandle;
    fileSystemRootKey: Uint8Array;
  }): Promise<HizoFSDebugWorkspaceProduct>;
}

type LiveHizoFSDebugWorkspace = {
  readonly workspaceId: string;
  readonly createdAt: number;
  readonly fileSystemId: string;
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
      readonly fileSystemId: undefined;
      readonly physicalPath: readonly string[];
    };

export interface HizoFSDebugWorkspaceSession {
  readonly source: Extract<HizoFSDebugWorkspaceSummary, { readonly status: 'live' }>;
  readonly decryptedRoot: StorageDirectoryHandle;

  dispose(): Promise<void>;
}

export async function createHizoFSDebugWorkspace({ authority, nativeOpfsRoot }: {
  authority: HizoFSDebugWorkspaceAuthority;
  nativeOpfsRoot: FileSystemDirectoryHandle | undefined;
}): Promise<Extract<HizoFSDebugWorkspaceSummary, { readonly status: 'live' }>> {
  const opfsRoot = nativeOpfsRoot ?? await navigator.storage.getDirectory();
  const parent = await opfsRoot.getDirectoryHandle(DEBUG_WORKSPACE_DIRECTORY_NAME, { create: true });
  const workspaceId = createWorkspaceId();
  const physicalDirectoryName = getPhysicalDirectoryName({ workspaceId });
  const backingDirectory = await parent.getDirectoryHandle(physicalDirectoryName, { create: true });
  const fileSystemRootKey = crypto.getRandomValues(new Uint8Array(ROOT_KEY_BYTE_LENGTH));

  let product: HizoFSDebugWorkspaceProduct | undefined;
  try {
    product = await authority.create({ backingDirectory, fileSystemRootKey });
    const createdAt = Date.now();
    liveWorkspaces.set(workspaceId, {
      workspaceId,
      createdAt,
      fileSystemId: product.fileSystemId,
      fileSystemSession: product.fileSystemSession,
      fileSystemRootKey,
    });
    return createLiveSummary({
      workspaceId,
      createdAt,
      fileSystemId: product.fileSystemId,
    });
  } catch (error) {
    fileSystemRootKey.fill(0);
    await product?.fileSystemSession.close().catch(() => undefined);
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
    if (isNotFoundError({ error })) return sortWorkspaceSummaries({ summaries: result });
    throw error;
  }

  for await (const [name, handle] of parent.entries()) {
    switch (handle.kind) {
    case 'directory':
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
    if (workspaceId === undefined || liveWorkspaces.has(workspaceId)) continue;
    result.push({
      status: 'stale',
      workspaceId,
      fileSystemId: undefined,
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
  return {
    source: createLiveSummary({
      workspaceId: workspace.workspaceId,
      createdAt: workspace.createdAt,
      fileSystemId: workspace.fileSystemId,
    }),
    decryptedRoot: workspace.fileSystemSession.root,
    async dispose() {},
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
    const matchingNames: string[] = [];
    for await (const [name, handle] of parent.entries()) {
      switch (handle.kind) {
      case 'directory':
        if (parseWorkspaceId({ physicalDirectoryName: name }) === workspaceId) matchingNames.push(name);
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
    for (const physicalDirectoryName of matchingNames) {
      await parent.removeEntry(physicalDirectoryName, { recursive: true });
    }
  } catch (error) {
    if (!isNotFoundError({ error })) throw error;
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
  if (!physicalDirectoryName.startsWith(DEBUG_WORKSPACE_NAME_PREFIX)) return undefined;
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
