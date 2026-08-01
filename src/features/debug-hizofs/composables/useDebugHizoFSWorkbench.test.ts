import { describe, expect, it, vi } from "vitest";
import {
  installHizoFSPhysicalInspectionSource,
  useDebugHizoFSWorkbench,
} from "@/features/debug-hizofs/composables/useDebugHizoFSWorkbench";
import type { HizoFSPhysicalInspectionSource } from "@/features/debug-hizofs/logic/active-physical-inspection-source";

function source(): HizoFSPhysicalInspectionSource {
  return { open: vi.fn(async () => {
    throw new Error("not called");
  }) };
}

describe("HizoFS Workbench source composition", () => {
  it("does not let stale provider cleanup remove a newer source", () => {
    const first = source();
    const second = source();
    const disposeFirst = installHizoFSPhysicalInspectionSource({ source: first });
    expect(useDebugHizoFSWorkbench().physicalInspectionSource.value).toBe(first);

    const disposeSecond = installHizoFSPhysicalInspectionSource({ source: second });
    disposeFirst();
    expect(useDebugHizoFSWorkbench().physicalInspectionSource.value).toBe(second);

    disposeSecond();
    expect(useDebugHizoFSWorkbench().physicalInspectionSource.value).toBeUndefined();
  });
});
