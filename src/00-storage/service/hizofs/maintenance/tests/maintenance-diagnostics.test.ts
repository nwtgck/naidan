import { describe, expect, it } from "vitest";
import { MaintenanceDiagnostics } from "@/00-storage/service/hizofs/maintenance/maintenance-diagnostics";

describe("maintenance diagnostics", () => {
  it("retains only a bounded deterministic suffix of non-secret events", () => {
    const diagnostics = new MaintenanceDiagnostics({ maximumEvents: 2 });
    diagnostics.record({ event: { phase: "marking", type: "phase_started" } });
    diagnostics.record({ event: { reason: "foreground_waiter", type: "yielded" } });
    diagnostics.record({ event: { copiedBytes: 4096, type: "compaction_progress" } });
    expect(diagnostics.snapshot()).toEqual([
      { sequence: 2, reason: "foreground_waiter", type: "yielded" },
      { copiedBytes: 4096, sequence: 3, type: "compaction_progress" },
    ]);
  });

  it("returns detached frozen snapshots and rejects invalid bounds or counters", () => {
    expect(() => new MaintenanceDiagnostics({ maximumEvents: 0 })).toThrow();
    const diagnostics = new MaintenanceDiagnostics({ maximumEvents: 1 });
    expect(() => diagnostics.record({ event: { copiedBytes: -1, type: "compaction_progress" } })).toThrow();
    diagnostics.record({ event: { removedSegments: 1, type: "sweep_progress" } });
    const snapshot = diagnostics.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
  });
});
