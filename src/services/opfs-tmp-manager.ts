import { z } from 'zod';
import { generateId } from '@/utils/id';
import { OPFS_TMP_CLEANUP_LOCK_KEY, OPFS_TMP_DIR, OPFS_TMP_PENDING_OWNER_CLEANUPS_KEY } from '@/models/constants';
import { StorageSynchronizer } from '@/services/storage/synchronizer';

const PendingOwnerCleanupSchema = z.object({
  ownerScopeIds: z.array(z.string()),
});

type PendingOwnerCleanup = z.infer<typeof PendingOwnerCleanupSchema>;

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.name === 'NotFoundError';
}

function hasWindow(): boolean {
  return typeof window !== 'undefined';
}

function hasLocalStorage(): boolean {
  return typeof localStorage !== 'undefined';
}

export class OPFSTmpManager {
  private readonly ownerScopeId = generateId();
  private readonly synchronizer = new StorageSynchronizer();
  private pendingCleanupQueued = false;
  private activeFlush: Promise<void> | null = null;
  private readonly beforeUnloadHandler = () => {
    this.scheduleOwnScopeCleanup();
  };
  private readonly pageHideHandler = () => {
    this.scheduleOwnScopeCleanup();
  };
  private readonly storageHandler = (event: StorageEvent) => {
    if (event.key !== OPFS_TMP_PENDING_OWNER_CLEANUPS_KEY) {
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
    const tmpRoot = await opfsRoot.getDirectoryHandle(OPFS_TMP_DIR, { create: true });
    const ownerRoot = await tmpRoot.getDirectoryHandle(this.ownerScopeId, { create: true });
    const tmpDirName = `${prefix}-${generateId()}`;
    const handle = await ownerRoot.getDirectoryHandle(tmpDirName, { create: true });
    void this.flushPendingScopeCleanups();
    return handle;
  }

  async flushPendingScopeCleanups(): Promise<void> {
    if (this.activeFlush) {
      return this.activeFlush;
    }

    this.activeFlush = this.synchronizer.withLock(async () => {
      const pending = this.readPendingOwnerCleanups();
      if (pending.ownerScopeIds.length === 0) {
        return;
      }

      const remainingOwnerScopeIds: string[] = [];
      for (const ownerScopeId of pending.ownerScopeIds) {
        const deleted = await this.deleteOwnerScopeDirectory({ ownerScopeId });
        if (!deleted) {
          remainingOwnerScopeIds.push(ownerScopeId);
        }
      }

      this.writePendingOwnerCleanups({
        ownerScopeIds: remainingOwnerScopeIds,
      });
    }, { lockKey: OPFS_TMP_CLEANUP_LOCK_KEY }).finally(() => {
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
      const raw = localStorage.getItem(OPFS_TMP_PENDING_OWNER_CLEANUPS_KEY);
      if (!raw) {
        return { ownerScopeIds: [] };
      }
      return PendingOwnerCleanupSchema.parse(JSON.parse(raw));
    } catch {
      return { ownerScopeIds: [] };
    }
  }

  private writePendingOwnerCleanups({ ownerScopeIds }: PendingOwnerCleanup) {
    if (!hasLocalStorage()) {
      return;
    }

    localStorage.setItem(
      OPFS_TMP_PENDING_OWNER_CLEANUPS_KEY,
      JSON.stringify(PendingOwnerCleanupSchema.parse({ ownerScopeIds: Array.from(new Set(ownerScopeIds)) })),
    );
  }

  private async deleteOwnerScopeDirectory({ ownerScopeId }: { ownerScopeId: string }): Promise<boolean> {
    try {
      const opfsRoot = await navigator.storage.getDirectory();
      const tmpRoot = await opfsRoot.getDirectoryHandle(OPFS_TMP_DIR);
      await tmpRoot.removeEntry(ownerScopeId, { recursive: true });
      return true;
    } catch (error) {
      if (isNotFoundError(error)) {
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
