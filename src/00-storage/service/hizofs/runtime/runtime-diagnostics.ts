import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  HIZOFS_V1_PERSISTED_RECORD_KIND_DIAGNOSTIC_NAMES,
  type HizoFSV1PersistedRecordKindDiagnosticName,
} from "@/00-storage/service/hizofs/00-format";
import type {
  ImmutableBTreeDiagnosticsObservation,
  ImmutableBTreeDiagnosticsPort,
} from "@/00-storage/service/hizofs/indexes/runtime-diagnostics-port";
import type {
  AuthenticatedCodecDiagnosticsObservation,
  AuthenticatedCryptoDiagnosticsObservation,
  AuthenticatedMetadataCacheEventObservation,
  AuthenticatedPublicationDiagnosticsObservation,
  AuthenticatedPublicationScopeEventObservation,
  AuthenticatedRecordDiagnosticsObservation,
  AuthenticatedSegmentWriterDiagnosticsObservation,
  AuthenticatedStoreDiagnosticsPort,
} from "@/00-storage/service/hizofs/authenticated-store/runtime-diagnostics-port";

export const HIZOFS_RUNTIME_DIAGNOSTIC_PHASES = Object.freeze([
  "record_encode",
  "record_decode",
  "object_encrypt",
  "object_decrypt",
  "envelope_encode",
  "envelope_decode",
  "physical_create_directory_exclusive",
  "physical_create_file_exclusive",
  "physical_open_file_for_update",
  "physical_get_file_size",
  "physical_read_exact",
  "physical_read_file_bounded",
  "physical_write_at",
  "physical_truncate",
  "physical_sync_file_data",
  "physical_close_file",
  "physical_sync_directory_entries",
  "physical_remove_file",
  "physical_list",
  "index_build",
  "index_update",
  "commit_publication",
] as const);

export const HIZOFS_RUNTIME_DIAGNOSTIC_CACHES = Object.freeze([
  "metadata",
  "fileChunk",
  "backingFileHandle",
  "backingFileSnapshot",
  "decodedInodeIndexPage",
] as const);

export const HIZOFS_RUNTIME_DIAGNOSTIC_RESOURCES = Object.freeze([
  "writerDirtyChunks",
  "writerPendingChunkWrites",
  "readerPrefetch",
] as const);

export const HIZOFS_RUNTIME_DIAGNOSTIC_COORDINATOR_COUNTERS = Object.freeze([
  "activeStateCacheHits",
  "durableReloads",
  "leadershipAcquisitions",
  "failovers",
  "localRequests",
  "remoteRequests",
] as const);

export type HizoFSRuntimeDiagnosticPhase = typeof HIZOFS_RUNTIME_DIAGNOSTIC_PHASES[number];
export type HizoFSRuntimeDiagnosticCache = typeof HIZOFS_RUNTIME_DIAGNOSTIC_CACHES[number];
export type HizoFSRuntimeDiagnosticResource = typeof HIZOFS_RUNTIME_DIAGNOSTIC_RESOURCES[number];
export type HizoFSRuntimeDiagnosticCoordinatorCounter = typeof HIZOFS_RUNTIME_DIAGNOSTIC_COORDINATOR_COUNTERS[number];

export type HizoFSRuntimePhaseCounter = Readonly<{
  operationCount: number;
  totalDurationMs: number;
}>;

export type HizoFSRuntimeRecordCounter = Readonly<{
  readOperations: number;
  writeOperations: number;
  cacheHits: number;
  cacheMisses: number;
  plaintextBytesRead: number;
  plaintextBytesWritten: number;
  physicalBytesRead: number;
  physicalBytesWritten: number;
}>;

export type HizoFSRuntimeCacheCounter = Readonly<{
  hits: number;
  misses: number;
  evictions: number;
  currentBytes: number;
  maximumBytes: number;
  currentEntries: number;
  maximumEntries: number;
}>;

export type HizoFSRuntimeResourceCounter = Readonly<{
  currentBytes: number;
  maximumBytes: number;
  currentOperations: number;
  maximumOperations: number;
}>;

export type HizoFSRuntimePublicationAccessCounter = Readonly<{
  duplicateOperations: number;
  maximumOperationsPerPublication: number;
  operations: number;
  observedUniqueTargets: number;
  truncatedPublications: number;
  unclassifiedOperations: number;
}>;

export type HizoFSRuntimePublicationCounter = Readonly<{
  completed: number;
  overlapping: number;
  getFileSize: HizoFSRuntimePublicationAccessCounter;
  readExact: HizoFSRuntimePublicationAccessCounter;
}>;

export type HizoFSRuntimeSegmentWriterCounter = Readonly<{
  appendOperations: number;
  created: number;
  rollovers: number;
  trustedTailMatches: number;
  trustedTailMismatches: number;
}>;

export type HizoFSRuntimeDiagnosticsSnapshot = Readonly<{
  phases: Readonly<Record<HizoFSRuntimeDiagnosticPhase, HizoFSRuntimePhaseCounter>>;
  records: Readonly<Record<HizoFSV1PersistedRecordKindDiagnosticName, HizoFSRuntimeRecordCounter>>;
  caches: Readonly<Record<HizoFSRuntimeDiagnosticCache, HizoFSRuntimeCacheCounter>>;
  resources: Readonly<Record<HizoFSRuntimeDiagnosticResource, HizoFSRuntimeResourceCounter>>;
  coordinator: Readonly<Record<HizoFSRuntimeDiagnosticCoordinatorCounter, number>>;
  publication: HizoFSRuntimePublicationCounter;
  segmentWriters: Readonly<Record<"data" | "metadata" | "relocation", HizoFSRuntimeSegmentWriterCounter>>;
}>;

type MutablePhaseCounter = { operationCount: number; totalDurationMs: number };
type MutableRecordCounter = {
  readOperations: number;
  writeOperations: number;
  cacheHits: number;
  cacheMisses: number;
  plaintextBytesRead: number;
  plaintextBytesWritten: number;
  physicalBytesRead: number;
  physicalBytesWritten: number;
};
type MutableCacheCounter = {
  hits: number;
  misses: number;
  evictions: number;
  currentBytes: number;
  maximumBytes: number;
  currentEntries: number;
  maximumEntries: number;
};
type MutableResourceCounter = {
  currentBytes: number;
  maximumBytes: number;
  currentOperations: number;
  maximumOperations: number;
};
type MutablePublicationAccessCounter = {
  duplicateOperations: number;
  maximumOperationsPerPublication: number;
  operations: number;
  observedUniqueTargets: number;
  truncatedPublications: number;
  unclassifiedOperations: number;
};
type MutablePublicationCounter = {
  completed: number;
  overlapping: number;
  getFileSize: MutablePublicationAccessCounter;
  readExact: MutablePublicationAccessCounter;
};
type MutableSegmentWriterCounter = {
  appendOperations: number;
  created: number;
  rollovers: number;
  trustedTailMatches: number;
  trustedTailMismatches: number;
};
type ActivePublicationScope = {
  getFileSizeDuplicateOperations: number;
  getFileSizeOperations: number;
  getFileSizeTargets: Set<string>;
  getFileSizeUnclassifiedOperations: number;
  readExactDuplicateOperations: number;
  readExactOperations: number;
  readExactTargets: Set<string>;
  readExactUnclassifiedOperations: number;
};

const MAXIMUM_PUBLICATION_DIAGNOSTIC_TARGETS_PER_OPERATION = 4_096;

function finiteNonNegative({ label, value }: { label: string; value: number }): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be finite and non-negative`);
  return value;
}

function safeNonNegativeInteger({ label, value }: { label: string; value: number }): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative safe integer`);
  return value;
}

function incrementSafe({ current, delta, label }: { current: number; delta: number; label: string }): number {
  const value = current + safeNonNegativeInteger({ label, value: delta });
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} is exhausted`);
  return value;
}

function phaseCounters(): Record<HizoFSRuntimeDiagnosticPhase, MutablePhaseCounter> {
  return Object.fromEntries(HIZOFS_RUNTIME_DIAGNOSTIC_PHASES.map(phase => [phase, {
    operationCount: 0,
    totalDurationMs: 0,
  }])) as Record<HizoFSRuntimeDiagnosticPhase, MutablePhaseCounter>;
}

function recordCounters(): Record<HizoFSV1PersistedRecordKindDiagnosticName, MutableRecordCounter> {
  return Object.fromEntries(HIZOFS_V1_PERSISTED_RECORD_KIND_DIAGNOSTIC_NAMES.map(name => [name, {
    readOperations: 0,
    writeOperations: 0,
    cacheHits: 0,
    cacheMisses: 0,
    plaintextBytesRead: 0,
    plaintextBytesWritten: 0,
    physicalBytesRead: 0,
    physicalBytesWritten: 0,
  }])) as Record<HizoFSV1PersistedRecordKindDiagnosticName, MutableRecordCounter>;
}

function cacheCounters(): Record<HizoFSRuntimeDiagnosticCache, MutableCacheCounter> {
  return Object.fromEntries(HIZOFS_RUNTIME_DIAGNOSTIC_CACHES.map(cache => [cache, {
    hits: 0,
    misses: 0,
    evictions: 0,
    currentBytes: 0,
    maximumBytes: 0,
    currentEntries: 0,
    maximumEntries: 0,
  }])) as Record<HizoFSRuntimeDiagnosticCache, MutableCacheCounter>;
}

function resourceCounters(): Record<HizoFSRuntimeDiagnosticResource, MutableResourceCounter> {
  return Object.fromEntries(HIZOFS_RUNTIME_DIAGNOSTIC_RESOURCES.map(resource => [resource, {
    currentBytes: 0,
    maximumBytes: 0,
    currentOperations: 0,
    maximumOperations: 0,
  }])) as Record<HizoFSRuntimeDiagnosticResource, MutableResourceCounter>;
}

function coordinatorCounters(): Record<HizoFSRuntimeDiagnosticCoordinatorCounter, number> {
  return Object.fromEntries(
    HIZOFS_RUNTIME_DIAGNOSTIC_COORDINATOR_COUNTERS.map(counter => [counter, 0]),
  ) as Record<HizoFSRuntimeDiagnosticCoordinatorCounter, number>;
}

function publicationAccessCounter(): MutablePublicationAccessCounter {
  return {
    duplicateOperations: 0,
    maximumOperationsPerPublication: 0,
    operations: 0,
    observedUniqueTargets: 0,
    truncatedPublications: 0,
    unclassifiedOperations: 0,
  };
}

function publicationCounter(): MutablePublicationCounter {
  return {
    completed: 0,
    overlapping: 0,
    getFileSize: publicationAccessCounter(),
    readExact: publicationAccessCounter(),
  };
}

function segmentWriterCounters(): Record<"data" | "metadata" | "relocation", MutableSegmentWriterCounter> {
  return Object.fromEntries((["data", "metadata", "relocation"] as const).map(segmentClass => [segmentClass, {
    appendOperations: 0,
    created: 0,
    rollovers: 0,
    trustedTailMatches: 0,
    trustedTailMismatches: 0,
  }])) as Record<"data" | "metadata" | "relocation", MutableSegmentWriterCounter>;
}

function persistedRecordKindDiagnosticName({ recordKind }: {
  recordKind: number;
}): HizoFSV1PersistedRecordKindDiagnosticName {
  for (const name of HIZOFS_V1_PERSISTED_RECORD_KIND_DIAGNOSTIC_NAMES) {
    if (HIZOFS_V1_FORMAT_CONSTANTS.recordKinds[name] === recordKind) return name;
  }
  throw new TypeError(`unknown HizoFS V1 persisted record kind: ${recordKind}`);
}

function codecDiagnosticPhase({ format, operation }: {
  format: AuthenticatedCodecDiagnosticsObservation["format"];
  operation: AuthenticatedCodecDiagnosticsObservation["operation"];
}): HizoFSRuntimeDiagnosticPhase {
  switch (format) {
  case "envelope":
    switch (operation) {
    case "decode": return "envelope_decode";
    case "encode": return "envelope_encode";
    default: return operation satisfies never;
    }
  case "record":
    switch (operation) {
    case "decode": return "record_decode";
    case "encode": return "record_encode";
    default: return operation satisfies never;
    }
  default: return format satisfies never;
  }
}

/**
 * Collects non-secret runtime measurements without deciding when they are
 * complete enough to expose as a benchmark result. The composition root keeps
 * diagnostics unavailable until every required production hook is connected;
 * this accumulator must never be used to manufacture unobserved zero values.
 */
export class HizoFSRuntimeDiagnosticsAccumulator implements AuthenticatedStoreDiagnosticsPort, ImmutableBTreeDiagnosticsPort {
  readonly #phases = phaseCounters();
  readonly #records = recordCounters();
  readonly #caches = cacheCounters();
  readonly #resources = resourceCounters();
  readonly #coordinator = coordinatorCounters();
  readonly #publication = publicationCounter();
  readonly #segmentWriters = segmentWriterCounters();
  #activePublicationDepth = 0;
  #activePublicationScope: ActivePublicationScope | undefined;

  recordPhase({ durationMs, phase }: { durationMs: number; phase: HizoFSRuntimeDiagnosticPhase }): void {
    const counter = this.#phases[phase];
    const operationCount = incrementSafe({ current: counter.operationCount, delta: 1, label: `${phase} operation count` });
    const totalDurationMs = counter.totalDurationMs
      + finiteNonNegative({ label: `${phase} duration`, value: durationMs });
    if (!Number.isFinite(totalDurationMs)) throw new RangeError(`${phase} duration total is exhausted`);
    counter.operationCount = operationCount;
    counter.totalDurationMs = totalDurationMs;
  }

  recordRecord({ cacheHit, operation, physicalBytes, plaintextBytes, recordKind }: {
    cacheHit: boolean | undefined;
    operation: "read" | "write";
    physicalBytes: number;
    plaintextBytes: number;
    recordKind: HizoFSV1PersistedRecordKindDiagnosticName;
  }): void {
    const counter = this.#records[recordKind];
    const next = { ...counter };
    const physical = safeNonNegativeInteger({ label: `${recordKind} physical bytes`, value: physicalBytes });
    const plaintext = safeNonNegativeInteger({ label: `${recordKind} plaintext bytes`, value: plaintextBytes });
    switch (operation) {
    case "read":
      next.readOperations = incrementSafe({ current: next.readOperations, delta: 1, label: `${recordKind} read operations` });
      next.plaintextBytesRead = incrementSafe({ current: next.plaintextBytesRead, delta: plaintext, label: `${recordKind} plaintext bytes read` });
      next.physicalBytesRead = incrementSafe({ current: next.physicalBytesRead, delta: physical, label: `${recordKind} physical bytes read` });
      break;
    case "write":
      next.writeOperations = incrementSafe({ current: next.writeOperations, delta: 1, label: `${recordKind} write operations` });
      next.plaintextBytesWritten = incrementSafe({ current: next.plaintextBytesWritten, delta: plaintext, label: `${recordKind} plaintext bytes written` });
      next.physicalBytesWritten = incrementSafe({ current: next.physicalBytesWritten, delta: physical, label: `${recordKind} physical bytes written` });
      break;
    default: operation satisfies never;
    }
    switch (cacheHit) {
    case true:
      next.cacheHits = incrementSafe({ current: next.cacheHits, delta: 1, label: `${recordKind} cache hits` });
      break;
    case false:
      next.cacheMisses = incrementSafe({ current: next.cacheMisses, delta: 1, label: `${recordKind} cache misses` });
      break;
    case undefined: break;
    default: cacheHit satisfies never;
    }
    Object.assign(counter, next);
  }

  recordCodecOperation({ durationMs, format, operation }: AuthenticatedCodecDiagnosticsObservation): void {
    this.recordPhase({
      durationMs,
      phase: codecDiagnosticPhase({ format, operation }),
    });
  }

  recordCryptoOperation({ durationMs, operation }: AuthenticatedCryptoDiagnosticsObservation): void {
    switch (operation) {
    case "decrypt":
      this.recordPhase({ durationMs, phase: "object_decrypt" });
      return;
    case "encrypt":
      this.recordPhase({ durationMs, phase: "object_encrypt" });
      return;
    default:
      operation satisfies never;
    }
  }

  recordPersistedRecord({ operation, physicalBytes, plaintextBytes, recordKind }: AuthenticatedRecordDiagnosticsObservation): void {
    this.recordRecord({
      cacheHit: undefined,
      operation,
      physicalBytes,
      plaintextBytes,
      recordKind: persistedRecordKindDiagnosticName({ recordKind }),
    });
  }

  recordPublicationOperation({ durationMs }: AuthenticatedPublicationDiagnosticsObservation): void {
    this.recordPhase({ durationMs, phase: "commit_publication" });
  }

  recordIndexOperation({ durationMs, operation }: ImmutableBTreeDiagnosticsObservation): void {
    switch (operation) {
    case "build": this.recordPhase({ durationMs, phase: "index_build" }); return;
    case "update": this.recordPhase({ durationMs, phase: "index_update" }); return;
    default: operation satisfies never;
    }
  }

  recordMetadataCacheEvent({ event, recordKind }: AuthenticatedMetadataCacheEventObservation): void {
    this.recordCacheEvent({ cache: "metadata", event });
    switch (event) {
    case "eviction":
      return;
    case "hit": {
      const recordName = persistedRecordKindDiagnosticName({ recordKind });
      const counter = this.#records[recordName];
      counter.cacheHits = incrementSafe({ current: counter.cacheHits, delta: 1, label: `${recordName} cache hits` });
      return;
    }
    case "miss": {
      const recordName = persistedRecordKindDiagnosticName({ recordKind });
      const counter = this.#records[recordName];
      counter.cacheMisses = incrementSafe({ current: counter.cacheMisses, delta: 1, label: `${recordName} cache misses` });
      return;
    }
    default: event satisfies never;
    }
  }

  recordPublicationScopeEvent({ event }: AuthenticatedPublicationScopeEventObservation): void {
    switch (event) {
    case "begin": {
      this.#activePublicationDepth = incrementSafe({
        current: this.#activePublicationDepth,
        delta: 1,
        label: "active publication diagnostic depth",
      });
      if (this.#activePublicationDepth === 1) {
        this.#activePublicationScope = {
          getFileSizeDuplicateOperations: 0,
          getFileSizeOperations: 0,
          getFileSizeTargets: new Set<string>(),
          getFileSizeUnclassifiedOperations: 0,
          readExactDuplicateOperations: 0,
          readExactOperations: 0,
          readExactTargets: new Set<string>(),
          readExactUnclassifiedOperations: 0,
        };
      } else {
        this.#publication.overlapping = incrementSafe({
          current: this.#publication.overlapping,
          delta: 1,
          label: "overlapping publication diagnostics",
        });
        this.#activePublicationScope = undefined;
      }
      return;
    }
    case "end": {
      if (this.#activePublicationDepth === 0) return;
      this.#activePublicationDepth -= 1;
      if (this.#activePublicationDepth !== 0) return;
      const scope = this.#activePublicationScope;
      this.#activePublicationScope = undefined;
      if (scope === undefined) return;
      this.#publication.completed = incrementSafe({
        current: this.#publication.completed,
        delta: 1,
        label: "completed publication diagnostics",
      });
      this.#finalizePublicationAccess({
        counter: this.#publication.getFileSize,
        duplicateOperations: scope.getFileSizeDuplicateOperations,
        operations: scope.getFileSizeOperations,
        observedUniqueTargets: scope.getFileSizeTargets.size,
        unclassifiedOperations: scope.getFileSizeUnclassifiedOperations,
      });
      this.#finalizePublicationAccess({
        counter: this.#publication.readExact,
        duplicateOperations: scope.readExactDuplicateOperations,
        operations: scope.readExactOperations,
        observedUniqueTargets: scope.readExactTargets.size,
        unclassifiedOperations: scope.readExactUnclassifiedOperations,
      });
      return;
    }
    default: event satisfies never;
    }
  }

  recordPublicationPhysicalAccess({ identity, operation }: {
    identity: string;
    operation: "get_file_size" | "read_exact";
  }): void {
    const scope = this.#activePublicationScope;
    if (this.#activePublicationDepth !== 1 || scope === undefined) return;
    switch (operation) {
    case "get_file_size":
      scope.getFileSizeOperations = incrementSafe({
        current: scope.getFileSizeOperations,
        delta: 1,
        label: "publication get-file-size operations",
      });
      if (scope.getFileSizeTargets.has(identity)) {
        scope.getFileSizeDuplicateOperations = incrementSafe({
          current: scope.getFileSizeDuplicateOperations,
          delta: 1,
          label: "publication get-file-size duplicate operations",
        });
      } else if (scope.getFileSizeTargets.size < MAXIMUM_PUBLICATION_DIAGNOSTIC_TARGETS_PER_OPERATION) {
        scope.getFileSizeTargets.add(identity);
      } else {
        scope.getFileSizeUnclassifiedOperations = incrementSafe({
          current: scope.getFileSizeUnclassifiedOperations,
          delta: 1,
          label: "publication get-file-size unclassified operations",
        });
      }
      return;
    case "read_exact":
      scope.readExactOperations = incrementSafe({
        current: scope.readExactOperations,
        delta: 1,
        label: "publication read-exact operations",
      });
      if (scope.readExactTargets.has(identity)) {
        scope.readExactDuplicateOperations = incrementSafe({
          current: scope.readExactDuplicateOperations,
          delta: 1,
          label: "publication read-exact duplicate operations",
        });
      } else if (scope.readExactTargets.size < MAXIMUM_PUBLICATION_DIAGNOSTIC_TARGETS_PER_OPERATION) {
        scope.readExactTargets.add(identity);
      } else {
        scope.readExactUnclassifiedOperations = incrementSafe({
          current: scope.readExactUnclassifiedOperations,
          delta: 1,
          label: "publication read-exact unclassified operations",
        });
      }
      return;
    default: operation satisfies never;
    }
  }

  recordSegmentWriterEvent({ event, segmentClass }: AuthenticatedSegmentWriterDiagnosticsObservation): void {
    const counter = this.#segmentWriters[segmentClass];
    switch (event) {
    case "append_started":
      counter.appendOperations = incrementSafe({ current: counter.appendOperations, delta: 1, label: `${segmentClass} append operations` });
      return;
    case "created":
      counter.created = incrementSafe({ current: counter.created, delta: 1, label: `${segmentClass} writer creations` });
      return;
    case "rollover":
      counter.rollovers = incrementSafe({ current: counter.rollovers, delta: 1, label: `${segmentClass} writer rollovers` });
      return;
    case "trusted_tail_match":
      counter.trustedTailMatches = incrementSafe({ current: counter.trustedTailMatches, delta: 1, label: `${segmentClass} trusted-tail matches` });
      return;
    case "trusted_tail_mismatch":
      counter.trustedTailMismatches = incrementSafe({ current: counter.trustedTailMismatches, delta: 1, label: `${segmentClass} trusted-tail mismatches` });
      return;
    default: event satisfies never;
    }
  }

  #finalizePublicationAccess({ counter, duplicateOperations, operations, observedUniqueTargets, unclassifiedOperations }: {
    counter: MutablePublicationAccessCounter;
    duplicateOperations: number;
    operations: number;
    observedUniqueTargets: number;
    unclassifiedOperations: number;
  }): void {
    counter.operations = incrementSafe({ current: counter.operations, delta: operations, label: "publication access operations" });
    counter.observedUniqueTargets = incrementSafe({ current: counter.observedUniqueTargets, delta: observedUniqueTargets, label: "publication unique access targets" });
    counter.duplicateOperations = incrementSafe({
      current: counter.duplicateOperations,
      delta: duplicateOperations,
      label: "publication duplicate access operations",
    });
    counter.unclassifiedOperations = incrementSafe({
      current: counter.unclassifiedOperations,
      delta: unclassifiedOperations,
      label: "publication unclassified access operations",
    });
    if (unclassifiedOperations > 0) {
      counter.truncatedPublications = incrementSafe({
        current: counter.truncatedPublications,
        delta: 1,
        label: "publication truncated access diagnostics",
      });
    }
    counter.maximumOperationsPerPublication = Math.max(counter.maximumOperationsPerPublication, operations);
  }

  recordCacheEvent({ cache, event }: {
    cache: HizoFSRuntimeDiagnosticCache;
    event: "eviction" | "hit" | "miss";
  }): void {
    const counter = this.#caches[cache];
    switch (event) {
    case "eviction": counter.evictions = incrementSafe({ current: counter.evictions, delta: 1, label: `${cache} evictions` }); return;
    case "hit": counter.hits = incrementSafe({ current: counter.hits, delta: 1, label: `${cache} hits` }); return;
    case "miss": counter.misses = incrementSafe({ current: counter.misses, delta: 1, label: `${cache} misses` }); return;
    default: event satisfies never;
    }
  }

  setCacheUsage({ bytes, cache, entries }: {
    bytes: number;
    cache: HizoFSRuntimeDiagnosticCache;
    entries: number;
  }): void {
    const counter = this.#caches[cache];
    const currentBytes = safeNonNegativeInteger({ label: `${cache} current bytes`, value: bytes });
    const currentEntries = safeNonNegativeInteger({ label: `${cache} current entries`, value: entries });
    counter.currentBytes = currentBytes;
    counter.currentEntries = currentEntries;
    counter.maximumBytes = Math.max(counter.maximumBytes, currentBytes);
    counter.maximumEntries = Math.max(counter.maximumEntries, currentEntries);
  }

  setMetadataCacheUsage({ bytes, entries }: {
    bytes: number;
    entries: number;
  }): void {
    this.setCacheUsage({ bytes, cache: "metadata", entries });
  }

  setResourceUsage({ bytes, operations, resource }: {
    bytes: number;
    operations: number;
    resource: HizoFSRuntimeDiagnosticResource;
  }): void {
    const counter = this.#resources[resource];
    const currentBytes = safeNonNegativeInteger({ label: `${resource} current bytes`, value: bytes });
    const currentOperations = safeNonNegativeInteger({ label: `${resource} current operations`, value: operations });
    counter.currentBytes = currentBytes;
    counter.currentOperations = currentOperations;
    counter.maximumBytes = Math.max(counter.maximumBytes, currentBytes);
    counter.maximumOperations = Math.max(counter.maximumOperations, currentOperations);
  }

  incrementCoordinator({ counter }: { counter: HizoFSRuntimeDiagnosticCoordinatorCounter }): void {
    this.#coordinator[counter] = incrementSafe({
      current: this.#coordinator[counter],
      delta: 1,
      label: `${counter} coordinator count`,
    });
  }

  resetHighWaterMarks(): void {
    for (const cache of HIZOFS_RUNTIME_DIAGNOSTIC_CACHES) {
      const counter = this.#caches[cache];
      counter.maximumBytes = counter.currentBytes;
      counter.maximumEntries = counter.currentEntries;
    }
    for (const resource of HIZOFS_RUNTIME_DIAGNOSTIC_RESOURCES) {
      const counter = this.#resources[resource];
      counter.maximumBytes = counter.currentBytes;
      counter.maximumOperations = counter.currentOperations;
    }
    this.#publication.getFileSize.maximumOperationsPerPublication = 0;
    this.#publication.readExact.maximumOperationsPerPublication = 0;
  }

  snapshot(): HizoFSRuntimeDiagnosticsSnapshot {
    return structuredClone({
      phases: this.#phases,
      records: this.#records,
      caches: this.#caches,
      resources: this.#resources,
      coordinator: this.#coordinator,
      publication: this.#publication,
      segmentWriters: this.#segmentWriters,
    });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
