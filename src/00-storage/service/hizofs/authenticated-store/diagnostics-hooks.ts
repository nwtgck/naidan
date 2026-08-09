import type { HizoFSPhysicalWriteBackend, HizoFSReadableBackend, HizoFSWritableFile } from "@/00-storage/service/hizofs/physical-store/backend";
import type { CanonicalContainerPath } from "@/00-storage/service/hizofs/physical-store/paths";
import type {
  AuthenticatedCodecDiagnosticsObservation,
  AuthenticatedCryptoDiagnosticsObservation,
  AuthenticatedPhysicalAccessReason,
  AuthenticatedStoreDiagnosticsPort,
} from "@/00-storage/service/hizofs/diagnostics/authenticated-store-diagnostics";

export { AUTHENTICATED_PHYSICAL_ACCESS_REASONS } from "@/00-storage/service/hizofs/diagnostics/authenticated-store-diagnostics";
export type {
  AuthenticatedCodecDiagnosticsObservation,
  AuthenticatedCryptoDiagnosticsObservation,
  AuthenticatedMetadataCacheEventObservation,
  AuthenticatedMetadataCacheUsageObservation,
  AuthenticatedMutationScopeEventObservation,
  AuthenticatedPhysicalAccessReason,
  AuthenticatedPhysicalAccessReasonObservation,
  AuthenticatedPublicationDiagnosticsObservation,
  AuthenticatedPublicationScopeEventObservation,
  AuthenticatedRecordDiagnosticsObservation,
  AuthenticatedSegmentWriterDiagnosticsObservation,
  AuthenticatedStoreDiagnosticsPort,
} from "@/00-storage/service/hizofs/diagnostics/authenticated-store-diagnostics";

export async function getOpenFileSizeWithAuthenticatedReason<AuthenticatedPhysicalBytes extends Uint8Array>({
  backend,
  diagnostics,
  file,
  reason,
}: {
  backend: HizoFSPhysicalWriteBackend<AuthenticatedPhysicalBytes>;
  diagnostics: AuthenticatedStoreDiagnosticsPort | undefined;
  file: HizoFSWritableFile;
  reason: AuthenticatedPhysicalAccessReason;
}): Promise<bigint> {
  diagnostics?.recordPhysicalAccessReason?.({
    identity: String(file.path),
    operation: "get_file_size",
    reason,
  });
  return await backend.getOpenFileSize({ file });
}

export async function getFileSizeWithAuthenticatedReason({
  backend,
  diagnostics,
  path,
  reason,
}: {
  backend: HizoFSReadableBackend;
  diagnostics: AuthenticatedStoreDiagnosticsPort | undefined;
  path: CanonicalContainerPath;
  reason: AuthenticatedPhysicalAccessReason;
}): Promise<bigint | undefined> {
  diagnostics?.recordPhysicalAccessReason?.({
    identity: String(path),
    operation: "get_file_size",
    reason,
  });
  return await backend.getFileSize({ path });
}

export async function readExactWithAuthenticatedReason({
  backend,
  diagnostics,
  length,
  offset,
  path,
  reason,
}: {
  backend: HizoFSReadableBackend;
  diagnostics: AuthenticatedStoreDiagnosticsPort | undefined;
  length: number;
  offset: bigint;
  path: CanonicalContainerPath;
  reason: AuthenticatedPhysicalAccessReason;
}): Promise<Uint8Array> {
  diagnostics?.recordPhysicalAccessReason?.({
    identity: `${String(path)}\u0000${offset.toString()}\u0000${length.toString()}`,
    operation: "read_exact",
    reason,
  });
  return await backend.readExact({ length, offset, path });
}

export async function readExactWithFileSizeWithAuthenticatedReason({
  backend,
  diagnostics,
  length,
  offset,
  path,
  reason,
}: {
  backend: HizoFSReadableBackend;
  diagnostics: AuthenticatedStoreDiagnosticsPort | undefined;
  length: number;
  offset: bigint;
  path: CanonicalContainerPath;
  reason: AuthenticatedPhysicalAccessReason;
}): Promise<Readonly<{ bytes: Uint8Array; fileSize: bigint }>> {
  diagnostics?.recordPhysicalAccessReason?.({
    identity: `${String(path)}\u0000${offset.toString()}\u0000${length.toString()}`,
    operation: "read_exact",
    reason,
  });
  return await backend.readExactWithFileSize({ length, offset, path });
}

export function measureAuthenticatedCodecOperation<T>({
  clock = () => globalThis.performance.now(),
  diagnostics,
  format,
  operation,
  run,
}: {
  clock?: () => number;
  diagnostics: AuthenticatedStoreDiagnosticsPort | undefined;
  format: AuthenticatedCodecDiagnosticsObservation["format"];
  operation: AuthenticatedCodecDiagnosticsObservation["operation"];
  run: () => T;
}): T {
  if (diagnostics === undefined) return run();
  const startedAt = clock();
  try {
    return run();
  } finally {
    diagnostics.recordCodecOperation({
      durationMs: Math.max(0, clock() - startedAt),
      format,
      operation,
    });
  }
}

export async function measureAuthenticatedCryptoOperation<T>({
  clock = () => globalThis.performance.now(),
  diagnostics,
  operation,
  run,
}: {
  clock?: () => number;
  diagnostics: AuthenticatedStoreDiagnosticsPort | undefined;
  operation: AuthenticatedCryptoDiagnosticsObservation["operation"];
  run: () => Promise<T>;
}): Promise<T> {
  if (diagnostics === undefined) return await run();
  const startedAt = clock();
  try {
    return await run();
  } finally {
    diagnostics.recordCryptoOperation({
      durationMs: Math.max(0, clock() - startedAt),
      operation,
    });
  }
}

export async function measureAuthenticatedPublicationOperation<T>({
  clock = () => globalThis.performance.now(),
  diagnostics,
  run,
}: {
  clock?: () => number;
  diagnostics: AuthenticatedStoreDiagnosticsPort | undefined;
  run: () => Promise<T>;
}): Promise<T> {
  if (diagnostics === undefined) return await run();
  const startedAt = clock();
  diagnostics.recordPublicationScopeEvent?.({ event: "begin" });
  try {
    return await run();
  } finally {
    try {
      diagnostics.recordPublicationOperation({
        durationMs: Math.max(0, clock() - startedAt),
      });
    } finally {
      diagnostics.recordPublicationScopeEvent?.({ event: "end" });
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
