import {
  inspectHizoFSHomeRecord,
  inspectHizoFSNamespacePath,
  inspectHizoFSPhysicalContainer,
  inspectHizoFSPhysicalRecord,
  type HizoFSHomeRecordInspectionRequest,
  type HizoFSNamespacePathInspection,
  type HizoFSPhysicalContainerInspection,
  type HizoFSPhysicalRecordInspection,
  type HizoFSPhysicalRecordInspectionRequest,
} from "@/00-storage/service/hizofs/inspection";
import type { AuthenticatedHizoFSInspectionPort } from "@/00-storage/service/hizofs/authenticated-store/inspection-port";

export interface HizoFSPhysicalInspectionDriver {
  inspectContainer({ passphrase }: {
    passphrase: string;
  }): Promise<HizoFSPhysicalContainerInspection>;
  inspectHomeRecord({ maximumPreviewBytes, passphrase, request }: {
    maximumPreviewBytes?: number;
    passphrase: string;
    request: HizoFSHomeRecordInspectionRequest;
  }): Promise<HizoFSPhysicalRecordInspection>;
  inspectNamespacePath({ maximumDirectoryEntries, maximumPages, passphrase, pathComponents }: {
    maximumDirectoryEntries?: number;
    maximumPages?: number;
    passphrase: string;
    pathComponents: readonly string[];
  }): Promise<HizoFSNamespacePathInspection>;
  inspectRecord({ maximumPreviewBytes, passphrase, request }: {
    maximumPreviewBytes?: number;
    passphrase: string;
    request: HizoFSPhysicalRecordInspectionRequest;
  }): Promise<HizoFSPhysicalRecordInspection>;
}

export interface HizoFSPhysicalInspectionWorker {
  inspectContainer({ passphrase }: {
    passphrase: string;
  }): Promise<HizoFSPhysicalContainerInspection>;
  inspectHomeRecord({ maximumPreviewBytes, passphrase, request }: {
    maximumPreviewBytes?: number;
    passphrase: string;
    request: HizoFSHomeRecordInspectionRequest;
  }): Promise<HizoFSPhysicalRecordInspection>;
  inspectNamespacePath({ maximumDirectoryEntries, maximumPages, passphrase, pathComponents }: {
    maximumDirectoryEntries?: number;
    maximumPages?: number;
    passphrase: string;
    pathComponents: readonly string[];
  }): Promise<HizoFSNamespacePathInspection>;
  inspectRecord({ maximumPreviewBytes, passphrase, request }: {
    maximumPreviewBytes?: number;
    passphrase: string;
    request: HizoFSPhysicalRecordInspectionRequest;
  }): Promise<HizoFSPhysicalRecordInspection>;
}

export function createHizoFSPhysicalInspectionDriver({ physical }: {
  physical: AuthenticatedHizoFSInspectionPort;
}): HizoFSPhysicalInspectionDriver {
  return {
    inspectContainer: async ({ passphrase }) => await inspectHizoFSPhysicalContainer({
      passphrase,
      physical,
    }),
    inspectHomeRecord: async ({ maximumPreviewBytes, passphrase, request }) => await inspectHizoFSHomeRecord({
      maximumPreviewBytes,
      passphrase,
      physical,
      request,
    }),
    inspectNamespacePath: async ({ maximumDirectoryEntries, maximumPages, passphrase, pathComponents }) => await inspectHizoFSNamespacePath({
      maximumDirectoryEntries,
      maximumPages,
      passphrase,
      pathComponents,
      physical,
    }),
    inspectRecord: async ({ maximumPreviewBytes, passphrase, request }) => await inspectHizoFSPhysicalRecord({
      maximumPreviewBytes,
      passphrase,
      physical,
      request,
    }),
  };
}

export function createHizoFSPhysicalInspectionWorker({ driver }: {
  driver: HizoFSPhysicalInspectionDriver;
}): HizoFSPhysicalInspectionWorker {
  return {
    inspectContainer: async ({ passphrase }) => await driver.inspectContainer({ passphrase }),
    inspectHomeRecord: async ({ maximumPreviewBytes, passphrase, request }) => await driver.inspectHomeRecord({
      maximumPreviewBytes,
      passphrase,
      request,
    }),
    inspectNamespacePath: async ({ maximumDirectoryEntries, maximumPages, passphrase, pathComponents }) => await driver.inspectNamespacePath({
      maximumDirectoryEntries,
      maximumPages,
      passphrase,
      pathComponents,
    }),
    inspectRecord: async ({ maximumPreviewBytes, passphrase, request }) => await driver.inspectRecord({
      maximumPreviewBytes,
      passphrase,
      request,
    }),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
