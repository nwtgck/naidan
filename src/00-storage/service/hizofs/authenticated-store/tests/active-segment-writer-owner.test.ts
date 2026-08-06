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
import { DeterministicPhysicalStoreFaultInjector } from "@/00-storage/service/hizofs/physical-store/testing/deterministic-fault-injector";
import { InMemoryCrashDurabilityBackend } from "@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend";
import { describe, expect, it } from "vitest";

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
  const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({ faultInjector });
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
      await value.owner.close();
      expect(first.writer.state).toBe("sealed");
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
});
