import {
  type HomeRecordReference,
  type InodeNumber,
} from "@/00-storage/service/hizofs/00-format";
import { runtimeHomeRecordReferenceIdentity } from "@/00-storage/service/hizofs/authenticated-store/runtime-home-record-reference-identity";

export type ReadOnlyNamespaceValidationKind = "directory_tree" | "inode_table";

type InodeTableHighWaterProof = Readonly<{
  maximumKnownInodeNumber: InodeNumber | undefined;
}>;

type ValidationEntry = {
  inodeTableHighWaterProof: InodeTableHighWaterProof | undefined;
  promise: Promise<void>;
  settled: boolean;
};

function referenceIdentity({ reference }: { reference: HomeRecordReference }): string {
  return runtimeHomeRecordReferenceIdentity({ reference });
}

/**
 * Shares successful full-tree validation for exact immutable namespace roots.
 * Eviction only causes revalidation; it never changes namespace authority or
 * permits an unvalidated root to become visible.
 */
export class ReadOnlyNamespaceValidationCache {
  private readonly entries = new Map<string, ValidationEntry>();
  private readonly maximumEntries: number;

  constructor({ maximumEntries }: { maximumEntries: number }) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
      throw new RangeError("namespace validation cache maximum entries must be a positive safe integer");
    }
    this.maximumEntries = maximumEntries;
  }

  clear(): void {
    this.entries.clear();
  }

  private key({ kind, reference }: {
    kind: ReadOnlyNamespaceValidationKind;
    reference: HomeRecordReference;
  }): string {
    return `${kind}:${referenceIdentity({ reference })}`;
  }

  private evictSettledEntry(): boolean {
    for (const [key, entry] of this.entries) {
      if (!entry.settled) continue;
      this.entries.delete(key);
      return true;
    }
    return false;
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
    const base = this.entries.get(this.key({ kind, reference: baseReference }));
    if (base?.settled !== true) return;
    const successorKey = this.key({ kind, reference: successorReference });
    const existing = this.entries.get(successorKey);
    if (existing !== undefined) {
      this.entries.delete(successorKey);
      this.entries.set(successorKey, existing);
      return;
    }
    while (this.entries.size >= this.maximumEntries && this.evictSettledEntry()) {
      // Evict completed proof entries only. Pending validation is never cancelled.
    }
    if (this.entries.size >= this.maximumEntries) return;
    this.entries.set(successorKey, {
      inodeTableHighWaterProof: undefined,
      promise: Promise.resolve(),
      settled: true,
    });
  }

  inodeTableHighWaterProof({ reference }: {
    reference: HomeRecordReference;
  }): InodeTableHighWaterProof | undefined {
    const key = this.key({ kind: "inode_table", reference });
    const entry = this.entries.get(key);
    if (entry?.settled !== true) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.inodeTableHighWaterProof;
  }

  /**
   * Binds an allocator high-water observation to one exact immutable Inode
   * Table root, but only while that root's complete structural proof is still
   * retained. Losing this cache entry can only cause a fresh seek-floor proof.
   */
  rememberInodeTableHighWaterProof({ maximumKnownInodeNumber, reference }: {
    maximumKnownInodeNumber: InodeNumber | undefined;
    reference: HomeRecordReference;
  }): void {
    const key = this.key({ kind: "inode_table", reference });
    const entry = this.entries.get(key);
    if (entry?.settled !== true) return;
    const existing = entry.inodeTableHighWaterProof;
    if (existing !== undefined && existing.maximumKnownInodeNumber !== maximumKnownInodeNumber) {
      // Cache disagreement must never turn an already-published mutation into a
      // caller-visible failure. Drop the entire derived proof entry so the next
      // access performs ordinary full validation and a fresh high-water seek.
      this.entries.delete(key);
      return;
    }
    entry.inodeTableHighWaterProof = Object.freeze({ maximumKnownInodeNumber });
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  async validate({ kind, reference, validate }: {
    kind: ReadOnlyNamespaceValidationKind;
    reference: HomeRecordReference;
    validate: () => Promise<void>;
  }): Promise<void> {
    const key = this.key({ kind, reference });
    while (true) {
      const existing = this.entries.get(key);
      if (existing !== undefined) {
        this.entries.delete(key);
        this.entries.set(key, existing);
        return await existing.promise;
      }
      if (this.entries.size < this.maximumEntries) break;
      if (this.evictSettledEntry()) continue;
      const pending = this.entries.values().next().value as ValidationEntry | undefined;
      if (pending === undefined) throw new Error("namespace validation cache capacity invariant failed");
      // Saturation must apply backpressure rather than bypassing the cache.
      // Otherwise many distinct roots can start unbounded full-tree validation
      // even though the cache itself remains nominally bounded. A failed older
      // validation does not fail this unrelated request; its own caller still
      // observes that failure and the entry removes itself below. Re-check the
      // requested key after every wait so concurrent waiters still coalesce.
      await pending.promise.catch(() => undefined);
    }

    const entry: ValidationEntry = {
      inodeTableHighWaterProof: undefined,
      promise: Promise.resolve(),
      settled: false,
    };
    entry.promise = Promise.resolve().then(validate).then(
      () => {
        entry.settled = true;
      },
      (cause: unknown) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw cause;
      },
    );
    this.entries.set(key, entry);
    await entry.promise;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
