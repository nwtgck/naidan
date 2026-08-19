import {
  assertFileDataPayloadBytesValid,
  type FileSystemId,
  type HomeRecordReference,
  type PhysicalRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import { resolveAuthenticatedHomeRecord } from "@/00-storage/service/hizofs/authenticated-store/relocation-index-reader";
import {
  AuthenticatedFileDataRecordCache,
  type AuthenticatedFileDataRecord,
} from "@/00-storage/service/hizofs/authenticated-store/file-data-record-cache";
import type { FileSystemRootKey } from "@/00-storage/service/hizofs/01-crypto";
import type { HizoFSReadableBackend } from "@/00-storage/service/hizofs/physical-store/backend";
import type { AuthenticatedMetadataRecordCache } from "./metadata-record-cache";
import {
  measureAuthenticatedCodecOperation,
  type AuthenticatedStoreDiagnosticsPort,
} from "@/00-storage/service/hizofs/authenticated-store/diagnostics-hooks";

export type AuthenticatedNamespaceRecord = Readonly<{
  plaintext: Uint8Array;
  recordKind: number;
}>;

export type AuthenticatedNamespaceRecordSource = Readonly<{
  copyFileDataRange: ({ destination, destinationOffset, reference, sourceLength, sourceOffset, validatePlaintextLength }: {
    destination: Uint8Array;
    destinationOffset: number;
    reference: HomeRecordReference;
    sourceLength: number;
    sourceOffset: number;
    validatePlaintextLength: ({ plaintextLength }: { plaintextLength: number }) => void;
  }) => Promise<void>;
  decodeRecordPayload: <T>({ decode }: { decode: () => T }) => T;
  readHomeRecord: ({ reference }: { reference: HomeRecordReference }) => Promise<AuthenticatedNamespaceRecord>;
}>;

/**
 * Resolves one immutable authenticated record through an optional mutation-local
 * cache layered over the longer-lived session cache. The local layer avoids
 * repeated work inside one mutation without discarding cross-mutation hits;
 * each layer retains and returns detached plaintext under its own zeroization
 * lifetime.
 */
export async function readAuthenticatedNamespaceHomeRecord({
  backend,
  diagnostics,
  fileSystemId,
  metadataRecordCache,
  sharedMetadataRecordCache,
  reference,
  relocationIndexRootPhysicalRef,
  rootKey,
}: {
  backend: HizoFSReadableBackend;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  metadataRecordCache?: AuthenticatedMetadataRecordCache;
  sharedMetadataRecordCache?: AuthenticatedMetadataRecordCache;
  reference: HomeRecordReference;
  relocationIndexRootPhysicalRef: PhysicalRecordReference | null;
  rootKey: FileSystemRootKey;
}): Promise<AuthenticatedNamespaceRecord> {
  const loadRecord = async (): Promise<AuthenticatedNamespaceRecord> => {
    const record = await resolveAuthenticatedHomeRecord({
      backend,
      diagnostics,
      fileSystemId,
      homeReference: reference,
      relocationIndexRootPhysicalRef,
      rootKey,
    });
    return {
      plaintext: record.plaintext,
      recordKind: record.header.recordKind,
    };
  };
  const loadSharedRecord = sharedMetadataRecordCache === undefined
    ? loadRecord
    : async (): Promise<AuthenticatedNamespaceRecord> => await sharedMetadataRecordCache.read({
      load: loadRecord,
      reference,
    });
  return metadataRecordCache === undefined
    ? await loadSharedRecord()
    : await metadataRecordCache.read({ load: loadSharedRecord, reference });
}

/**
 * Binds secret-bearing physical read authority behind a record-only capability.
 * Filesystem traversal receives authenticated plaintext records, never the root
 * key, backend, relocation index, or physical read primitives themselves.
 */
export function createAuthenticatedNamespaceRecordSource({
  backend,
  diagnostics,
  fileDataRecordCache,
  fileSystemId,
  metadataRecordCache,
  relocationIndexRootPhysicalRef,
  rootKey,
}: {
  backend: HizoFSReadableBackend;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileDataRecordCache?: AuthenticatedFileDataRecordCache;
  fileSystemId: FileSystemId;
  metadataRecordCache?: AuthenticatedMetadataRecordCache;
  relocationIndexRootPhysicalRef: PhysicalRecordReference | null;
  rootKey: FileSystemRootKey;
}): AuthenticatedNamespaceRecordSource {
  const effectiveFileDataRecordCache = fileDataRecordCache ?? new AuthenticatedFileDataRecordCache({
    diagnostics: undefined,
    policy: { maximumBytes: 0, maximumEntries: 0 },
  });
  const readHomeRecord = async ({ reference }: { reference: HomeRecordReference }): Promise<AuthenticatedNamespaceRecord> => (
    await readAuthenticatedNamespaceHomeRecord({
      backend,
      diagnostics,
      fileSystemId,
      metadataRecordCache,
      reference,
      relocationIndexRootPhysicalRef,
      rootKey,
    })
  );
  return {
    copyFileDataRange: async ({ destination, destinationOffset, reference, sourceLength, sourceOffset, validatePlaintextLength }) => (
      await effectiveFileDataRecordCache.copyRange({
        destination,
        destinationOffset,
        load: async (): Promise<AuthenticatedFileDataRecord> => {
          const record = await readHomeRecord({ reference });
          try {
            measureAuthenticatedCodecOperation({
              diagnostics,
              format: "record",
              operation: "decode",
              run: () => assertFileDataPayloadBytesValid({ bytes: record.plaintext }),
            });
            return record;
          } catch (cause: unknown) {
            record.plaintext.fill(0);
            throw cause;
          }
        },
        reference,
        sourceLength,
        sourceOffset,
        validatePlaintextLength,
      })
    ),
    decodeRecordPayload: ({ decode }) => measureAuthenticatedCodecOperation({
      diagnostics,
      format: "record",
      operation: "decode",
      run: decode,
    }),
    readHomeRecord,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
