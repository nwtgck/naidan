import type { FileSystemId } from "@/00-storage/service/hizofs/00-format";
import type { FileSystemRootKey } from "@/00-storage/service/hizofs/01-crypto";
import type { AuthenticatedHizoFSInspectionPort } from "@/00-storage/service/hizofs/authenticated-store/inspection-port";
import { withBorrowedHizoFSInspectionAuthority, type HizoFSOpenedInspectionAuthority } from "@/00-storage/service/hizofs/inspection/inspection-authority";
import {
  inspectHizoFSNamespacePathWithAuthority,
  type HizoFSNamespacePathInspection,
} from "@/00-storage/service/hizofs/inspection/namespace-inspection";
import {
  inspectHizoFSPhysicalContainerWithAuthority,
  type HizoFSPhysicalContainerInspection,
} from "@/00-storage/service/hizofs/inspection/physical-container-inspection";
import {
  inspectHizoFSHomeRecordWithAuthority,
  inspectHizoFSPhysicalRecordFrameWithAuthority,
  inspectHizoFSPhysicalRecordWithAuthority,
  type HizoFSHomeRecordInspectionRequest,
  type HizoFSPhysicalRecordFrameInspection,
  type HizoFSPhysicalRecordInspection,
  type HizoFSPhysicalRecordInspectionRequest,
} from "@/00-storage/service/hizofs/inspection/physical-record-inspection";

/**
 * Secret-free bounded read authority for one already-authenticated HizoFS source.
 *
 * The implementation owns all passphrases and root-key capabilities. Consumers
 * can inspect authenticated persisted state but cannot derive mutation or
 * publication authority from this interface.
 */
export interface HizoFSAuthenticatedInspectionSession {
  inspectContainer(): Promise<HizoFSPhysicalContainerInspection>;
  inspectHomeRecord({ maximumPreviewBytes, request }: {
    maximumPreviewBytes?: number;
    request: HizoFSHomeRecordInspectionRequest;
  }): Promise<HizoFSPhysicalRecordInspection>;
  inspectNamespacePath({ maximumDirectoryEntries, maximumPages, pathComponents }: {
    maximumDirectoryEntries?: number;
    maximumPages?: number;
    pathComponents: readonly string[];
  }): Promise<HizoFSNamespacePathInspection>;
  inspectRecord({ maximumPreviewBytes, request }: {
    maximumPreviewBytes?: number;
    request: HizoFSPhysicalRecordInspectionRequest;
  }): Promise<HizoFSPhysicalRecordInspection>;
  inspectRecordFrame({ request }: {
    request: HizoFSPhysicalRecordInspectionRequest;
  }): Promise<HizoFSPhysicalRecordFrameInspection>;
}

export interface HizoFSAuthenticatedInspectionAuthorityBorrower {
  run<T>({ operation }: {
    operation: ({ fileSystemId, physical, rootKey }: {
      fileSystemId: FileSystemId;
      physical: AuthenticatedHizoFSInspectionPort;
      rootKey: FileSystemRootKey;
    }) => Promise<T>;
  }): Promise<T>;
}

/**
 * Projects a callback-scoped secret-bearing HizoFS authority into the bounded,
 * secret-free Inspector session consumed by debug UI code. Root Keys and
 * physical backends never escape the callback supplied by the source owner.
 */
export function createHizoFSAuthenticatedInspectionSession({ authorityBorrower }: {
  authorityBorrower: HizoFSAuthenticatedInspectionAuthorityBorrower;
}): HizoFSAuthenticatedInspectionSession {
  const withOpenedAuthority = async <T>({ operation }: {
    operation: ({ authority, physical }: {
      authority: HizoFSOpenedInspectionAuthority;
      physical: AuthenticatedHizoFSInspectionPort;
    }) => Promise<T>;
  }): Promise<T> => await authorityBorrower.run({
    operation: async ({ fileSystemId, physical, rootKey }) => {
      return await withBorrowedHizoFSInspectionAuthority({
        fileSystemId,
        operation: async ({ authority }) => await operation({ authority, physical }),
        physical,
        rootKey,
      });
    },
  });

  const session: HizoFSAuthenticatedInspectionSession = {
    inspectContainer: async () => await authorityBorrower.run({
      operation: async ({ fileSystemId, physical, rootKey }) => await inspectHizoFSPhysicalContainerWithAuthority({
        fileSystemId,
        physical,
        rootKey,
      }),
    }),
    inspectHomeRecord: async ({ maximumPreviewBytes, request }) => await withOpenedAuthority({
      operation: async ({ authority, physical }) => await inspectHizoFSHomeRecordWithAuthority({
        authority,
        maximumPreviewBytes,
        physical,
        request,
      }),
    }),
    inspectNamespacePath: async ({ maximumDirectoryEntries, maximumPages, pathComponents }) => await withOpenedAuthority({
      operation: async ({ authority, physical }) => await inspectHizoFSNamespacePathWithAuthority({
        authority,
        maximumDirectoryEntries,
        maximumPages,
        pathComponents,
        physical,
      }),
    }),
    inspectRecord: async ({ maximumPreviewBytes, request }) => await withOpenedAuthority({
      operation: async ({ authority, physical }) => await inspectHizoFSPhysicalRecordWithAuthority({
        authority,
        maximumPreviewBytes,
        physical,
        request,
      }),
    }),
    inspectRecordFrame: async ({ request }) => await withOpenedAuthority({
      operation: async ({ authority, physical }) => await inspectHizoFSPhysicalRecordFrameWithAuthority({
        authority,
        physical,
        request,
      }),
    }),
  };
  return Object.freeze(session);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
