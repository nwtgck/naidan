import type { NaidanPersistenceModeV1 } from '@/00-storage/service/naidan-persistence-control/00-format';
import type { StorageDirectoryHandle, StorageFileSystemSession } from '@/00-storage/service/storage-file-system/types';
import type { HizoFSAuthenticatedInspectionSession } from '@/00-storage/service/hizofs/inspection';
import { naidanOpfsContainerOriginRelativePathComponents } from './opfs-storage-location';

type HizoFSMode = Extract<NaidanPersistenceModeV1, { readonly type: 'hizofs' }>;
type FileSystemId = HizoFSMode['activeFileSystemId'];

export interface ActiveHizoFSContainerLocationLease {
  readonly physicalPath: readonly string[];
  assertCurrent(): void;
  dispose(): Promise<void>;
}

export interface ActiveHizoFSDecryptedSnapshotLease {
  readonly root: StorageDirectoryHandle;
  assertCurrent(): void;
  dispose(): Promise<void>;
}

export interface ActiveHizoFSAuthenticatedInspectionSessionLease {
  readonly session: HizoFSAuthenticatedInspectionSession;
  assertCurrent(): void;
  dispose(): Promise<void>;
}

type ActiveReadSnapshot = Pick<StorageFileSystemSession, 'close' | 'root'>;
type ActiveInspectionSession = Readonly<{
  session: HizoFSAuthenticatedInspectionSession;
  close(): Promise<void>;
}>;

type ActiveLocation = {
  active: boolean;
  readonly openAuthenticatedInspectionSession: (() => Promise<ActiveInspectionSession>) | undefined;
  readonly openReadSnapshot: () => Promise<ActiveReadSnapshot>;
  readonly physicalPath: readonly string[];
};

let activeLocation: ActiveLocation | undefined;

function assertActiveLocation({ location }: { location: ActiveLocation }): void {
  if (!location.active || activeLocation !== location) {
    throw new Error('authenticated HizoFS container location is no longer current');
  }
}

/**
 * Publishes only an authenticated container location for the active provider generation.
 *
 * The registry deliberately carries no passphrase, root key, backend, live
 * decrypted root, or write authority. It retains provider-owned factories for
 * a secret-free authenticated inspection session and a stable decrypted read
 * snapshot. The Workbench can therefore observe both persisted and logical
 * state without receiving the live writable session. Exact object identity
 * prevents late cleanup from an old provider generation from removing a newer
 * location.
 */
export function installActiveAuthenticatedHizoFSContainerLocation({
  fileSystemId,
  openAuthenticatedInspectionSession,
  openReadSnapshot,
}: {
  fileSystemId: FileSystemId;
  openAuthenticatedInspectionSession: (() => Promise<ActiveInspectionSession>) | undefined;
  openReadSnapshot: () => Promise<ActiveReadSnapshot>;
}): () => void {
  const location: ActiveLocation = {
    active: true,
    openAuthenticatedInspectionSession,
    openReadSnapshot,
    physicalPath: naidanOpfsContainerOriginRelativePathComponents({ fileSystemId }),
  };
  const previous = activeLocation;
  activeLocation = location;
  if (previous !== undefined) previous.active = false;

  return () => {
    location.active = false;
    if (activeLocation === location) activeLocation = undefined;
  };
}

export async function openActiveAuthenticatedHizoFSContainerLocationLease(): Promise<ActiveHizoFSContainerLocationLease> {
  const location = activeLocation;
  if (location === undefined) {
    throw new Error('authenticated HizoFS container location is unavailable');
  }
  assertActiveLocation({ location });
  let disposed = false;

  return {
    assertCurrent() {
      if (disposed) throw new Error('authenticated HizoFS container location lease is disposed');
      assertActiveLocation({ location });
    },
    async dispose() {
      disposed = true;
    },
    physicalPath: [...location.physicalPath],
  };
}


export async function openActiveAuthenticatedHizoFSInspectionSessionLease(): Promise<ActiveHizoFSAuthenticatedInspectionSessionLease | undefined> {
  const location = activeLocation;
  if (location === undefined) return undefined;
  assertActiveLocation({ location });

  const openAuthenticatedInspectionSession = location.openAuthenticatedInspectionSession;
  if (openAuthenticatedInspectionSession === undefined) return undefined;

  let opened: ActiveInspectionSession | undefined;
  try {
    opened = await openAuthenticatedInspectionSession();
    assertActiveLocation({ location });
  } catch (cause: unknown) {
    if (opened !== undefined) {
      try {
        await opened.close();
      } catch (closeFailure: unknown) {
        throw new AggregateError(
          [cause, closeFailure],
          'authenticated HizoFS inspection session open and cleanup both failed',
        );
      }
    }
    throw cause;
  }

  let disposeRequested = false;
  let closed = false;
  let activeOperations = 0;
  let disposal: Promise<void> | undefined;
  const idleWaiters: Array<() => void> = [];
  const assertCurrent = () => {
    if (disposeRequested) throw new Error('authenticated HizoFS inspection session lease is disposed');
    assertActiveLocation({ location });
  };
  const runCurrent = async <T>({ operation }: { operation: () => Promise<T> }): Promise<T> => {
    assertCurrent();
    activeOperations += 1;
    try {
      const result = await operation();
      assertCurrent();
      return result;
    } finally {
      activeOperations -= 1;
      if (activeOperations === 0) {
        for (const resolve of idleWaiters.splice(0)) resolve();
      }
    }
  };
  const session: HizoFSAuthenticatedInspectionSession = {
    inspectContainer: async () => await runCurrent({
      operation: async () => await opened.session.inspectContainer(),
    }),
    inspectHomeRecord: async ({ maximumPreviewBytes, request }) => await runCurrent({
      operation: async () => await opened.session.inspectHomeRecord({ maximumPreviewBytes, request }),
    }),
    inspectNamespacePath: async ({ maximumDirectoryEntries, maximumPages, pathComponents }) => await runCurrent({
      operation: async () => await opened.session.inspectNamespacePath({ maximumDirectoryEntries, maximumPages, pathComponents }),
    }),
    inspectRecord: async ({ maximumPreviewBytes, request }) => await runCurrent({
      operation: async () => await opened.session.inspectRecord({ maximumPreviewBytes, request }),
    }),
    inspectRecordFrame: async ({ request }) => await runCurrent({
      operation: async () => await opened.session.inspectRecordFrame({ request }),
    }),
  };
  return {
    assertCurrent,
    async dispose() {
      disposeRequested = true;
      if (closed) return;
      disposal ??= (async () => {
        if (activeOperations > 0) {
          await new Promise<void>(resolve => idleWaiters.push(resolve));
        }
        await opened.close();
        closed = true;
      })();
      try {
        await disposal;
      } catch (cause: unknown) {
        disposal = undefined;
        throw cause;
      }
    },
    session,
  };
}

export async function openActiveAuthenticatedHizoFSDecryptedSnapshotLease(): Promise<ActiveHizoFSDecryptedSnapshotLease | undefined> {
  const location = activeLocation;
  if (location === undefined) return undefined;
  assertActiveLocation({ location });

  let snapshot: ActiveReadSnapshot | undefined;
  try {
    snapshot = await location.openReadSnapshot();
    assertActiveLocation({ location });
  } catch (cause: unknown) {
    if (snapshot !== undefined) {
      try {
        await snapshot.close();
      } catch (closeFailure: unknown) {
        throw new AggregateError(
          [cause, closeFailure],
          'authenticated HizoFS decrypted snapshot open and cleanup both failed',
        );
      }
    }
    throw cause;
  }

  let disposeRequested = false;
  let closed = false;
  let disposal: Promise<void> | undefined;
  return {
    assertCurrent() {
      if (disposeRequested) throw new Error('authenticated HizoFS decrypted snapshot lease is disposed');
      assertActiveLocation({ location });
    },
    async dispose() {
      disposeRequested = true;
      if (closed) return;
      disposal ??= snapshot.close().then(() => {
        closed = true;
      });
      try {
        await disposal;
      } catch (cause: unknown) {
        disposal = undefined;
        throw cause;
      }
    },
    root: snapshot.root,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  reset() {
    if (activeLocation !== undefined) activeLocation.active = false;
    activeLocation = undefined;
  },
};
