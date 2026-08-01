import {
  maintenanceTraversalItemIdentity,
  type MaintenanceTraversalItem,
} from "@/00-storage/service/hizofs/maintenance/maintenance-traversal-item";

export class BoundedCompletedReferenceMemoError extends Error {
  constructor({ message }: { message: string }) {
    super(message);
    this.name = "BoundedCompletedReferenceMemoError";
  }
}

/**
 * This exact bounded memo is only an optimization. Eviction makes a later
 * lookup miss so traversal safely revisits the record; no probabilistic
 * membership result may suppress child traversal.
 */
export class BoundedCompletedReferenceMemo {
  #entries = new Map<string, true>();
  #maxEntries: number;

  constructor({ maxEntries }: { maxEntries: number }) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new BoundedCompletedReferenceMemoError({
        message: "completed-reference memo bound must be a positive safe integer",
      });
    }
    this.#maxEntries = maxEntries;
  }

  get size(): number {
    return this.#entries.size;
  }

  has({ item }: { item: MaintenanceTraversalItem }): boolean {
    return this.#entries.has(maintenanceTraversalItemIdentity({ item }));
  }

  remember({ item }: { item: MaintenanceTraversalItem }): void {
    const key = maintenanceTraversalItemIdentity({ item });
    if (this.#entries.delete(key)) {
      this.#entries.set(key, true);
      return;
    }
    this.#entries.set(key, true);
    if (this.#entries.size <= this.#maxEntries) return;
    const oldest = this.#entries.keys().next();
    if (oldest.done) {
      throw new Error("completed-reference memo exceeded its bound without an eviction candidate");
    }
    this.#entries.delete(oldest.value);
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
