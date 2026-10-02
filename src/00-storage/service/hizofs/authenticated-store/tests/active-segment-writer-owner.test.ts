import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  parseFileSystemId,
  type SegmentId,
} from "@/00-storage/service/hizofs/00-format";
import {
  generateFileSystemRootKey,
  type RandomByteSource,
} from "@/00-storage/service/hizofs/01-crypto";
import {
  AuthenticatedSegmentWriterOwner,
  type AuthenticatedSegmentWriterLease,
} from "@/00-storage/service/hizofs/authenticated-store/active-segment-writer-owner";
import type { AuthenticatedHizoFSPhysicalBytes } from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
import {
  AuthenticatedSegmentCapacityError,
  encodedHizoFSRecord,
  type AuthenticatedSegmentWriter,
} from "@/00-storage/service/hizofs/authenticated-store/record-appender";
import { DeterministicPhysicalStoreFaultInjector, InjectedPhysicalStoreFault } from "@/00-storage/service/hizofs/physical-store/testing/deterministic-fault-injector";
import { InMemoryCrashDurabilityBackend } from "@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend";
import { describe, expect, it, vi } from "vitest";

class CountingInMemoryBackend
  extends InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes> {
  public closeFileOperations = 0;
  public openFileForUpdateOperations = 0;

  public override async closeFile(
    input: Parameters<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["closeFile"]>[0],
  ): ReturnType<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["closeFile"]> {
    this.closeFileOperations += 1;
    return await super.closeFile(input);
  }

  public override async openFileForUpdate(
    input: Parameters<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["openFileForUpdate"]>[0],
  ): ReturnType<InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>["openFileForUpdate"]> {
    this.openFileForUpdateOperations += 1;
    return await super.openFileForUpdate(input);
  }
}

function deterministicRandomSource(): RandomByteSource {
  let next = 1;
  return ({ bytes }) => {
    for (let index = 0; index < bytes.byteLength; index += 1) {
      bytes[index] = next;
      next = next === 251 ? 1 : next + 1;
    }
  };
}

function fixture({ faultInjector }: {
  faultInjector?: DeterministicPhysicalStoreFaultInjector;
} = {}) {
  const backend = new CountingInMemoryBackend({ faultInjector });
  const randomSource = deterministicRandomSource();
  const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
  const rootKey = generateFileSystemRootKey({ randomSource });
  const owner = new AuthenticatedSegmentWriterOwner({
    backend,
    fileSystemId,
    randomSource,
    rootKey,
    segmentClass: "metadata",
  });
  return { backend, owner, rootKey };
}

function record({ value }: { value: number }) {
  return encodedHizoFSRecord({
    plaintext: new Uint8Array([value]),
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
  });
}

async function appendOne({ lease, value }: {
  lease: AuthenticatedSegmentWriterLease;
  value: number;
}): Promise<Readonly<{ frameLength: number; segmentId: SegmentId; writer: AuthenticatedSegmentWriter }>> {
  let frameLength: number | undefined;
  let observedWriter: AuthenticatedSegmentWriter | undefined;
  await lease.append({
    append: async ({ writer }) => {
      observedWriter = writer;
      const [appended] = await writer.append({ records: [record({ value })] });
      if (appended === undefined) throw new Error("appended Record is missing");
      frameLength = appended.physicalReference.frameLength;
      return appended;
    },
  });
  if (observedWriter === undefined || frameLength === undefined) {
    throw new Error("active Segment writer append was not observed");
  }
  return { frameLength, segmentId: observedWriter.physicalSegmentId, writer: observedWriter };
}

describe("authenticated active Segment writer owner", () => {
  it("reuses one active Segment across sequential mutation leases", async () => {
    const value = fixture();
    try {
      const firstLease = value.owner.acquire();
      const first = await appendOne({ lease: firstLease, value: 1 });
      expect(firstLease.usage()).toEqual({ appendedEncryptedFrameBytes: first.frameLength });
      firstLease.release({ disposition: "reuse" });

      const secondLease = value.owner.acquire();
      const second = await appendOne({ lease: secondLease, value: 2 });
      expect(secondLease.usage()).toEqual({ appendedEncryptedFrameBytes: second.frameLength });
      secondLease.release({ disposition: "reuse" });

      expect(second.segmentId).toEqual(first.segmentId);
      expect(second.writer).toBe(first.writer);
      expect(value.backend.openFileForUpdateOperations).toBe(1);
      expect(value.backend.closeFileOperations).toBe(1);
      await value.owner.close();
      expect(first.writer.state).toBe("sealed");
      // Initial Segment creation closes once, then the retained append handle
      // and the separate Footer publication handle each close once.
      expect(value.backend.openFileForUpdateOperations).toBe(2);
      expect(value.backend.closeFileOperations).toBe(3);
      expect(value.backend.openHandleCount()).toBe(0);
    } finally {
      value.rootKey.destroy();
    }
  });

  it("rejects overlapping leases", async () => {
    const value = fixture();
    try {
      const lease = value.owner.acquire();
      expect(() => value.owner.acquire()).toThrow("already has a lease");
      lease.release({ disposition: "discard" });
      await value.owner.close();
    } finally {
      value.rootKey.destroy();
    }
  });

  it("replaces an outcome-unknown writer before the next lease", async () => {
    const injector = new DeterministicPhysicalStoreFaultInjector({
      schedule: [{ occurrence: 2, operation: "writeAt", timing: "after" }],
    });
    const value = fixture({ faultInjector: injector });
    try {
      const failedLease = value.owner.acquire();
      let failedSegmentId: SegmentId | undefined;
      await expect(failedLease.append({
        append: async ({ writer }) => {
          failedSegmentId = writer.physicalSegmentId;
          return await writer.append({ records: [record({ value: 1 })] });
        },
      })).rejects.toThrow("injected");
      failedLease.release({ disposition: "reuse" });

      const retryLease = value.owner.acquire();
      const retried = await appendOne({ lease: retryLease, value: 2 });
      retryLease.release({ disposition: "reuse" });
      expect(failedSegmentId).toBeDefined();
      expect(retried.segmentId).not.toEqual(failedSegmentId);
      await value.owner.close();
      injector.assertExhausted();
      expect(value.backend.openHandleCount()).toBe(0);
    } finally {
      value.rootKey.destroy();
    }
  });

  it("seals a nonempty Segment and retries on clean capacity rollover", async () => {
    const value = fixture();
    try {
      const firstLease = value.owner.acquire();
      const first = await appendOne({ lease: firstLease, value: 1 });
      expect(firstLease.usage()).toEqual({ appendedEncryptedFrameBytes: first.frameLength });
      firstLease.release({ disposition: "reuse" });

      const rolloverLease = value.owner.acquire();
      let attempts = 0;
      let retriedWriter: AuthenticatedSegmentWriter | undefined;
      await rolloverLease.append({
        append: async ({ writer }) => {
          attempts += 1;
          if (attempts === 1) {
            expect(writer).toBe(first.writer);
            throw new AuthenticatedSegmentCapacityError({
              capacity: "record_area",
              message: "test rollover",
            });
          }
          retriedWriter = writer;
          return await writer.append({ records: [record({ value: 2 })] });
        },
      });
      rolloverLease.release({ disposition: "reuse" });

      expect(attempts).toBe(2);
      expect(first.writer.state).toBe("sealed");
      expect(retriedWriter).toBeDefined();
      expect(retriedWriter).not.toBe(first.writer);
      await value.owner.close();
      expect(retriedWriter?.state).toBe("sealed");
    } finally {
      value.rootKey.destroy();
    }
  });

  it("counts durable Record Frame bytes even when the mutation callback fails afterward", async () => {
    const value = fixture();
    try {
      const lease = value.owner.acquire();
      let frameLength = 0;
      await expect(lease.append({
        append: async ({ writer }) => {
          const [appended] = await writer.append({ records: [record({ value: 3 })] });
          if (appended === undefined) throw new Error("appended Record is missing");
          frameLength = appended.physicalReference.frameLength;
          throw new Error("mutation failed after durable append");
        },
      })).rejects.toThrow("mutation failed after durable append");
      expect(lease.usage()).toEqual({ appendedEncryptedFrameBytes: frameLength });
      lease.release({ disposition: "discard" });
      await value.owner.close();
    } finally {
      value.rootKey.destroy();
    }
  });

  it.each(["initial", "rollover"] as const)("awaits every close caller after a failed %s append", async (attempt) => {
    const injector = new DeterministicPhysicalStoreFaultInjector({
      schedule: [{ occurrence: attempt === "rollover" ? 5 : 2, operation: "writeAt", timing: "after" }],
    });
    const value = fixture({ faultInjector: injector });
    const allowClose = Promise.withResolvers<void>();
    const closeStarted = Promise.withResolvers<void>();
    const originalClose = value.backend.closeFile.bind(value.backend);
    let closeCalls = 0;
    value.backend.closeFile = async (input) => {
      closeCalls += 1;
      if (closeCalls === (attempt === "rollover" ? 5 : 2)) {
        closeStarted.resolve();
        await allowClose.promise;
      }
      await originalClose(input);
    };
    const payload = encodedHizoFSRecord({
      plaintext: new Uint8Array(64 * 1024),
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
    });
    try {
      const lease = value.owner.acquire();
      if (attempt === "rollover") {
        await lease.append({ append: ({ writer }) => writer.append({ records: Array.from({ length: 63 }, () => payload) }) });
      }
      let attempts = 0;
      await expect(lease.append({ append: ({ writer }) => {
        attempts += 1;
        return writer.append({ records: [payload] });
      } })).rejects.toThrow("injected");
      expect(attempts).toBe(attempt === "rollover" ? 2 : 1);
      lease.release({ disposition: "discard" });
      await closeStarted.promise;

      const settled: number[] = [];
      const firstClose = value.owner.close().then(() => {
        settled.push(1);
      });
      const secondClose = value.owner.close().then(() => {
        settled.push(2);
      });
      expect(value.owner.state()).toBe("closed");
      expect(() => value.owner.acquire()).toThrow("owner is closed");
      // Drain promise continuations, not elapsed time; the physical close is gated.
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
      const settledBeforePhysicalClose = [...settled];
      expect(value.backend.openHandleCount()).toBe(1);
      allowClose.resolve();
      await Promise.all([firstClose, secondClose]);
      expect(settledBeforePhysicalClose).toEqual([]);
      expect(settled).toEqual([1, 2]);
      await value.owner.close();
      injector.assertExhausted();
      expect(value.backend.openHandleCount()).toBe(0);
    } finally {
      allowClose.resolve();
      value.rootKey.destroy();
    }
  });

  it("retains rollover retry cleanup failure for every close caller", async () => {
    const injector = new DeterministicPhysicalStoreFaultInjector({ schedule: [
      { occurrence: 5, operation: "writeAt", timing: "after" },
      { occurrence: 5, operation: "closeFile", timing: "before" },
      { occurrence: 6, operation: "closeFile", timing: "before" },
    ] });
    const value = fixture({ faultInjector: injector });
    try {
      const payload = encodedHizoFSRecord({
        plaintext: new Uint8Array(64 * 1024),
        recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_system_commit,
      });
      const lease = value.owner.acquire();
      await lease.append({ append: ({ writer }) => writer.append({ records: Array.from({ length: 63 }, () => payload) }) });
      await expect(lease.append({ append: ({ writer }) => writer.append({ records: [payload] }) })).rejects.toThrow("injected");
      lease.release({ disposition: "discard" });
      const outcomes = await Promise.allSettled([value.owner.close(), value.owner.close()]);
      expect(outcomes[0]?.status).toBe("rejected");
      expect(outcomes[1]).toEqual(outcomes[0]);
      const firstOutcome = outcomes[0];
      if (firstOutcome?.status !== "rejected") throw new Error("close failure was not retained");
      expect(firstOutcome.reason).toBeInstanceOf(AggregateError);
      await expect(value.owner.close()).rejects.toBe(firstOutcome.reason);
      injector.assertExhausted();
      expect(value.backend.openHandleCount()).toBe(1);
    } finally {
      value.rootKey.destroy();
    }
  });

  it("does not close while a mutation lease is active", async () => {
    const value = fixture();
    try {
      const lease = value.owner.acquire();
      await expect(value.owner.close()).rejects.toThrow("lease is active");
      lease.release({ disposition: "discard" });
      await value.owner.close();
      expect(value.owner.state()).toBe("closed");
    } finally {
      value.rootKey.destroy();
    }
  });

  it.each([false, true])("settles an empty writer's retained handle when cleanup fails=%s", async (cleanupFails) => {
    const injector = new DeterministicPhysicalStoreFaultInjector({ schedule: [
      { occurrence: 1, operation: "getOpenFileSize", timing: "before" },
      ...(cleanupFails ? [
        { occurrence: 2, operation: "closeFile" as const, timing: "before" as const },
        { occurrence: 3, operation: "closeFile" as const, timing: "before" as const },
      ] : []),
    ] });
    const value = fixture({ faultInjector: injector });
    const closeStarted = Promise.withResolvers<void>();
    const allowClose = Promise.withResolvers<void>();
    const originalClose = value.backend.closeFile.bind(value.backend);
    let closeCalls = 0;
    value.backend.closeFile = async (input) => {
      closeCalls += 1;
      if (closeCalls === 2) {
        closeStarted.resolve();
        await allowClose.promise;
      }
      await originalClose(input);
    };
    try {
      const lease = value.owner.acquire();
      let observedWriter: AuthenticatedSegmentWriter | undefined;
      await expect(lease.append({ append: async ({ writer }) => {
        observedWriter = writer;
        return await writer.append({ records: [record({ value: 1 })] });
      } })).rejects.toThrow("injected");
      expect(observedWriter?.state).toBe("active");
      expect(observedWriter?.hasRecords()).toBe(false);
      expect(value.backend.openHandleCount()).toBe(1);
      lease.release({ disposition: "reuse" });

      const settled: number[] = [];
      const close = ({ index }: { index: number }) => value.owner.close().then(
        () => {
          settled.push(index);
          return { status: "fulfilled" as const };
        },
        (reason: unknown) => {
          settled.push(index);
          return { status: "rejected" as const, reason };
        },
      );
      const firstClose = close({ index: 1 });
      const secondClose = close({ index: 2 });
      await closeStarted.promise;
      for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
      const settledBeforePhysicalClose = [...settled];
      allowClose.resolve();
      const first = await firstClose;
      const second = await secondClose;
      expect(settledBeforePhysicalClose).toEqual([]);
      expect(first.status).toBe(cleanupFails ? "rejected" : "fulfilled");
      expect(second).toEqual(first);
      if (first.status === "rejected") {
        expect(first.reason).toBeInstanceOf(AggregateError);
        await expect(value.owner.close()).rejects.toBe(first.reason);
      } else {
        await value.owner.close();
      }
      injector.assertExhausted();
      expect(value.backend.openHandleCount()).toBe(cleanupFails ? 1 : 0);
    } finally {
      allowClose.resolve();
      value.rootKey.destroy();
    }
  });

  it("closes an empty writer without opening an append handle", async () => {
    const value = fixture();
    try {
      const lease = value.owner.acquire();
      await lease.append({ append: async ({ writer }) => {
        expect(writer.hasRecords()).toBe(false);
      } });
      lease.release({ disposition: "reuse" });
      expect(value.backend.closeFileOperations).toBe(1);
      await value.owner.close();
      expect(value.backend.openFileForUpdateOperations).toBe(0);
      expect(value.backend.closeFileOperations).toBe(1);
      expect(value.backend.openHandleCount()).toBe(0);
    } finally {
      value.rootKey.destroy();
    }
  });

  it("drains a retained update handle before replacing a discarded writer", async () => {
    const value = fixture();
    try {
      const firstLease = value.owner.acquire();
      const first = await appendOne({ lease: firstLease, value: 1 });
      expect(value.backend.openFileForUpdateOperations).toBe(1);
      expect(value.backend.closeFileOperations).toBe(1);
      firstLease.release({ disposition: "discard" });

      const secondLease = value.owner.acquire();
      const second = await appendOne({ lease: secondLease, value: 2 });
      expect(second.segmentId).not.toEqual(first.segmentId);
      expect(value.backend.closeFileOperations).toBe(3);
      expect(value.backend.openFileForUpdateOperations).toBe(2);
      secondLease.release({ disposition: "reuse" });
      await value.owner.close();
      expect(value.backend.openHandleCount()).toBe(0);
    } finally {
      value.rootKey.destroy();
    }
  });

  it.each([
    new InjectedPhysicalStoreFault({ occurrence: 2, operation: "closeFile", timing: "after" }),
    undefined,
  ])("fails closed when retained-handle cleanup is outcome-unknown (%s)", async failure => {
    const injector = new DeterministicPhysicalStoreFaultInjector({
      schedule: [{ occurrence: 2, operation: "closeFile", timing: "after" }],
    });
    const value = fixture({ faultInjector: injector });
    const originalClose = value.backend.closeFile.bind(value.backend);
    const close = vi.spyOn(value.backend, "closeFile").mockImplementation(async input => {
      try {
        await originalClose(input);
      } catch (cause: unknown) {
        if (cause instanceof InjectedPhysicalStoreFault
          && cause.operation === "closeFile" && cause.timing === "after" && cause.occurrence === 2) {
          throw failure;
        }
        throw cause;
      }
    });
    try {
      const firstLease = value.owner.acquire();
      await appendOne({ lease: firstLease, value: 1 });
      firstLease.release({ disposition: "discard" });

      const secondLease = value.owner.acquire();
      await expect(appendOne({ lease: secondLease, value: 2 }).then(() => undefined)).rejects.toBe(failure);
      await expect(appendOne({ lease: secondLease, value: 3 }).then(() => undefined)).rejects.toBe(failure);
      secondLease.release({ disposition: "discard" });
      await expect(value.owner.close()).rejects.toBe(failure);
      await expect(value.owner.close()).rejects.toBe(failure);
      injector.assertExhausted();
      expect(value.backend.closeFileOperations).toBe(3);
      expect(value.backend.openHandleCount()).toBe(0);
    } finally {
      close.mockRestore();
      value.rootKey.destroy();
    }
  });
});
