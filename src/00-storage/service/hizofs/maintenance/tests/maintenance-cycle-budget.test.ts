import { describe, expect, it } from "vitest";
import {
  MaintenanceCycleBudget,
  MaintenanceCycleBudgetError,
} from "@/00-storage/service/hizofs/maintenance/maintenance-cycle-budget";
import { createMaintenancePolicy } from "@/00-storage/service/hizofs/maintenance/maintenance-policy";

describe("maintenance cycle hard budget", () => {
  it("tracks exact cycle counters without lossy arithmetic", () => {
    const budget = new MaintenanceCycleBudget({ policy: createMaintenancePolicy() });
    budget.consumeDecodedRecord({ bytesRead: 4096 });
    budget.consumeFollowedEdge();
    budget.consumeRevisitEncounter();
    expect(budget.snapshot()).toEqual({
      bytesRead: 4096,
      decodedRecords: 1,
      followedEdges: 1,
      revisitEncounters: 1,
    });
  });

  it.each([
    ["decodedRecords", () => {
      const budget = new MaintenanceCycleBudget({ policy: createMaintenancePolicy({ maxDecodedRecordsPerCycle: 1 }) });
      budget.consumeDecodedRecord({ bytesRead: 1 });
      budget.consumeDecodedRecord({ bytesRead: 1 });
    }],
    ["followedEdges", () => {
      const budget = new MaintenanceCycleBudget({ policy: createMaintenancePolicy({ maxFollowedEdgesPerCycle: 1 }) });
      budget.consumeFollowedEdge();
      budget.consumeFollowedEdge();
    }],
    ["bytesRead", () => {
      const budget = new MaintenanceCycleBudget({ policy: createMaintenancePolicy({ maxBytesReadPerCycle: 1 }) });
      budget.consumeDecodedRecord({ bytesRead: 2 });
    }],
    ["revisitEncounters", () => {
      const budget = new MaintenanceCycleBudget({ policy: createMaintenancePolicy({ maxRevisitsPerCycle: 1 }) });
      budget.consumeRevisitEncounter();
      budget.consumeRevisitEncounter();
    }],
  ])("fails closed when %s exceeds its cycle budget", (counter, operation) => {
    try {
      operation();
      expect.unreachable("budget must reject excess work");
    } catch (cause: unknown) {
      expect(cause).toBeInstanceOf(MaintenanceCycleBudgetError);
      expect(cause).toMatchObject({ code: "budget_exceeded", counter });
    }
  });

  it("does not partially increment decoded records when byte accounting is invalid", () => {
    const budget = new MaintenanceCycleBudget({ policy: createMaintenancePolicy() });
    expect(() => budget.consumeDecodedRecord({ bytesRead: -1 })).toThrowError(MaintenanceCycleBudgetError);
    expect(budget.snapshot()).toEqual({
      bytesRead: 0,
      decodedRecords: 0,
      followedEdges: 0,
      revisitEncounters: 0,
    });
  });
});
