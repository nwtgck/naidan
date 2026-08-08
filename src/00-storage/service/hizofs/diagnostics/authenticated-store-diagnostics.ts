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
    outcome: "abandoned" | "accepted" | "failed" | "published";
  }>;

export type AuthenticatedSegmentWriterDiagnosticsObservation =
  | Readonly<{
    event: "append_read_back_verified";
    frameBytes: number;
    recordCount: number;
    segmentClass: "data" | "metadata" | "relocation";
  }>
  | Readonly<{
    event:
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
  recordSegmentWriterEvent?: ({ observation }: {
    observation: AuthenticatedSegmentWriterDiagnosticsObservation;
  }) => void;
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

export const TEST_ONLY = {
  // This contract has no test-only runtime surface.
};
