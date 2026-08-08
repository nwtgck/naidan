import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  encodeHomeRecordReference,
  type HomeRecordReference,
} from "@/00-storage/service/hizofs/00-format";
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

function validateBound({ name, value }: { name: string; value: number }): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function bytesEqual({ left, right }: { left: Uint8Array; right: Uint8Array }): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function referenceIdentity({ reference }: { reference: HomeRecordReference }): string {
  let identity = "";
  for (const byte of encodeHomeRecordReference({ reference })) {
    identity += byte.toString(16).padStart(2, "0");
  }
  return identity;
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

  async read({ load, reference }: {
    load: () => Promise<AuthenticatedMetadataRecord>;
    reference: HomeRecordReference;
  }): Promise<AuthenticatedMetadataRecord> {
    if (this.disposed) throw new TypeError("authenticated metadata cache is disposed");
    if (!isMetadataReference({ reference })) return await load();

    const identity = referenceIdentity({ reference });
    const cached = this.entries.get(identity);
    if (cached !== undefined) {
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
      loaded.plaintext.fill(0);
      this.entries.delete(identity);
      this.entries.set(identity, concurrentlyCached);
      this.diagnostics?.recordMetadataCacheEvent?.({
        event: "hit",
        recordKind: concurrentlyCached.recordKind,
        scope: this.diagnosticScope,
      });
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
    return loaded;
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
