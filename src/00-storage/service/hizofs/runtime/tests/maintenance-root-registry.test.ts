import { describe, expect, it } from "vitest";
import {
  createHomeRecordReference,
  createUInt64,
  HIZOFS_V1_FORMAT_CONSTANTS,
  parseSegmentId,
} from "@/00-storage/service/hizofs/00-format";
import type { ContainerCoordinationKey } from "@/00-storage/service/hizofs/filesystem/container-coordination-key";
import { MaintenanceRootRegistry } from "@/00-storage/service/hizofs/runtime/maintenance-root-registry";

function coordinationKey(): ContainerCoordinationKey {
  return Object.freeze({}) as ContainerCoordinationKey;
}

function commitReference(seed: number) {
  return createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: BigInt(seed * 64) }),
    frameLength: 96,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    segmentId: parseSegmentId({ bytes: Uint8Array.from({ length: 16 }, (_, index) => seed + index) }),
  } });
}

describe("maintenance root registry", () => {
  it("captures every explicit root category under one epoch", () => {
    const key = coordinationKey();
    const registry = new MaintenanceRootRegistry({ maxRegistrationsPerContainer: 8 });
    registry.acquireReaderPinnedRoot({ commitReference: commitReference(1), coordinationKey: key });
    registry.acquireSourceSegmentPinnedRoot({ commitReference: commitReference(2), coordinationKey: key });
    registry.acquireInspectorPinnedRoot({ commitReference: commitReference(3), coordinationKey: key });
    registry.acquireWriterDependencyRoot({ commitReference: commitReference(4), coordinationKey: key });
    registry.acquireUnknownFeatureRoot({ commitReference: commitReference(5), coordinationKey: key });

    const capture = registry.captureRoots({ coordinationKey: key });
    expect(capture.maintenanceRootEpoch).toBe(5);
    expect(capture.rootSets.readerPinnedRoots).toHaveLength(1);
    expect(capture.rootSets.sourceSegmentPinnedRoots).toHaveLength(1);
    expect(capture.rootSets.inspectorPinnedRoots).toHaveLength(1);
    expect(capture.rootSets.writerDependencyRoots).toHaveLength(1);
    expect(capture.rootSets.unknownFeatureRoots).toHaveLength(1);
    capture.release();
  });

  it("deduplicates equal roots per category while retaining every registration", () => {
    const key = coordinationKey();
    const registry = new MaintenanceRootRegistry({ maxRegistrationsPerContainer: 3 });
    const first = registry.acquireInspectorPinnedRoot({ commitReference: commitReference(1), coordinationKey: key });
    const second = registry.acquireInspectorPinnedRoot({ commitReference: commitReference(1), coordinationKey: key });
    const capture = registry.captureRoots({ coordinationKey: key });
    expect(capture.maintenanceRootEpoch).toBe(2);
    expect(capture.rootSets.inspectorPinnedRoots).toHaveLength(1);
    capture.release();
    first.release();
    const afterFirstRelease = registry.captureRoots({ coordinationKey: key });
    expect(afterFirstRelease.rootSets.inspectorPinnedRoots).toHaveLength(1);
    afterFirstRelease.release();
    second.release();
    const afterSecondRelease = registry.captureRoots({ coordinationKey: key });
    expect(afterSecondRelease.rootSets.inspectorPinnedRoots).toEqual([]);
    afterSecondRelease.release();
  });

  it("retains a monotonic epoch after a transient root is released", () => {
    const key = coordinationKey();
    const registry = new MaintenanceRootRegistry({ maxRegistrationsPerContainer: 2 });
    const registration = registry.acquireWriterDependencyRoot({
      commitReference: commitReference(1),
      coordinationKey: key,
    });
    registration.release();
    const capture = registry.captureRoots({ coordinationKey: key });
    expect(capture.maintenanceRootEpoch).toBe(1);
    expect(capture.rootSets.writerDependencyRoots).toEqual([]);
    capture.release();
  });

  it("blocks every category while maintenance owns root capture", () => {
    const key = coordinationKey();
    const registry = new MaintenanceRootRegistry({ maxRegistrationsPerContainer: 2 });
    const capture = registry.captureRoots({ coordinationKey: key });
    expect(() => registry.acquireUnknownFeatureRoot({
      commitReference: commitReference(1),
      coordinationKey: key,
    })).toThrowError(expect.objectContaining({ code: "registration_blocked" }));
    expect(() => registry.captureRoots({ coordinationKey: key }))
      .toThrowError(expect.objectContaining({ code: "root_capture_active" }));
    capture.release();
    expect(registry.acquireUnknownFeatureRoot({
      commitReference: commitReference(1),
      coordinationKey: key,
    })).toBeDefined();
  });

  it("enforces one aggregate memory bound across owners", () => {
    const key = coordinationKey();
    const registry = new MaintenanceRootRegistry({ maxRegistrationsPerContainer: 2 });
    registry.acquireReaderPinnedRoot({ commitReference: commitReference(1), coordinationKey: key });
    registry.acquireSourceSegmentPinnedRoot({ commitReference: commitReference(2), coordinationKey: key });
    expect(() => registry.acquireInspectorPinnedRoot({
      commitReference: commitReference(3),
      coordinationKey: key,
    })).toThrowError(expect.objectContaining({ code: "root_limit_exceeded" }));
  });

  it("isolates byte-identical roots by physical container identity", () => {
    const registry = new MaintenanceRootRegistry({ maxRegistrationsPerContainer: 2 });
    const firstKey = coordinationKey();
    const copiedContainerKey = coordinationKey();
    registry.acquireUnknownFeatureRoot({ commitReference: commitReference(1), coordinationKey: firstKey });
    const first = registry.captureRoots({ coordinationKey: firstKey });
    const copied = registry.captureRoots({ coordinationKey: copiedContainerKey });
    expect(first.rootSets.unknownFeatureRoots).toHaveLength(1);
    expect(copied.rootSets.unknownFeatureRoots).toEqual([]);
    first.release();
    copied.release();
  });
});
