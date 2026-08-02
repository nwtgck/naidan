import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  encodeHomeRecordReference,
  type HomeRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import type { AuthenticatedStoreDiagnosticsPort } from "./runtime-diagnostics-port";

export type AuthenticatedMetadataRecordCachePolicy = Readonly<{
  maximumBytes: number;
  maximumEntries: number;
}>;

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
 * secret-bearing session resource rather than a harmless structural cache.
 *
 * Cache identity is the complete Home Record Reference, so a hit cannot cross
 * record kind, segment, offset, or frame identity. Callers receive a copy and
 * may continue zeroizing their buffer without mutating the retained entry.
 * Eviction and session disposal zero retained plaintext before dropping it.
 */
export class AuthenticatedMetadataRecordCache {
  readonly #diagnostics: AuthenticatedStoreDiagnosticsPort | undefined;
  readonly #entries = new Map<string, CacheEntry>();
  readonly #policy: AuthenticatedMetadataRecordCachePolicy;
  #currentBytes = 0;
  #disposed = false;

  constructor({ diagnostics, policy }: {
    diagnostics: AuthenticatedStoreDiagnosticsPort | undefined;
    policy: AuthenticatedMetadataRecordCachePolicy;
  }) {
    validateBound({ name: "metadata cache maximum bytes", value: policy.maximumBytes });
    validateBound({ name: "metadata cache maximum entries", value: policy.maximumEntries });
    this.#diagnostics = diagnostics;
    this.#policy = Object.freeze({ ...policy });
    this.#reportUsage();
  }

  clear(): void {
    for (const entry of this.#entries.values()) entry.plaintext.fill(0);
    this.#entries.clear();
    this.#currentBytes = 0;
    this.#reportUsage();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.clear();
  }

  async read({ load, reference }: {
    load: () => Promise<AuthenticatedMetadataRecord>;
    reference: HomeRecordReference;
  }): Promise<AuthenticatedMetadataRecord> {
    if (this.#disposed) throw new TypeError("authenticated metadata cache is disposed");
    if (!isMetadataReference({ reference })) return await load();

    const identity = referenceIdentity({ reference });
    const cached = this.#entries.get(identity);
    if (cached !== undefined) {
      this.#entries.delete(identity);
      this.#entries.set(identity, cached);
      this.#diagnostics?.recordMetadataCacheEvent?.({ event: "hit", recordKind: cached.recordKind });
      return {
        plaintext: cached.plaintext.slice(),
        recordKind: cached.recordKind,
      };
    }

    this.#diagnostics?.recordMetadataCacheEvent?.({ event: "miss", recordKind: reference.recordKind });
    const loaded = await load();
    if (this.#disposed) {
      loaded.plaintext.fill(0);
      throw new TypeError("authenticated metadata cache was disposed while loading a record");
    }
    if (loaded.recordKind !== reference.recordKind) {
      loaded.plaintext.fill(0);
      throw new TypeError("authenticated metadata cache load returned the wrong Record Kind");
    }

    const concurrentlyCached = this.#entries.get(identity);
    if (concurrentlyCached !== undefined) {
      loaded.plaintext.fill(0);
      this.#entries.delete(identity);
      this.#entries.set(identity, concurrentlyCached);
      this.#diagnostics?.recordMetadataCacheEvent?.({ event: "hit", recordKind: concurrentlyCached.recordKind });
      return {
        plaintext: concurrentlyCached.plaintext.slice(),
        recordKind: concurrentlyCached.recordKind,
      };
    }
    if (
      this.#policy.maximumBytes === 0
      || this.#policy.maximumEntries === 0
      || loaded.plaintext.byteLength > this.#policy.maximumBytes
    ) {
      return loaded;
    }

    const retained = loaded.plaintext.slice();
    while (
      this.#entries.size >= this.#policy.maximumEntries
      || this.#currentBytes + retained.byteLength > this.#policy.maximumBytes
    ) {
      const oldest = this.#entries.entries().next().value as [string, CacheEntry] | undefined;
      if (oldest === undefined) break;
      const [oldestIdentity, oldestEntry] = oldest;
      this.#entries.delete(oldestIdentity);
      this.#currentBytes -= oldestEntry.plaintext.byteLength;
      oldestEntry.plaintext.fill(0);
      this.#diagnostics?.recordMetadataCacheEvent?.({
        event: "eviction",
        recordKind: oldestEntry.recordKind,
      });
    }
    this.#entries.set(identity, {
      plaintext: retained,
      recordKind: loaded.recordKind,
    });
    this.#currentBytes += retained.byteLength;
    this.#reportUsage();
    return loaded;
  }

  #reportUsage(): void {
    this.#diagnostics?.setMetadataCacheUsage?.({
      bytes: this.#currentBytes,
      entries: this.#entries.size,
    });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  referenceIdentity,
};
