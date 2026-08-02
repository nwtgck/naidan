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

export type AuthenticatedMetadataCacheEventObservation = Readonly<{
  event: "eviction" | "hit" | "miss";
}>;

export type AuthenticatedMetadataCacheUsageObservation = Readonly<{
  bytes: number;
  entries: number;
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
  recordMetadataCacheEvent?: ({
    event,
  }: AuthenticatedMetadataCacheEventObservation) => void;
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
    bytes,
    entries,
  }: AuthenticatedMetadataCacheUsageObservation) => void;
}>;

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
  try {
    return await run();
  } finally {
    diagnostics.recordPublicationOperation({
      durationMs: Math.max(0, clock() - startedAt),
    });
  }
}

export const TEST_ONLY = {
  // This contract has no test-only runtime surface.
};
