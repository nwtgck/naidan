import {
  DeterministicPhysicalStoreFaultInjector,
  type PhysicalStoreFaultScheduleEntry,
  type PhysicalStoreFaultTiming,
  type PhysicalStoreOperation,
} from "@/00-storage/service/hizofs/physical-store/testing/deterministic-fault-injector";

const PERSISTENCE_OPERATIONS = new Set<PhysicalStoreOperation>([
  "closeFile",
  "createDirectoryExclusive",
  "createFileExclusive",
  "openFileForUpdate",
  "removeFile",
  "syncDirectoryEntries",
  "syncFileData",
  "truncate",
  "writeAt",
]);

type DynamicFaultInjectorMode = "disabled" | "inject" | "record";

export class DynamicPhysicalStoreFaultCampaignInjector extends DeterministicPhysicalStoreFaultInjector {
  private readonly recordedCounts = new Map<string, number>();
  private readonly recordedPoints: PhysicalStoreFaultScheduleEntry[] = [];
  private mode: DynamicFaultInjectorMode = "disabled";
  private triggered = false;

  public constructor({ target }: { target: PhysicalStoreFaultScheduleEntry | undefined }) {
    super({ schedule: target === undefined ? [] : [target] });
  }

  public disable(): void {
    this.mode = "disabled";
  }

  public enableInjection(): void {
    this.mode = "inject";
  }

  public enableRecording(): void {
    this.recordedCounts.clear();
    this.recordedPoints.length = 0;
    this.mode = "record";
  }

  public override checkpoint({ operation, timing }: {
    operation: PhysicalStoreOperation;
    timing: PhysicalStoreFaultTiming;
  }): void {
    switch (this.mode) {
    case "disabled":
      return;
    case "record": {
      const key = `${operation}:${timing}`;
      const occurrence = (this.recordedCounts.get(key) ?? 0) + 1;
      this.recordedCounts.set(key, occurrence);
      this.recordedPoints.push({ occurrence, operation, timing });
      return;
    }
    case "inject":
      try {
        super.checkpoint({ operation, timing });
      } catch (cause: unknown) {
        this.triggered = true;
        throw cause;
      }
      return;
    default:
      this.mode satisfies never;
    }
  }

  public persistenceFaultPoints(): readonly PhysicalStoreFaultScheduleEntry[] {
    return Object.freeze(this.recordedPoints.filter(({ operation }) => PERSISTENCE_OPERATIONS.has(operation)));
  }

  public wasTriggered(): boolean {
    return this.triggered;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
