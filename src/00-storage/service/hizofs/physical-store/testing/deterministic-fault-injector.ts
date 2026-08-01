export const PHYSICAL_STORE_OPERATIONS = [
  'closeFile',
  'crashAndRecover',
  'createDirectoryExclusive',
  'createFileExclusive',
  'getFileSize',
  'list',
  'syncDirectoryEntries',
  'syncFileData',
  'openFileForUpdate',
  'readExact',
  'readFileBounded',
  'removeFile',
  'truncate',
  'writeAt',
] as const;

export type PhysicalStoreOperation = typeof PHYSICAL_STORE_OPERATIONS[number];
export type PhysicalStoreFaultTiming = 'after' | 'before';

export interface PhysicalStoreFaultScheduleEntry {
  readonly occurrence: number;
  readonly operation: PhysicalStoreOperation;
  readonly timing: PhysicalStoreFaultTiming;
}

export class InjectedPhysicalStoreFault extends Error {
  public readonly occurrence: number;
  public readonly operation: PhysicalStoreOperation;
  public readonly timing: PhysicalStoreFaultTiming;

  public constructor({ occurrence, operation, timing }: PhysicalStoreFaultScheduleEntry) {
    super(`injected physical-store fault at ${operation}.${timing} occurrence ${occurrence}`);
    this.name = 'InjectedPhysicalStoreFault';
    this.occurrence = occurrence;
    this.operation = operation;
    this.timing = timing;
  }
}

function faultKey({ occurrence, operation, timing }: PhysicalStoreFaultScheduleEntry): string {
  return `${operation}:${timing}:${occurrence}`;
}

export class DeterministicPhysicalStoreFaultInjector {
  readonly #counts = new Map<string, number>();
  readonly #pending = new Map<string, PhysicalStoreFaultScheduleEntry>();
  readonly #schedule: readonly PhysicalStoreFaultScheduleEntry[];

  public constructor({ schedule }: { schedule: readonly PhysicalStoreFaultScheduleEntry[] }) {
    const copiedSchedule = schedule.map((entry) => ({ ...entry }));
    for (const entry of copiedSchedule) {
      if (!Number.isSafeInteger(entry.occurrence) || entry.occurrence < 1) {
        throw new RangeError('physical-store fault occurrence must be a positive safe integer');
      }
      const key = faultKey(entry);
      if (this.#pending.has(key)) throw new TypeError(`duplicate physical-store fault schedule entry: ${key}`);
      this.#pending.set(key, entry);
    }
    this.#schedule = copiedSchedule;
  }

  public checkpoint({ operation, timing }: {
    operation: PhysicalStoreOperation;
    timing: PhysicalStoreFaultTiming;
  }): void {
    const point = `${operation}:${timing}`;
    const occurrence = (this.#counts.get(point) ?? 0) + 1;
    this.#counts.set(point, occurrence);
    const key = faultKey({ occurrence, operation, timing });
    const entry = this.#pending.get(key);
    if (entry === undefined) return;
    this.#pending.delete(key);
    throw new InjectedPhysicalStoreFault(entry);
  }

  public pendingFaults(): readonly PhysicalStoreFaultScheduleEntry[] {
    return this.#schedule.filter((entry) => this.#pending.has(faultKey(entry)));
  }

  public assertExhausted(): void {
    const pending = this.pendingFaults();
    if (pending.length === 0) return;
    throw new Error(`unobserved physical-store fault schedule entries: ${pending.map(faultKey).join(', ')}`);
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  faultKey,
};
