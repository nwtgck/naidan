import type { HizoFSReadableBackend } from "@/00-storage/service/hizofs/physical-store/backend";
import type { CanonicalContainerPath } from "@/00-storage/service/hizofs/physical-store/paths";

export type AuthenticatedRecordDiagnosticsObservation = Readonly<{
  operation: "read" | "write";
  physicalBytes: number;
  plaintextBytes: number;
  recordKind: number;
}>;

export type AuthenticatedCodecDiagnosticsObservation = Readonly<{
  durationMs: number;
  format: "envelope" | "record";
  operation: "decode" | "encode";
}>;

export type AuthenticatedCryptoDiagnosticsObservation = Readonly<{
  durationMs: number;
  operation: "decrypt" | "encrypt";
}>;

export type AuthenticatedPublicationDiagnosticsObservation = Readonly<{
  durationMs: number;
}>;

export type AuthenticatedPublicationScopeEventObservation = Readonly<{
  event: "begin" | "end";
}>;

export type AuthenticatedMutationScopeEventObservation =
  | Readonly<{ event: "begin" }>
  | Readonly<{
    event: "end";
    outcome: "abandoned" | "failed" | "published";
  }>;

export type AuthenticatedSegmentWriterDiagnosticsObservation = Readonly<{
  event:
    | "append_read_back_verified"
    | "append_started"
    | "created"
    | "descriptor_validated"
    | "rollover"
    | "trusted_tail_match"
    | "trusted_tail_mismatch";
  segmentClass: "data" | "metadata" | "relocation";
}>;

export type AuthenticatedMetadataCacheEventObservation = Readonly<{
  scope?: "mutation" | "session";
  event: "eviction" | "hit" | "miss";
  recordKind: number;
}>;

export type AuthenticatedMetadataCacheUsageObservation = Readonly<{
  scope?: "mutation" | "session";
  bytes: number;
  entries: number;
}>;

export const AUTHENTICATED_PHYSICAL_ACCESS_REASONS = Object.freeze([
  "append_read_back",
  "authenticated_record_resolution",
  "segment_descriptor",
  "trusted_tail",
] as const);

export type AuthenticatedPhysicalAccessReason = typeof AUTHENTICATED_PHYSICAL_ACCESS_REASONS[number];

export type AuthenticatedPhysicalAccessReasonObservation = Readonly<{
  identity: string;
  operation: "get_file_size" | "read_exact";
  reason: AuthenticatedPhysicalAccessReason;
}>;

/**
 * Receives non-secret measurements at authenticated-store boundaries.
 *
 * The authenticated store reports the numeric record kind it already
 * validated instead of owning a second diagnostic vocabulary. Crypto timing
 * contains no key, nonce, AAD, plaintext, or ciphertext bytes. Publication
 * timing covers the authenticated Commit append and authority-publication
 * attempt without carrying payload or authority bytes.
 */
export type AuthenticatedStoreDiagnosticsPort = Readonly<{
  recordMutationScopeEvent?: ({
    observation,
  }: {
    observation: AuthenticatedMutationScopeEventObservation;
  }) => void;
  recordPublicationScopeEvent?: ({
    event,
  }: AuthenticatedPublicationScopeEventObservation) => void;
  recordSegmentWriterEvent?: ({
    event,
    segmentClass,
  }: AuthenticatedSegmentWriterDiagnosticsObservation) => void;
  recordMetadataCacheEvent?: ({
    scope,
    event,
    recordKind,
  }: AuthenticatedMetadataCacheEventObservation) => void;
  recordPhysicalAccessReason?: ({
    identity,
    operation,
    reason,
  }: AuthenticatedPhysicalAccessReasonObservation) => void;
  recordCodecOperation: ({
    durationMs,
    format,
    operation,
  }: AuthenticatedCodecDiagnosticsObservation) => void;
  recordCryptoOperation: ({
    durationMs,
    operation,
  }: AuthenticatedCryptoDiagnosticsObservation) => void;
  recordPersistedRecord: ({
    operation,
    physicalBytes,
    plaintextBytes,
    recordKind,
  }: AuthenticatedRecordDiagnosticsObservation) => void;
  recordPublicationOperation: ({
    durationMs,
  }: AuthenticatedPublicationDiagnosticsObservation) => void;
  setMetadataCacheUsage?: ({
    scope,
    bytes,
    entries,
  }: AuthenticatedMetadataCacheUsageObservation) => void;
}>;

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

export const TEST_ONLY = {
  // This contract has no test-only runtime surface.
};
