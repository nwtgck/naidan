import type {
  FileSystemId,
  HomeRecordReference,
  PhysicalRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import { resolveAuthenticatedHomeRecord } from "@/00-storage/service/hizofs/authenticated-store/relocation-index-reader";
import type { FileSystemRootKey } from "@/00-storage/service/hizofs/01-crypto";
import type { HizoFSReadableBackend } from "@/00-storage/service/hizofs/physical-store/backend";
import {
  measureAuthenticatedCodecOperation,
  type AuthenticatedStoreDiagnosticsPort,
} from "./runtime-diagnostics-port";

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
 * Binds secret-bearing physical read authority behind a record-only capability.
 * Filesystem traversal receives authenticated plaintext records, never the root
 * key, backend, relocation index, or physical read primitives themselves.
 */
export function createAuthenticatedNamespaceRecordSource({
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
}): AuthenticatedNamespaceRecordSource {
  return {
    decodeRecordPayload: ({ decode }) => measureAuthenticatedCodecOperation({
      diagnostics,
      format: "record",
      operation: "decode",
      run: decode,
    }),
    readHomeRecord: async ({ reference }) => {
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
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
