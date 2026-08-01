import { createHizoFSPhysicalInspectionWorkerForOpfsPath } from '@/features/debug-hizofs/worker/opfs-physical-inspection';
import type { HizoFSPhysicalInspectionWorker } from '@/features/debug-hizofs/worker/physical-inspection';

export interface HizoFSPhysicalInspectionSource {
  open(): Promise<HizoFSPhysicalInspectionWorker>;
}

export interface ActiveEncryptedStoreInspectionLease {
  readonly physicalPath: readonly string[];
  assertCurrent(): void;
  dispose(): Promise<void>;
}

/**
 * Opens a read-only physical inspection source without giving the debug feature
 * access to Naidan's storage facade or decrypted filesystem authority.
 *
 * The provider-owned lease is generation-scoped. Its physical path is copied
 * before any further await, checked again after the Inspector opens, and always
 * disposed. If a provider cutover completes while the Inspector is opening, the
 * stale result is rejected before return. The returned Inspector retains neither
 * a mutable caller array nor a root-key capability.
 */
export function createActiveHizoFSPhysicalInspectionSource({
  createInspector = createHizoFSPhysicalInspectionWorkerForOpfsPath,
  openLease,
}: {
  createInspector?: ({ nativeOpfsRoot, physicalPath }: {
    nativeOpfsRoot: FileSystemDirectoryHandle | undefined;
    physicalPath: readonly string[];
  }) => Promise<HizoFSPhysicalInspectionWorker>;
  openLease: () => Promise<ActiveEncryptedStoreInspectionLease>;
}): HizoFSPhysicalInspectionSource {
  return {
    async open() {
      const lease = await openLease();
      const physicalPath = [...lease.physicalPath];
      try {
        lease.assertCurrent();
        const inspector = await createInspector({ nativeOpfsRoot: undefined, physicalPath });
        // A provider cutover may complete while the Inspector opens. Reject the
        // stale result before it can become the visible Workbench generation.
        lease.assertCurrent();
        return inspector;
      } finally {
        await lease.dispose();
      }
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
