import { describe, expect, it } from "vitest";
import { createMaintenancePolicy, MaintenancePolicyError } from "@/00-storage/service/hizofs/maintenance/maintenance-policy";

describe("HizoFS maintenance policy", () => {
  it("is disabled by default and freezes explicit bounded slice limits", () => {
    const policy = createMaintenancePolicy();
    expect(policy.enabled).toBe(false);
    expect(policy.maxCandidateSegmentsPerBatch).toBe(64);
    expect(policy.maxCapturedRoots).toBe(4096);
    expect(policy.maxBitsetBytesPerBatch).toBe(64 * 8192);
    expect(policy.maxFrameOrdinalAuthorityBytesPerBatch).toBe(4 * 1024 * 1024);
    expect(policy.maxDecodedRecordsPerSlice).toBe(256);
    expect(policy.maxDecodedRecordsPerCycle).toBe(1_000_000);
    expect(policy.maxDiagnosticEvents).toBe(512);
    expect(policy.maxBytesReadPerCycle).toBe(1024 * 1024 * 1024);
    expect(policy.maxCompactionBytesPerSlice).toBe(4 * 1024 * 1024);
    expect(policy.maxRelocationIndexPages).toBe(4096);
    expect(policy.maxRemovalsPerSlice).toBe(4);
    expect(policy.removeConcurrency).toBe(1);
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it("allows an explicitly enabled policy without changing persisted authority", () => {
    expect(createMaintenancePolicy({ enabled: true }).enabled).toBe(true);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid candidate batch bound %s",
    value => {
      expect(() => createMaintenancePolicy({ maxCandidateSegmentsPerBatch: value }))
        .toThrowError(MaintenancePolicyError);
    },
  );

  it("rejects a batch whose worst-case ordinal bitsets exceed its memory budget", () => {
    try {
      createMaintenancePolicy({
        maxBitsetBytesPerBatch: 8192,
        maxCandidateSegmentsPerBatch: 2,
      });
      expect.unreachable("policy must reject an oversized candidate batch");
    } catch (cause: unknown) {
      expect(cause).toBeInstanceOf(MaintenancePolicyError);
      expect(cause).toMatchObject({ code: "bitset_budget_exceeded" });
    }
  });

  it("rejects remove concurrency greater than the per-slice removal bound", () => {
    try {
      createMaintenancePolicy({ maxRemovalsPerSlice: 1, removeConcurrency: 2 });
      expect.unreachable("policy must reject excessive remove concurrency");
    } catch (cause: unknown) {
      expect(cause).toBeInstanceOf(MaintenancePolicyError);
      expect(cause).toMatchObject({ code: "remove_concurrency_exceeded" });
    }
  });
});
