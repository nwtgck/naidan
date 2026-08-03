import type {
  FileSystemId,
  HomeRecordReference,
  PhysicalRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import { resolveAuthenticatedHomeRecord } from "@/00-storage/service/hizofs/authenticated-store/relocation-index-reader";
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
  decodeRecordPayload: <T>({ decode }: { decode: () => T }) => T;
  readHomeRecord: ({ reference }: {
    reference: HomeRecordReference;
  }) => Promise<AuthenticatedNamespaceRecord>;
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
  fileSystemId,
  metadataRecordCache,
  relocationIndexRootPhysicalRef,
  rootKey,
}: {
  backend: HizoFSReadableBackend;
  diagnostics?: AuthenticatedStoreDiagnosticsPort;
  fileSystemId: FileSystemId;
  metadataRecordCache?: AuthenticatedMetadataRecordCache;
  relocationIndexRootPhysicalRef: PhysicalRecordReference | null;
  rootKey: FileSystemRootKey;
}): AuthenticatedNamespaceRecordSource {
  return {
    decodeRecordPayload: ({ decode }) => measureAuthenticatedCodecOperation({
      diagnostics,
      format: "record",
      operation: "decode",
      run: decode,
    }),
    readHomeRecord: async ({ reference }) => await readAuthenticatedNamespaceHomeRecord({
      backend,
      diagnostics,
      fileSystemId,
      metadataRecordCache,
      reference,
      relocationIndexRootPhysicalRef,
      rootKey,
    }),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
