import { describe, expect, it } from "vitest";
import { HIZOFS_V1_FORMAT_CONSTANTS } from "@/00-storage/service/hizofs/00-format";
import {
  HIZOFS_RUNTIME_DIAGNOSTIC_PHASES,
  HizoFSRuntimeDiagnosticsAccumulator,
} from "@/00-storage/service/hizofs/runtime/runtime-diagnostics";

describe("HizoFS runtime diagnostics", () => {
  it("projects authenticated-store numeric record kinds through the canonical format authority", () => {
    const diagnostics = new HizoFSRuntimeDiagnosticsAccumulator();
    diagnostics.recordCodecOperation({ durationMs: 1.5, format: "envelope", operation: "encode" });
    diagnostics.recordCodecOperation({ durationMs: 1.75, format: "envelope", operation: "decode" });
    diagnostics.recordCryptoOperation({ durationMs: 2.5, operation: "encrypt" });
    diagnostics.recordCryptoOperation({ durationMs: 3.5, operation: "decrypt" });
    diagnostics.recordPublicationOperation({ durationMs: 4.5 });
    diagnostics.recordIndexOperation({ durationMs: 5.5, operation: "build" });
    diagnostics.recordIndexOperation({ durationMs: 6.5, operation: "update" });
    diagnostics.recordPersistedRecord({
      operation: "write",
      physicalBytes: 64,
      plaintextBytes: 17,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.directory_page,
    });

    expect(diagnostics.snapshot().phases.envelope_encode).toEqual({ operationCount: 1, totalDurationMs: 1.5 });
    expect(diagnostics.snapshot().phases.envelope_decode).toEqual({ operationCount: 1, totalDurationMs: 1.75 });
    expect(diagnostics.snapshot().phases.object_encrypt).toEqual({ operationCount: 1, totalDurationMs: 2.5 });
    expect(diagnostics.snapshot().phases.object_decrypt).toEqual({ operationCount: 1, totalDurationMs: 3.5 });
    expect(diagnostics.snapshot().phases.commit_publication).toEqual({ operationCount: 1, totalDurationMs: 4.5 });
    expect(diagnostics.snapshot().phases.index_build).toEqual({ operationCount: 1, totalDurationMs: 5.5 });
    expect(diagnostics.snapshot().phases.index_update).toEqual({ operationCount: 1, totalDurationMs: 6.5 });
    expect(diagnostics.snapshot().records.directory_page).toMatchObject({
      physicalBytesWritten: 64,
      plaintextBytesWritten: 17,
      writeOperations: 1,
    });
    expect(() => diagnostics.recordPersistedRecord({
      operation: "read",
      physicalBytes: 1,
      plaintextBytes: 1,
      recordKind: 255,
    })).toThrow("unknown HizoFS V1 persisted record kind");
  });

  it("tracks owner-side phase, record, cache, resource, and coordinator measurements", () => {
    const diagnostics = new HizoFSRuntimeDiagnosticsAccumulator();
    diagnostics.recordPhase({ durationMs: 1.25, phase: "record_encode" });
    diagnostics.recordRecord({
      cacheHit: false,
      operation: "write",
      physicalBytes: 128,
      plaintextBytes: 64,
      recordKind: "file_data",
    });
    diagnostics.recordCacheEvent({ cache: "fileChunk", event: "miss" });
    diagnostics.setCacheUsage({ bytes: 4096, cache: "fileChunk", entries: 2 });
    diagnostics.setResourceUsage({ bytes: 8192, operations: 3, resource: "writerDirtyChunks" });
    diagnostics.incrementCoordinator({ counter: "localRequests" });

    const snapshot = diagnostics.snapshot();
    expect(Object.keys(snapshot.phases)).toEqual(HIZOFS_RUNTIME_DIAGNOSTIC_PHASES);
    expect(snapshot.phases.record_encode).toEqual({ operationCount: 1, totalDurationMs: 1.25 });
    expect(snapshot.records.file_data).toMatchObject({
      cacheMisses: 1,
      plaintextBytesWritten: 64,
      physicalBytesWritten: 128,
      writeOperations: 1,
    });
    expect(snapshot.caches.fileChunk).toMatchObject({
      currentBytes: 4096,
      maximumBytes: 4096,
      currentEntries: 2,
      maximumEntries: 2,
      misses: 1,
    });
    expect(snapshot.resources.writerDirtyChunks).toMatchObject({
      currentBytes: 8192,
      maximumBytes: 8192,
      currentOperations: 3,
      maximumOperations: 3,
    });
    expect(snapshot.coordinator.localRequests).toBe(1);
  });

  it("resets only high-water marks to current usage and returns detached snapshots", () => {
    const diagnostics = new HizoFSRuntimeDiagnosticsAccumulator();
    diagnostics.setCacheUsage({ bytes: 20, cache: "metadata", entries: 2 });
    diagnostics.setCacheUsage({ bytes: 5, cache: "metadata", entries: 1 });
    diagnostics.setResourceUsage({ bytes: 40, operations: 4, resource: "readerPrefetch" });
    diagnostics.setResourceUsage({ bytes: 7, operations: 1, resource: "readerPrefetch" });
    const before = diagnostics.snapshot();
    diagnostics.resetHighWaterMarks();
    const after = diagnostics.snapshot();

    expect(before.caches.metadata.maximumBytes).toBe(20);
    expect(after.caches.metadata.maximumBytes).toBe(5);
    expect(after.caches.metadata.maximumEntries).toBe(1);
    expect(after.resources.readerPrefetch.maximumBytes).toBe(7);
    expect(after.resources.readerPrefetch.maximumOperations).toBe(1);
    expect(before).not.toBe(after);
  });

  it("rejects invalid measurements instead of corrupting counters", () => {
    const diagnostics = new HizoFSRuntimeDiagnosticsAccumulator();
    const before = diagnostics.snapshot();
    expect(() => diagnostics.recordPhase({ durationMs: Number.NaN, phase: "record_decode" })).toThrow();
    expect(() => diagnostics.recordRecord({
      cacheHit: undefined,
      operation: "read",
      physicalBytes: -1,
      plaintextBytes: 0,
      recordKind: "file_system_commit",
    })).toThrow();
    expect(() => diagnostics.setResourceUsage({
      bytes: 17,
      operations: 1.5,
      resource: "writerPendingChunkWrites",
    })).toThrow();
    expect(diagnostics.snapshot()).toEqual(before);
  });
});
