import {
  encodeHomeRecordReference,
  type HomeRecordReference,
} from "@/00-storage/service/hizofs/00-format";

export type ReadOnlyNamespaceValidationKind = "directory_tree" | "inode_table";

type ValidationEntry = {
  promise: Promise<void>;
  settled: boolean;
};

function referenceIdentity({ reference }: { reference: HomeRecordReference }): string {
  let identity = "";
  for (const byte of encodeHomeRecordReference({ reference })) {
    identity += byte.toString(16).padStart(2, "0");
  }
  return identity;
}

/**
 * Shares successful full-tree validation for exact immutable namespace roots.
 * Eviction only causes revalidation; it never changes namespace authority or
 * permits an unvalidated root to become visible.
 */
export class ReadOnlyNamespaceValidationCache {
  readonly #entries = new Map<string, ValidationEntry>();
  readonly #maximumEntries: number;

  constructor({ maximumEntries }: { maximumEntries: number }) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
      throw new RangeError("namespace validation cache maximum entries must be a positive safe integer");
    }
    this.#maximumEntries = maximumEntries;
  }

  clear(): void {
    this.#entries.clear();
  }

  #key({ kind, reference }: {
    kind: ReadOnlyNamespaceValidationKind;
    reference: HomeRecordReference;
  }): string {
    return `${kind}:${referenceIdentity({ reference })}`;
  }

  #evictSettledEntry(): boolean {
    const evictable = [...this.#entries].find(([, entry]) => entry.settled);
    if (evictable === undefined) return false;
    this.#entries.delete(evictable[0]);
    return true;
  }

  /**
   * Carries a full-tree proof across one trusted canonical immutable-tree
   * mutation. The successor is accepted only when the exact base root already
   * completed validation in this cache; otherwise later access validates it
   * normally.
   */
  inheritValidatedSuccessor({ baseReference, kind, successorReference }: {
    baseReference: HomeRecordReference;
    kind: ReadOnlyNamespaceValidationKind;
    successorReference: HomeRecordReference;
  }): void {
    const base = this.#entries.get(this.#key({ kind, reference: baseReference }));
    if (base?.settled !== true) return;
    const successorKey = this.#key({ kind, reference: successorReference });
    const existing = this.#entries.get(successorKey);
    if (existing !== undefined) {
      this.#entries.delete(successorKey);
      this.#entries.set(successorKey, existing);
      return;
    }
    while (this.#entries.size >= this.#maximumEntries && this.#evictSettledEntry()) {
      // Evict completed proof entries only. Pending validation is never cancelled.
    }
    if (this.#entries.size >= this.#maximumEntries) return;
    this.#entries.set(successorKey, { promise: Promise.resolve(), settled: true });
  }

  async validate({ kind, reference, validate }: {
    kind: ReadOnlyNamespaceValidationKind;
    reference: HomeRecordReference;
    validate: () => Promise<void>;
  }): Promise<void> {
    const key = this.#key({ kind, reference });
    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, existing);
      return await existing.promise;
    }

    while (this.#entries.size >= this.#maximumEntries) {
      if (!this.#evictSettledEntry()) {
        await validate();
        return;
      }
    }

    const entry: ValidationEntry = {
      promise: Promise.resolve().then(validate),
      settled: false,
    };
    this.#entries.set(key, entry);
    try {
      await entry.promise;
      entry.settled = true;
    } catch (cause: unknown) {
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
      throw cause;
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
