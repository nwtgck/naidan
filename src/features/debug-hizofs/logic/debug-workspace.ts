import type {
  StorageDirectoryHandle,
  StorageFileSystemSession,
} from '@/00-storage/service/storage-file-system/types';
import type { HizoFSAuthenticatedInspectionSession } from '@/features/debug-hizofs/worker/authenticated-inspection-session';

const DEBUG_WORKSPACE_DIRECTORY_NAME = 'naidan-debug-hizofs';
const DEBUG_WORKSPACE_DIRECTORY_SUFFIX = '.hizofs';
const DEBUG_WORKSPACE_NAME_PREFIX = 'runtime-';

export type HizoFSDebugWorkspaceProduct = {
  readonly authenticatedInspectionSession: HizoFSAuthenticatedInspectionSession;
  readonly fileSystemId: string;
  readonly fileSystemSession: StorageFileSystemSession;

  dispose(): Promise<void>;
};

/**
 * Creates an isolated, disposable HizoFS workspace for low-level inspection.
 *
 * Construction remains behind an injected authority so this debug feature does
 * not own persisted-format policy, credential creation, cryptographic
 * composition, or physical-store implementation. The authority must create a
 * normal self-contained HizoFS container and retain any secret-bearing state
 * entirely behind the returned secret-free product surface.
 */
export interface HizoFSDebugWorkspaceAuthority {
  create({ backingDirectory }: {
    backingDirectory: FileSystemDirectoryHandle;
  }): Promise<HizoFSDebugWorkspaceProduct>;
}

type LiveHizoFSDebugWorkspace = {
  readonly authenticatedInspectionSession: HizoFSAuthenticatedInspectionSession;
  readonly workspaceId: string;
  readonly createdAt: number;
  readonly fileSystemId: string;
  readonly fileSystemSession: StorageFileSystemSession;
  readonly disposeProduct: () => Promise<void>;
};

const liveWorkspaces = new Map<string, LiveHizoFSDebugWorkspace>();
const workspaceDestroyAttempts = new Map<string, Promise<void>>();

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
  readonly authenticatedInspectionSession: HizoFSAuthenticatedInspectionSession;
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
  let product: HizoFSDebugWorkspaceProduct | undefined;
  try {
    product = await authority.create({ backingDirectory });
    const createdAt = Date.now();
    liveWorkspaces.set(workspaceId, {
      authenticatedInspectionSession: product.authenticatedInspectionSession,
      workspaceId,
      createdAt,
      fileSystemId: product.fileSystemId,
      fileSystemSession: product.fileSystemSession,
      disposeProduct: product.dispose,
    });
    return createLiveSummary({
      workspaceId,
      createdAt,
      fileSystemId: product.fileSystemId,
    });
  } catch (error) {
    await product?.dispose().catch(() => undefined);
    await parent.removeEntry(physicalDirectoryName, { recursive: true }).catch(() => undefined);
    throw error;
  }
}

export async function listHizoFSDebugWorkspaces({ nativeOpfsRoot }: {
  nativeOpfsRoot: FileSystemDirectoryHandle | undefined;
}): Promise<readonly HizoFSDebugWorkspaceSummary[]> {
  const result: HizoFSDebugWorkspaceSummary[] = [];
  for (const workspace of liveWorkspaces.values()) {
    if (workspaceDestroyAttempts.has(workspace.workspaceId)) continue;
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
    if (workspaceId === undefined
      || liveWorkspaces.has(workspaceId)
      || workspaceDestroyAttempts.has(workspaceId)) continue;
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
  if (workspace === undefined || workspaceDestroyAttempts.has(workspaceId)) {
    throw new Error(`HizoFS debug workspace is not live: ${workspaceId}`);
  }
  return {
    authenticatedInspectionSession: workspace.authenticatedInspectionSession,
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
  const existingAttempt = workspaceDestroyAttempts.get(workspaceId);
  if (existingAttempt !== undefined) {
    await existingAttempt;
    return;
  }
  const attempt = destroyHizoFSDebugWorkspaceOnce({ workspaceId, nativeOpfsRoot });
  workspaceDestroyAttempts.set(workspaceId, attempt);
  try {
    await attempt;
  } finally {
    if (workspaceDestroyAttempts.get(workspaceId) === attempt) {
      workspaceDestroyAttempts.delete(workspaceId);
    }
  }
}

async function destroyHizoFSDebugWorkspaceOnce({ workspaceId, nativeOpfsRoot }: {
  workspaceId: string;
  nativeOpfsRoot: FileSystemDirectoryHandle | undefined;
}): Promise<void> {
  const live = liveWorkspaces.get(workspaceId);
  if (live !== undefined) {
    // WHY: keep the registry entry until disposal succeeds so a failed shutdown
    // remains addressable and can be retried instead of becoming an orphan.
    await live.disposeProduct();
    liveWorkspaces.delete(workspaceId);
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
