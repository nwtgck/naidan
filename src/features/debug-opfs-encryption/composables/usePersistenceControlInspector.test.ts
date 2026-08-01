import { describe, expect, it, vi } from "vitest";
import {
  installPersistenceControlInspectionSource,
  usePersistenceControlInspector,
} from "@/features/debug-opfs-encryption/composables/usePersistenceControlInspector";
import type { PersistenceControlInspectionSource } from "@/features/debug-opfs-encryption/logic/persistence-control-inspection-source";

function source(): PersistenceControlInspectionSource {
  return { inspectPersistenceControl: vi.fn(async () => {
    throw new Error("not called");
  }) };
}

describe("Persistence Control Inspector source composition", () => {
  it("does not let stale provider cleanup remove a newer source", () => {
    const first = source();
    const second = source();
    const disposeFirst = installPersistenceControlInspectionSource({ source: first });
    expect(usePersistenceControlInspector().persistenceControlInspectionSource.value).toBe(first);

    const disposeSecond = installPersistenceControlInspectionSource({ source: second });
    disposeFirst();
    expect(usePersistenceControlInspector().persistenceControlInspectionSource.value).toBe(second);

    disposeSecond();
    expect(usePersistenceControlInspector().persistenceControlInspectionSource.value).toBeUndefined();
  });
});
