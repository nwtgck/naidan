import { describe, expect, it } from "vitest";
import {
  createHomeRecordReference,
  createUInt64,
  HIZOFS_V1_FORMAT_CONSTANTS,
  parseSegmentId,
} from "@/00-storage/service/hizofs/00-format";
import type { ContainerCoordinationKey } from "@/00-storage/service/hizofs/filesystem/container-coordination-key";
import { MaintenanceRootRegistry } from "@/00-storage/service/hizofs/runtime/maintenance-root-registry";
import { ReaderPinRegistry } from "@/00-storage/service/hizofs/runtime/reader-pin-registry";

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

function registries({ maxPins }: { maxPins: number }) {
  const maintenanceRoots = new MaintenanceRootRegistry({ maxRegistrationsPerContainer: maxPins + 2 });
  return {
    maintenanceRoots,
    readerPins: new ReaderPinRegistry({ maintenanceRoots, maxPinsPerContainer: maxPins }),
  };
}

describe("reader pin registry", () => {
  it("deduplicates roots while retaining every reader count", () => {
    const key = coordinationKey();
    const { maintenanceRoots, readerPins } = registries({ maxPins: 3 });
    const first = readerPins.acquire({ commitReference: commitReference(1), coordinationKey: key });
    const second = readerPins.acquire({ commitReference: commitReference(1), coordinationKey: key });
    const capture = maintenanceRoots.captureRoots({ coordinationKey: key });
    expect(capture.rootSets.readerPinnedRoots).toHaveLength(1);
    capture.release();
    first.release();
    const afterFirstRelease = maintenanceRoots.captureRoots({ coordinationKey: key });
    expect(afterFirstRelease.rootSets.readerPinnedRoots).toHaveLength(1);
    afterFirstRelease.release();
    second.release();
    const afterSecondRelease = maintenanceRoots.captureRoots({ coordinationKey: key });
    expect(afterSecondRelease.rootSets.readerPinnedRoots).toHaveLength(0);
    afterSecondRelease.release();
  });

  it("advances the shared maintenance root epoch only for successful pin registrations", () => {
    const key = coordinationKey();
    const { maintenanceRoots, readerPins } = registries({ maxPins: 2 });

    const initial = maintenanceRoots.captureRoots({ coordinationKey: key });
    expect(initial.maintenanceRootEpoch).toBe(0);
    initial.release();

    const first = readerPins.acquire({ commitReference: commitReference(1), coordinationKey: key });
    const afterFirst = maintenanceRoots.captureRoots({ coordinationKey: key });
    expect(afterFirst.maintenanceRootEpoch).toBe(1);
    afterFirst.release();

    first.release();
    const afterRelease = maintenanceRoots.captureRoots({ coordinationKey: key });
    expect(afterRelease.maintenanceRootEpoch).toBe(1);
    afterRelease.release();

    readerPins.acquire({ commitReference: commitReference(2), coordinationKey: key });
    const afterSecond = maintenanceRoots.captureRoots({ coordinationKey: key });
    expect(afterSecond.maintenanceRootEpoch).toBe(2);
    afterSecond.release();
  });

  it("keeps byte-identical commit roots isolated by physical container identity", () => {
    const { maintenanceRoots, readerPins } = registries({ maxPins: 2 });
    const firstKey = coordinationKey();
    const copiedContainerKey = coordinationKey();
    readerPins.acquire({ commitReference: commitReference(1), coordinationKey: firstKey });
    const first = maintenanceRoots.captureRoots({ coordinationKey: firstKey });
    const copied = maintenanceRoots.captureRoots({ coordinationKey: copiedContainerKey });
    expect(first.rootSets.readerPinnedRoots).toHaveLength(1);
    expect(copied.rootSets.readerPinnedRoots).toHaveLength(0);
    first.release();
    copied.release();
  });

  it("blocks registration while maintenance owns the shared root capture gate", () => {
    const key = coordinationKey();
    const { maintenanceRoots, readerPins } = registries({ maxPins: 2 });
    const capture = maintenanceRoots.captureRoots({ coordinationKey: key });
    expect(() => readerPins.acquire({ commitReference: commitReference(1), coordinationKey: key }))
      .toThrowError(expect.objectContaining({ code: "registration_blocked" }));
    capture.release();
    expect(readerPins.acquire({ commitReference: commitReference(1), coordinationKey: key })).toBeDefined();
  });

  it("enforces a bounded number of active reader capabilities", () => {
    const key = coordinationKey();
    const { readerPins } = registries({ maxPins: 2 });
    readerPins.acquire({ commitReference: commitReference(1), coordinationKey: key });
    readerPins.acquire({ commitReference: commitReference(1), coordinationKey: key });
    expect(() => readerPins.acquire({ commitReference: commitReference(2), coordinationKey: key }))
      .toThrowError(expect.objectContaining({ code: "pin_limit_exceeded" }));
  });

  it("makes pin release idempotent", () => {
    const key = coordinationKey();
    const { maintenanceRoots, readerPins } = registries({ maxPins: 1 });
    const pin = readerPins.acquire({ commitReference: commitReference(1), coordinationKey: key });
    pin.release();
    pin.release();
    const capture = maintenanceRoots.captureRoots({ coordinationKey: key });
    expect(capture.rootSets.readerPinnedRoots).toHaveLength(0);
    capture.release();
  });
});
