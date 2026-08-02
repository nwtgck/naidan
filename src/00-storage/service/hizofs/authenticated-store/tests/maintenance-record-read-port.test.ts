import { describe, expect, it, vi } from "vitest";
import { parseFileSystemId } from "@/00-storage/service/hizofs/00-format";
import { createInitialBootstrapSegment } from "@/00-storage/service/hizofs/authenticated-store/bootstrap-segment-store";
import {
  createAuthenticatedMaintenanceRecordPort,
  TEST_ONLY,
} from "@/00-storage/service/hizofs/authenticated-store/maintenance-record-read-port";
import type { AuthenticatedHizoFSPhysicalBytes } from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";
import { generateFileSystemRootKey, type RandomByteSource } from "@/00-storage/service/hizofs/01-crypto";
import { InMemoryCrashDurabilityBackend } from "@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend";
import type { AuthenticatedStoreDiagnosticsPort } from "@/00-storage/service/hizofs/authenticated-store/runtime-diagnostics-port";

function deterministicRandomSource(): RandomByteSource {
  let next = 1;
  return ({ bytes }) => {
    for (let index = 0; index < bytes.byteLength; index += 1) {
      bytes[index] = next;
      next = next === 251 ? 1 : next + 1;
    }
  };
}

function downstream(): AuthenticatedStoreDiagnosticsPort {
  return {
    recordCodecOperation: vi.fn(),
    recordCryptoOperation: vi.fn(),
    recordPersistedRecord: vi.fn(),
    recordPublicationOperation: vi.fn(),
  };
}

describe("authenticated maintenance record read port", () => {
  it("binds logical reads to authenticated-store and reports measured record bytes", async () => {
    const backend = new InMemoryCrashDurabilityBackend<AuthenticatedHizoFSPhysicalBytes>({});
    const randomSource = deterministicRandomSource();
    const rootKey = generateFileSystemRootKey({ randomSource });
    const fileSystemId = parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" });
    const created = await createInitialBootstrapSegment({ backend, fileSystemId, randomSource, rootKey });
    const port = createAuthenticatedMaintenanceRecordPort({
      backend,
      fileSystemId,
      relocationIndexRootPhysicalRef: null,
      rootKey,
    });

    const result = await port.readLogicalRecord({ reference: created.activeCommitHomeRef });
    expect(result.record.physicalReference).toEqual(created.activeCommitHomeRef);
    expect(result.physicalBytesRead).toBe(created.activeCommitHomeRef.frameLength);
    rootKey.destroy();
  });
});

describe("authenticated maintenance record read meter", () => {
  it("counts every authenticated physical read while forwarding diagnostics", () => {
    const target = downstream();
    const meter = TEST_ONLY.createReadByteMeter({ downstream: target });

    meter.diagnostics.recordPersistedRecord({ operation: "read", physicalBytes: 96, plaintextBytes: 20, recordKind: 1 });
    meter.diagnostics.recordPersistedRecord({ operation: "read", physicalBytes: 128, plaintextBytes: 40, recordKind: 2 });
    meter.diagnostics.recordPersistedRecord({ operation: "write", physicalBytes: 256, plaintextBytes: 80, recordKind: 3 });

    expect(meter.physicalBytesRead()).toBe(224);
    expect(target.recordPersistedRecord).toHaveBeenCalledTimes(3);
  });

  it("rejects aggregate read-byte overflow", () => {
    const meter = TEST_ONLY.createReadByteMeter({ downstream: undefined });
    meter.diagnostics.recordPersistedRecord({
      operation: "read",
      physicalBytes: Number.MAX_SAFE_INTEGER,
      plaintextBytes: 1,
      recordKind: 1,
    });
    expect(() => meter.diagnostics.recordPersistedRecord({
      operation: "read",
      physicalBytes: 1,
      plaintextBytes: 1,
      recordKind: 1,
    })).toThrowError(RangeError);
  });
});
