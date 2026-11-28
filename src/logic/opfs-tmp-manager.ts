import { openDirectoryPath } from '@/utils/file-system-directory-path';
import { localStorageFormat, opfsFormat } from '@/00-format/01-layout/layout';
import { generateId } from '@/01-models/id';
import type { OPFSTmpDirectoryId, OPFSTmpOwnerScopeId } from '@/01-models/ids';
import { OPFS_TMP_CLEANUP_LOCK_KEY } from '@/constants';
import { StorageSynchronizer } from '@/00-storage/service/synchronizer';

type PendingOwnerCleanup = {
  ownerScopeIds: OPFSTmpOwnerScopeId[],
};

function isNotFoundError({ error }: { error: unknown }): boolean {
  return error instanceof Error && error.name === 'NotFoundError';
}

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function hasLocalStorage(): boolean {
  return typeof localStorage !== 'undefined';
}

class OPFSTmpManager {
  private readonly ownerScopeId = generateId<OPFSTmpOwnerScopeId>();
  private readonly synchronizer = new StorageSynchronizer();
  private pendingCleanupQueued = false;
  private activeFlush: Promise<void> | null = null;
  private readonly beforeUnloadHandler = () => {
    this.scheduleOwnScopeCleanup();
  };
  private readonly pageHideHandler = () => {
    this.scheduleOwnScopeCleanup();
  };
  private readonly storageHandler: NonNullable<Window['onstorage']> = (event) => {
    if (event.key !== localStorageFormat.pendingTmpCleanups.key) {
      return;
    }
    void this.flushPendingScopeCleanups();
  };

  constructor() {
    if (hasWindow()) {
      window.addEventListener('beforeunload', this.beforeUnloadHandler);
      window.addEventListener('pagehide', this.pageHideHandler);
      window.addEventListener('storage', this.storageHandler);
      void this.flushPendingScopeCleanups();
    }
  }

  async createTmpDirectory({ prefix }: { prefix: string }): Promise<FileSystemDirectoryHandle> {
    const opfsRoot = await navigator.storage.getDirectory();
    const ownerPath = opfsFormat.tmp.owner({ id: this.ownerScopeId }).path;
    const ownerRoot = await openDirectoryPath({ root: opfsRoot, path: ownerPath, create: true });
    const tmpDirectoryId = generateId<OPFSTmpDirectoryId>();
    const tmpDirName = opfsFormat.tmp.directoryName({ prefix, id: tmpDirectoryId });
    const handle = await ownerRoot.getDirectoryHandle(tmpDirName, { create: true });
    void this.flushPendingScopeCleanups();
    return handle;
  }

  createWorkflowResultsDirectory(): Promise<FileSystemDirectoryHandle> {
    return opfsFormat.tmp.workflowResults.createDirectory({
      createTmpDirectory: ({ prefix }) => this.createTmpDirectory({ prefix }),
    });
  }

  async flushPendingScopeCleanups(): Promise<void> {
    if (this.activeFlush) {
      return this.activeFlush;
    }

    this.activeFlush = this.synchronizer.withLock({
      fn: async () => {
        const pending = this.readPendingOwnerCleanups();
        if (pending.ownerScopeIds.length === 0) {
          return;
        }

        const remainingOwnerScopeIds: OPFSTmpOwnerScopeId[] = [];
        for (const ownerScopeId of pending.ownerScopeIds) {
          const deleted = await this.deleteOwnerScopeDirectory({ ownerScopeId });
          if (!deleted) {
            remainingOwnerScopeIds.push(ownerScopeId);
          }
        }

        this.writePendingOwnerCleanups({
          ownerScopeIds: remainingOwnerScopeIds,
        });
      },
      lockKey: OPFS_TMP_CLEANUP_LOCK_KEY,
    }).finally(() => {
      this.activeFlush = null;
    });

    return this.activeFlush;
  }

  dispose() {
    if (!hasWindow()) {
      return;
    }

    window.removeEventListener('beforeunload', this.beforeUnloadHandler);
    window.removeEventListener('pagehide', this.pageHideHandler);
    window.removeEventListener('storage', this.storageHandler);
  }

  private scheduleOwnScopeCleanup() {
    if (this.pendingCleanupQueued) {
      return;
    }
    this.pendingCleanupQueued = true;

    const pending = this.readPendingOwnerCleanups();
    if (pending.ownerScopeIds.includes(this.ownerScopeId)) {
      return;
    }

    this.writePendingOwnerCleanups({
      ownerScopeIds: [...pending.ownerScopeIds, this.ownerScopeId],
    });
  }

  private readPendingOwnerCleanups(): PendingOwnerCleanup {
    if (!hasLocalStorage()) {
      return { ownerScopeIds: [] };
    }

    try {
      return { ownerScopeIds: localStorageFormat.pendingTmpCleanups.read({ storage: localStorage }) };
    } catch {
      return { ownerScopeIds: [] };
    }
  }

  private writePendingOwnerCleanups({ ownerScopeIds }: { ownerScopeIds: PendingOwnerCleanup['ownerScopeIds'] }) {
    if (!hasLocalStorage()) {
      return;
    }

    localStorageFormat.pendingTmpCleanups.write({ storage: localStorage, ownerScopeIds });
  }

  private async deleteOwnerScopeDirectory({ ownerScopeId }: { ownerScopeId: OPFSTmpOwnerScopeId }): Promise<boolean> {
    try {
      const opfsRoot = await navigator.storage.getDirectory();
      const owner = opfsFormat.tmp.owner({ id: ownerScopeId });
      const parent = await openDirectoryPath({ root: opfsRoot, path: owner.path.slice(0, -1), create: undefined });
      await parent.removeEntry(owner.name, { recursive: true });
      return true;
    } catch (error) {
      if (isNotFoundError({ error })) {
        return true;
      }
      return false;
    }
  }
}

let opfsTmpManagerSingleton: OPFSTmpManager | undefined;

export function getOPFSTmpManager(): OPFSTmpManager {
  if (!opfsTmpManagerSingleton) {
    opfsTmpManagerSingleton = new OPFSTmpManager();
  }
  return opfsTmpManagerSingleton;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  OPFSTmpManager,
};
