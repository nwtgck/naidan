import type {
  FileSystemId,
  HomeRecordReference,
  PhysicalRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import {
  readAuthenticatedPhysicalRecord,
  type AuthenticatedRecordRead,
} from "@/00-storage/service/hizofs/authenticated-store/record-reader";
import { resolveAuthenticatedHomeRecord } from "@/00-storage/service/hizofs/authenticated-store/relocation-index-reader";
import type {
  AuthenticatedCodecDiagnosticsObservation,
  AuthenticatedCryptoDiagnosticsObservation,
  AuthenticatedPublicationDiagnosticsObservation,
  AuthenticatedRecordDiagnosticsObservation,
  AuthenticatedStoreDiagnosticsPort,
} from "@/00-storage/service/hizofs/authenticated-store/runtime-diagnostics-port";
import type { FileSystemRootKey } from "@/00-storage/service/hizofs/01-crypto";
import type { HizoFSReadableBackend } from "@/00-storage/service/hizofs/physical-store/backend";

export type AuthenticatedMaintenanceRecordRead = Readonly<{
  physicalBytesRead: number;
  record: AuthenticatedRecordRead;
}>;

export interface AuthenticatedMaintenanceRecordPort {
  readLogicalRecord({ reference }: {
    reference: HomeRecordReference;
  }): Promise<AuthenticatedMaintenanceRecordRead>;
  readPhysicalRecord({ reference }: {
    reference: PhysicalRecordReference;
  }): Promise<AuthenticatedMaintenanceRecordRead>;
}

type ReadByteMeter = Readonly<{
  diagnostics: AuthenticatedStoreDiagnosticsPort;
  physicalBytesRead: () => number;
}>;

function createReadByteMeter({ downstream }: {
  downstream: AuthenticatedStoreDiagnosticsPort | undefined;
}): ReadByteMeter {
  let physicalBytesRead = 0;
  return Object.freeze({
    diagnostics: Object.freeze({
      recordCodecOperation: ({ durationMs, format, operation }: AuthenticatedCodecDiagnosticsObservation) => downstream?.recordCodecOperation({ durationMs, format, operation }),
      recordCryptoOperation: ({ durationMs, operation }: AuthenticatedCryptoDiagnosticsObservation) => downstream?.recordCryptoOperation({ durationMs, operation }),
      recordPersistedRecord: ({ operation, physicalBytes, plaintextBytes, recordKind }: AuthenticatedRecordDiagnosticsObservation) => {
        switch (operation) {
        case "read": {
          const next = physicalBytesRead + physicalBytes;
          if (!Number.isSafeInteger(next) || next <= physicalBytesRead) {
            throw new RangeError("authenticated maintenance read byte count exceeds the safe integer bound");
          }
          physicalBytesRead = next;
          break;
        }
        case "write":
          break;
        default:
          operation satisfies never;
        }
        downstream?.recordPersistedRecord({ operation, physicalBytes, plaintextBytes, recordKind });
      },
      recordPublicationOperation: ({ durationMs }: AuthenticatedPublicationDiagnosticsObservation) => downstream?.recordPublicationOperation({ durationMs }),
    }),
    physicalBytesRead: () => physicalBytesRead,
  });
}

/**
 * Closes secret-bearing backend authority inside authenticated-store. The
 * maintenance layer receives only authenticated records and an aggregate byte
 * count that includes Relocation Index reads; it cannot call crypto or
 * physical I/O directly.
 */
export function createAuthenticatedMaintenanceRecordPort({
  backend,
  diagnostics,
  fileSystemId,
  relocationIndexRootPhysicalRef,
  rootKey,
}: {
  backend: HizoFSReadableBackend;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  relocationIndexRootPhysicalRef: PhysicalRecordReference | null;
  rootKey: FileSystemRootKey;
}): AuthenticatedMaintenanceRecordPort {
  const runMeasured = async ({ read }: {
    read: ({ diagnostics }: { diagnostics: AuthenticatedStoreDiagnosticsPort }) => Promise<AuthenticatedRecordRead>;
  }): Promise<AuthenticatedMaintenanceRecordRead> => {
    const meter = createReadByteMeter({ downstream: diagnostics });
    const record = await read({ diagnostics: meter.diagnostics });
    const physicalBytesRead = meter.physicalBytesRead();
    if (physicalBytesRead < record.physicalReference.frameLength) {
      throw new TypeError("authenticated maintenance read diagnostics undercounted the returned frame");
    }
    return Object.freeze({ physicalBytesRead, record });
  };

  return Object.freeze({
    readLogicalRecord: async ({ reference }: { reference: HomeRecordReference }) => await runMeasured({
      read: async ({ diagnostics: measuredDiagnostics }) => await resolveAuthenticatedHomeRecord({
        backend,
        diagnostics: measuredDiagnostics,
        fileSystemId,
        homeReference: reference,
        relocationIndexRootPhysicalRef,
        rootKey,
      }),
    }),
    readPhysicalRecord: async ({ reference }: { reference: PhysicalRecordReference }) => await runMeasured({
      read: async ({ diagnostics: measuredDiagnostics }) => await readAuthenticatedPhysicalRecord({
        backend,
        diagnostics: measuredDiagnostics,
        expectedIdentity: { type: "physical_only" },
        fileSystemId,
        physicalReference: reference,
        rootKey,
      }),
    }),
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  createReadByteMeter,
};
