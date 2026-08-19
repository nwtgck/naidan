import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  type HomeRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import { runtimeHomeRecordReferenceIdentity } from "@/00-storage/service/hizofs/authenticated-store/runtime-home-record-reference-identity";
import type { AuthenticatedStoreDiagnosticsPort } from "@/00-storage/service/hizofs/authenticated-store/diagnostics-hooks";

export type AuthenticatedMetadataRecordCachePolicy = Readonly<{
  maximumBytes: number;
  maximumEntries: number;
}>;

export type AuthenticatedMetadataRecordCacheScope = "mutation" | "session";

export type AuthenticatedMetadataRecord = Readonly<{
  plaintext: Uint8Array;
  recordKind: number;
}>;

type CacheEntry = Readonly<{
  plaintext: Uint8Array;
  recordKind: number;
}>;

type PendingReadLoadOutcome =
  | Readonly<{ type: "failure"; cause: unknown }>
  | Readonly<{ type: "retry" }>
  | Readonly<{ type: "success" }>;

type PendingReadLoad = {
  followers: number;
  readonly settled: Promise<PendingReadLoadOutcome>;
  readonly settle: ({ outcome }: { outcome: PendingReadLoadOutcome }) => void;
};

function createPendingReadLoad(): PendingReadLoad {
  let settlePromise: (({ outcome }: { outcome: PendingReadLoadOutcome }) => void) | undefined;
  const settled = new Promise<PendingReadLoadOutcome>(resolve => {
    settlePromise = ({ outcome }) => resolve(outcome);
  });
  return {
    followers: 0,
    settled,
    settle: ({ outcome }) => {
      const settle = settlePromise;
      if (settle === undefined) throw new Error("metadata cache pending load settled more than once");
      settlePromise = undefined;
      settle({ outcome });
    },
  };
}

function validateBound({ name, value }: { name: string; value: number }): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function bytesEqual({ left, right }: { left: Uint8Array; right: Uint8Array }): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function referenceIdentity({ reference }: { reference: HomeRecordReference }): string {
  return runtimeHomeRecordReferenceIdentity({ reference });
}

function isMetadataReference({ reference }: { reference: HomeRecordReference }): boolean {
  return reference.recordKind !== HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_data;
}

/**
 * Retains successfully authenticated immutable namespace-record plaintext.
 * Inode pages can contain inline file payloads, so this is a bounded,
 * secret-bearing scope-owned resource rather than a harmless structural cache.
 *
 * Cache identity is the complete Home Record Reference, so a hit cannot cross
 * record kind, segment, offset, or frame identity. Callers receive a copy and
 * may continue zeroizing their buffer without mutating the retained entry.
 * Eviction and owner-scope disposal zero retained plaintext before dropping it.
 */
export class AuthenticatedMetadataRecordCache {
  private readonly diagnosticScope: AuthenticatedMetadataRecordCacheScope;
  private readonly diagnostics: AuthenticatedStoreDiagnosticsPort | undefined;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly pendingReadAdmissions = new Set<string>();
  private readonly pendingReadLoads = new Map<string, PendingReadLoad>();
  private pendingReadLoadFrameBytes = 0;
  private readonly policy: AuthenticatedMetadataRecordCachePolicy;
  private currentBytes = 0;
  private disposed = false;

  constructor({ diagnosticScope = "session", diagnostics, policy }: {
    diagnosticScope?: AuthenticatedMetadataRecordCacheScope;
    diagnostics: AuthenticatedStoreDiagnosticsPort | undefined;
    policy: AuthenticatedMetadataRecordCachePolicy;
  }) {
    validateBound({ name: "metadata cache maximum bytes", value: policy.maximumBytes });
    validateBound({ name: "metadata cache maximum entries", value: policy.maximumEntries });
    this.diagnosticScope = diagnosticScope;
    this.diagnostics = diagnostics;
    this.policy = Object.freeze({ ...policy });
    this.reportUsage();
  }

  clear(): void {
    for (const entry of this.entries.values()) entry.plaintext.fill(0);
    this.entries.clear();
    this.pendingReadAdmissions.clear();
    this.currentBytes = 0;
    this.reportUsage();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
  }

  admitAuthenticatedWrite({ plaintext, reference, recordKind }: {
    plaintext: Uint8Array;
    reference: HomeRecordReference;
    recordKind: number;
  }): void {
    if (this.disposed) throw new TypeError("authenticated metadata cache is disposed");
    if (reference.recordKind !== recordKind) {
      throw new TypeError("authenticated metadata cache write admission has the wrong Record Kind");
    }
    if (!isMetadataReference({ reference })) return;

    const identity = referenceIdentity({ reference });
    this.pendingReadAdmissions.delete(identity);
    const existing = this.entries.get(identity);
    if (existing !== undefined) {
      if (existing.recordKind !== recordKind || !bytesEqual({ left: existing.plaintext, right: plaintext })) {
        throw new TypeError("authenticated metadata cache write admission conflicts with retained immutable plaintext");
      }
      this.entries.delete(identity);
      this.entries.set(identity, existing);
      return;
    }
    if (
      this.policy.maximumBytes === 0
      || this.policy.maximumEntries === 0
      || plaintext.byteLength > this.policy.maximumBytes
    ) {
      return;
    }

    const retained = plaintext.slice();
    while (
      this.entries.size >= this.policy.maximumEntries
      || this.currentBytes + retained.byteLength > this.policy.maximumBytes
    ) {
      const oldest = this.entries.entries().next().value as [string, CacheEntry] | undefined;
      if (oldest === undefined) break;
      const [oldestIdentity, oldestEntry] = oldest;
      this.entries.delete(oldestIdentity);
      this.currentBytes -= oldestEntry.plaintext.byteLength;
      oldestEntry.plaintext.fill(0);
      this.diagnostics?.recordMetadataCacheEvent?.({
        event: "eviction",
        recordKind: oldestEntry.recordKind,
        scope: this.diagnosticScope,
      });
    }
    this.entries.set(identity, { plaintext: retained, recordKind });
    this.currentBytes += retained.byteLength;
    this.reportUsage();
  }

  private shouldRetainLoadedIdentity({ identity }: { identity: string }): boolean {
    switch (this.diagnosticScope) {
    case "session":
      return true;
    case "mutation":
      if (this.pendingReadAdmissions.delete(identity)) return true;

      // Mutation-local readers often touch immutable predecessor pages once and
      // then replace them. Do not copy-retain those one-shot plaintexts. Keep a
      // bounded identity-only admission history so a second observation promotes
      // genuinely hot pages, preserving the benefit seen in repeated-write paths
      // without paying a full plaintext copy for every first miss.
      this.pendingReadAdmissions.add(identity);
      while (this.pendingReadAdmissions.size > this.policy.maximumEntries) {
        const oldest = this.pendingReadAdmissions.values().next().value as string | undefined;
        if (oldest === undefined) break;
        this.pendingReadAdmissions.delete(oldest);
      }
      return false;
    default: {
      const _ex: never = this.diagnosticScope;
      throw new Error(`Unhandled metadata cache diagnostic scope: ${_ex}`);
    }
    }
  }

  async read({ load, reference }: {
    load: () => Promise<AuthenticatedMetadataRecord>;
    reference: HomeRecordReference;
  }): Promise<AuthenticatedMetadataRecord> {
    if (this.disposed) throw new TypeError("authenticated metadata cache is disposed");
    if (!isMetadataReference({ reference })) return await load();

    const identity = referenceIdentity({ reference });
    const cached = this.entries.get(identity);
    if (cached !== undefined) {
      this.pendingReadAdmissions.delete(identity);
      this.entries.delete(identity);
      this.entries.set(identity, cached);
      this.diagnostics?.recordMetadataCacheEvent?.({
        event: "hit",
        recordKind: cached.recordKind,
        scope: this.diagnosticScope,
      });
      return {
        plaintext: cached.plaintext.slice(),
        recordKind: cached.recordKind,
      };
    }

    this.diagnostics?.recordMetadataCacheEvent?.({
      event: "miss",
      recordKind: reference.recordKind,
      scope: this.diagnosticScope,
    });

    const sharedLoad = this.pendingReadLoads.get(identity);
    if (sharedLoad !== undefined) {
      sharedLoad.followers += 1;
      const outcome = await sharedLoad.settled;
      switch (outcome.type) {
      case "failure": throw outcome.cause;
      case "retry": return await this.read({ load, reference });
      case "success": break;
      default: return outcome satisfies never;
      }
      if (this.disposed) throw new TypeError("authenticated metadata cache is disposed");
      const coalesced = this.entries.get(identity);
      if (coalesced === undefined) {
        throw new Error("coalesced authenticated metadata load completed without a retained entry");
      }
      this.pendingReadAdmissions.delete(identity);
      this.entries.delete(identity);
      this.entries.set(identity, coalesced);
      this.diagnostics?.recordMetadataCacheEvent?.({
        event: "hit",
        recordKind: coalesced.recordKind,
        scope: this.diagnosticScope,
      });
      return {
        plaintext: coalesced.plaintext.slice(),
        recordKind: coalesced.recordKind,
      };
    }

    // WHY: only references whose complete frame fits the cache byte budget may
    // single-flight. That lets concurrent callers rendezvous through a retained
    // authenticated copy without creating an unbounded transient plaintext pool.
    const pendingLoad = (
      this.policy.maximumBytes > 0
      && this.policy.maximumEntries > 0
      && reference.frameLength <= this.policy.maximumBytes
      && this.pendingReadLoadFrameBytes + reference.frameLength <= this.policy.maximumBytes
      && this.pendingReadLoads.size < this.policy.maximumEntries
    ) ? createPendingReadLoad() : undefined;
    if (pendingLoad !== undefined) {
      this.pendingReadLoads.set(identity, pendingLoad);
      this.pendingReadLoadFrameBytes += reference.frameLength;
    }

    let pendingOutcome: PendingReadLoadOutcome = { type: "retry" };
    try {
      const loaded = await load();
      if (this.disposed) {
        loaded.plaintext.fill(0);
        throw new TypeError("authenticated metadata cache was disposed while loading a record");
      }
      if (loaded.recordKind !== reference.recordKind) {
        loaded.plaintext.fill(0);
        throw new TypeError("authenticated metadata cache load returned the wrong Record Kind");
      }

      const concurrentlyCached = this.entries.get(identity);
      if (concurrentlyCached !== undefined) {
        this.pendingReadAdmissions.delete(identity);
        loaded.plaintext.fill(0);
        this.entries.delete(identity);
        this.entries.set(identity, concurrentlyCached);
        this.diagnostics?.recordMetadataCacheEvent?.({
          event: "hit",
          recordKind: concurrentlyCached.recordKind,
          scope: this.diagnosticScope,
        });
        pendingOutcome = { type: "success" };
        return {
          plaintext: concurrentlyCached.plaintext.slice(),
          recordKind: concurrentlyCached.recordKind,
        };
      }
      if (
        this.policy.maximumBytes === 0
        || this.policy.maximumEntries === 0
        || loaded.plaintext.byteLength > this.policy.maximumBytes
      ) {
        return loaded;
      }

      const hasConcurrentFollower = (pendingLoad?.followers ?? 0) > 0;
      if (!hasConcurrentFollower && !this.shouldRetainLoadedIdentity({ identity })) return loaded;
      if (hasConcurrentFollower) this.pendingReadAdmissions.delete(identity);

      const retained = loaded.plaintext.slice();
      while (
        this.entries.size >= this.policy.maximumEntries
        || this.currentBytes + retained.byteLength > this.policy.maximumBytes
      ) {
        const oldest = this.entries.entries().next().value as [string, CacheEntry] | undefined;
        if (oldest === undefined) break;
        const [oldestIdentity, oldestEntry] = oldest;
        this.entries.delete(oldestIdentity);
        this.currentBytes -= oldestEntry.plaintext.byteLength;
        oldestEntry.plaintext.fill(0);
        this.diagnostics?.recordMetadataCacheEvent?.({
          event: "eviction",
          recordKind: oldestEntry.recordKind,
          scope: this.diagnosticScope,
        });
      }
      this.entries.set(identity, {
        plaintext: retained,
        recordKind: loaded.recordKind,
      });
      this.currentBytes += retained.byteLength;
      this.reportUsage();
      pendingOutcome = { type: "success" };
      return loaded;
    } catch (cause: unknown) {
      pendingOutcome = { type: "failure", cause };
      throw cause;
    } finally {
      if (pendingLoad !== undefined) {
        if (this.pendingReadLoads.get(identity) === pendingLoad) {
          this.pendingReadLoads.delete(identity);
          this.pendingReadLoadFrameBytes -= reference.frameLength;
        }
        pendingLoad.settle({ outcome: pendingOutcome });
      }
    }
  }

  private reportUsage(): void {
    this.diagnostics?.setMetadataCacheUsage?.({
      bytes: this.currentBytes,
      entries: this.entries.size,
      scope: this.diagnosticScope,
    });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  referenceIdentity,
};
