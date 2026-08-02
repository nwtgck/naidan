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
  AuthenticatedPublicationDiagnosticsObservation,
  AuthenticatedRecordDiagnosticsObservation,
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

export type HizoFSRuntimeDiagnosticsSnapshot = Readonly<{
  phases: Readonly<Record<HizoFSRuntimeDiagnosticPhase, HizoFSRuntimePhaseCounter>>;
  records: Readonly<Record<HizoFSV1PersistedRecordKindDiagnosticName, HizoFSRuntimeRecordCounter>>;
  caches: Readonly<Record<HizoFSRuntimeDiagnosticCache, HizoFSRuntimeCacheCounter>>;
  resources: Readonly<Record<HizoFSRuntimeDiagnosticResource, HizoFSRuntimeResourceCounter>>;
  coordinator: Readonly<Record<HizoFSRuntimeDiagnosticCoordinatorCounter, number>>;
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

  recordMetadataCacheEvent({ event }: {
    event: "eviction" | "hit" | "miss";
  }): void {
    this.recordCacheEvent({ cache: "metadata", event });
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
  }

  snapshot(): HizoFSRuntimeDiagnosticsSnapshot {
    return structuredClone({
      phases: this.#phases,
      records: this.#records,
      caches: this.#caches,
      resources: this.#resources,
      coordinator: this.#coordinator,
    });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
