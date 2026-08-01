import { describe, expect, it } from "vitest";
import { createRuntimePolicy } from "@/00-storage/service/hizofs/runtime/runtime-policy";

describe("HizoFS runtime policy", () => {
  it("freezes explicit non-persisted memory and enumeration bounds", () => {
    const policy = createRuntimePolicy({
      maxDirectoryIteratorEntries: 64,
      maxHeldLockNames: 128,
      maxMaintenanceRootRegistrations: 128,
      maxReaderPins: 32,
      maxSegmentReferences: 96,
    });
    expect(policy).toEqual({
      maxDirectoryIteratorEntries: 64,
      maxHeldLockNames: 128,
      maxMaintenanceRootRegistrations: 128,
      maxReaderPins: 32,
      maxSegmentReferences: 96,
    });
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it("rejects zero, negative, fractional, and unsafe bounds", () => {
    const baseline = {
      maxDirectoryIteratorEntries: 64,
      maxHeldLockNames: 128,
      maxMaintenanceRootRegistrations: 128,
      maxReaderPins: 32,
      maxSegmentReferences: 96,
    };
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createRuntimePolicy({ ...baseline, maxHeldLockNames: invalid }))
        .toThrowError(expect.objectContaining({ code: "invalid_runtime_limit" }));
    }
  });
});
