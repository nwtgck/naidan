import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  assertFileDataPayloadBytesValid,
  type HomeRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import { runtimeHomeRecordReferenceIdentity } from "@/00-storage/service/hizofs/authenticated-store/runtime-home-record-reference-identity";
import type { AuthenticatedStoreDiagnosticsPort } from "@/00-storage/service/hizofs/diagnostics/authenticated-store-diagnostics";

export type AuthenticatedFileDataRecordCachePolicy = Readonly<{
  maximumBytes: number;
  maximumEntries: number;
}>;

export type AuthenticatedFileDataRecord = Readonly<{
  plaintext: Uint8Array;
  recordKind: number;
}>;

type CacheEntry = Readonly<{
  plaintext: Uint8Array;
}>;

function validateBound({ name, value }: { name: string; value: number }): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function validateRange({ destination, destinationOffset, sourceLength, sourceOffset }: {
  destination: Uint8Array;
  destinationOffset: number;
  sourceLength: number;
  sourceOffset: number;
}): void {
  for (const [name, value] of [
    ["destination offset", destinationOffset],
    ["source length", sourceLength],
    ["source offset", sourceOffset],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer`);
    }
  }
  if (destinationOffset + sourceLength > destination.byteLength) {
    throw new RangeError("File Data cache copy exceeds the destination buffer");
  }
}

function referenceIdentity({ reference }: { reference: HomeRecordReference }): string {
  return runtimeHomeRecordReferenceIdentity({ reference });
}

/**
 * Retains authenticated immutable File Data plaintext for one application
 * session. File Data Records may be shared by several logical extents, so a
 * small read must not re-read and re-decrypt the same large AEAD record for
 * every extent fragment.
 *
 * WHY: the cache owns retained plaintext directly instead of returning a full
 * detached copy. Callers can copy only the requested range, while eviction and
 * session disposal keep the secret lifetime explicit and bounded by both bytes
 * and entry count.
 */
export class AuthenticatedFileDataRecordCache {
  private currentBytes = 0;
  private disposed = false;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly diagnostics: AuthenticatedStoreDiagnosticsPort | undefined;
  private pendingLoadFrameBytes = 0;
  private readonly pendingLoads = new Map<string, Promise<void>>();
  private readonly policy: AuthenticatedFileDataRecordCachePolicy;

  constructor({ diagnostics, policy }: {
    diagnostics: AuthenticatedStoreDiagnosticsPort | undefined;
    policy: AuthenticatedFileDataRecordCachePolicy;
  }) {
    validateBound({ name: "File Data cache maximum bytes", value: policy.maximumBytes });
    validateBound({ name: "File Data cache maximum entries", value: policy.maximumEntries });
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

  async copyRange({
    destination,
    destinationOffset,
    load,
    reference,
    sourceLength,
    sourceOffset,
    validatePlaintextLength,
  }: {
    destination: Uint8Array;
    destinationOffset: number;
    load: () => Promise<AuthenticatedFileDataRecord>;
    reference: HomeRecordReference;
    sourceLength: number;
    sourceOffset: number;
    validatePlaintextLength: ({ plaintextLength }: { plaintextLength: number }) => void;
  }): Promise<void> {
    if (this.disposed) throw new TypeError("authenticated File Data cache is disposed");
    if (reference.recordKind !== HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_data) {
      throw new TypeError("authenticated File Data cache requires a File Data Record Reference");
    }
    validateRange({ destination, destinationOffset, sourceLength, sourceOffset });

    const identity = referenceIdentity({ reference });
    const cached = this.entries.get(identity);
    if (cached !== undefined) {
      this.promote({ identity, entry: cached });
      this.diagnostics?.recordFileDataCacheEvent?.({ event: "hit" });
      this.copyValidatedRange({
        destination,
        destinationOffset,
        plaintext: cached.plaintext,
        sourceLength,
        sourceOffset,
        validatePlaintextLength,
      });
      return;
    }

    this.diagnostics?.recordFileDataCacheEvent?.({ event: "miss" });
    const sharedLoad = this.pendingLoads.get(identity);
    if (sharedLoad !== undefined) {
      await sharedLoad;
      if (this.disposed) throw new TypeError("authenticated File Data cache is disposed");
      const coalesced = this.entries.get(identity);
      if (coalesced === undefined) {
        return await this.copyRange({
          destination,
          destinationOffset,
          load,
          reference,
          sourceLength,
          sourceOffset,
          validatePlaintextLength,
        });
      }
      this.promote({ identity, entry: coalesced });
      this.diagnostics?.recordFileDataCacheEvent?.({ event: "hit" });
      this.copyValidatedRange({
        destination,
        destinationOffset,
        plaintext: coalesced.plaintext,
        sourceLength,
        sourceOffset,
        validatePlaintextLength,
      });
      return;
    }

    // WHY: only references whose complete authenticated frame fits the cache
    // byte budget may rendezvous through a pending load. Every valid File Data
    // plaintext for such a frame is retainable after authentication, so waiters
    // never depend on a transient buffer that the leader must zeroize early.
    const canSingleFlight = (
      this.policy.maximumBytes > 0
      && this.policy.maximumEntries > 0
      && reference.frameLength <= this.policy.maximumBytes
      && this.pendingLoadFrameBytes + reference.frameLength <= this.policy.maximumBytes
      && this.pendingLoads.size < this.policy.maximumEntries
    );
    if (canSingleFlight) {
      const pending = this.loadAndRetain({ identity, load, reference });
      this.pendingLoads.set(identity, pending);
      this.pendingLoadFrameBytes += reference.frameLength;
      try {
        await pending;
      } finally {
        if (this.pendingLoads.get(identity) === pending) {
          this.pendingLoads.delete(identity);
          this.pendingLoadFrameBytes -= reference.frameLength;
        }
      }
      if (this.disposed) throw new TypeError("authenticated File Data cache is disposed");
      const admitted = this.entries.get(identity);
      if (admitted === undefined) {
        return await this.copyRange({
          destination,
          destinationOffset,
          load,
          reference,
          sourceLength,
          sourceOffset,
          validatePlaintextLength,
        });
      }
      this.promote({ identity, entry: admitted });
      this.copyValidatedRange({
        destination,
        destinationOffset,
        plaintext: admitted.plaintext,
        sourceLength,
        sourceOffset,
        validatePlaintextLength,
      });
      return;
    }

    const loaded = await load();
    let retained = false;
    try {
      this.validateLoadedRecord({ loaded, reference });
      const concurrentlyCached = this.entries.get(identity);
      if (concurrentlyCached !== undefined) {
        loaded.plaintext.fill(0);
        this.promote({ identity, entry: concurrentlyCached });
        this.diagnostics?.recordFileDataCacheEvent?.({ event: "hit" });
        this.copyValidatedRange({
          destination,
          destinationOffset,
          plaintext: concurrentlyCached.plaintext,
          sourceLength,
          sourceOffset,
          validatePlaintextLength,
        });
        return;
      }
      this.copyValidatedRange({
        destination,
        destinationOffset,
        plaintext: loaded.plaintext,
        sourceLength,
        sourceOffset,
        validatePlaintextLength,
      });
      if (!this.canRetain({ plaintextBytes: loaded.plaintext.byteLength })) return;
      this.admitOwnedPlaintext({ identity, plaintext: loaded.plaintext });
      retained = true;
    } finally {
      if (!retained) loaded.plaintext.fill(0);
    }
  }

  private admitOwnedPlaintext({ identity, plaintext }: {
    identity: string;
    plaintext: Uint8Array;
  }): void {
    while (
      this.entries.size >= this.policy.maximumEntries
      || this.currentBytes + plaintext.byteLength > this.policy.maximumBytes
    ) {
      const oldest = this.entries.entries().next().value as [string, CacheEntry] | undefined;
      if (oldest === undefined) break;
      const [oldestIdentity, oldestEntry] = oldest;
      this.entries.delete(oldestIdentity);
      this.currentBytes -= oldestEntry.plaintext.byteLength;
      oldestEntry.plaintext.fill(0);
      this.diagnostics?.recordFileDataCacheEvent?.({ event: "eviction" });
    }
    this.entries.set(identity, { plaintext });
    this.currentBytes += plaintext.byteLength;
    this.reportUsage();
  }

  private canRetain({ plaintextBytes }: { plaintextBytes: number }): boolean {
    return this.policy.maximumBytes > 0
      && this.policy.maximumEntries > 0
      && plaintextBytes <= this.policy.maximumBytes;
  }

  private copyValidatedRange({
    destination,
    destinationOffset,
    plaintext,
    sourceLength,
    sourceOffset,
    validatePlaintextLength,
  }: {
    destination: Uint8Array;
    destinationOffset: number;
    plaintext: Uint8Array;
    sourceLength: number;
    sourceOffset: number;
    validatePlaintextLength: ({ plaintextLength }: { plaintextLength: number }) => void;
  }): void {
    validatePlaintextLength({ plaintextLength: plaintext.byteLength });
    const sourceEnd = sourceOffset + sourceLength;
    if (sourceEnd > plaintext.byteLength) {
      throw new RangeError("File Data cache copy exceeds authenticated plaintext");
    }
    destination.set(plaintext.subarray(sourceOffset, sourceEnd), destinationOffset);
  }

  private async loadAndRetain({ identity, load, reference }: {
    identity: string;
    load: () => Promise<AuthenticatedFileDataRecord>;
    reference: HomeRecordReference;
  }): Promise<void> {
    const loaded = await load();
    let retained = false;
    try {
      this.validateLoadedRecord({ loaded, reference });
      const concurrentlyCached = this.entries.get(identity);
      if (concurrentlyCached !== undefined) {
        loaded.plaintext.fill(0);
        this.promote({ identity, entry: concurrentlyCached });
        return;
      }
      if (!this.canRetain({ plaintextBytes: loaded.plaintext.byteLength })) return;
      this.admitOwnedPlaintext({ identity, plaintext: loaded.plaintext });
      retained = true;
    } finally {
      if (!retained) loaded.plaintext.fill(0);
    }
  }

  private promote({ entry, identity }: { entry: CacheEntry; identity: string }): void {
    this.entries.delete(identity);
    this.entries.set(identity, entry);
  }

  private reportUsage(): void {
    this.diagnostics?.setFileDataCacheUsage?.({
      bytes: this.currentBytes,
      entries: this.entries.size,
    });
  }

  private validateLoadedRecord({ loaded, reference }: {
    loaded: AuthenticatedFileDataRecord;
    reference: HomeRecordReference;
  }): void {
    if (this.disposed) {
      loaded.plaintext.fill(0);
      throw new TypeError("authenticated File Data cache was disposed while loading a record");
    }
    if (loaded.recordKind !== reference.recordKind) {
      loaded.plaintext.fill(0);
      throw new TypeError("authenticated File Data cache load returned the wrong Record Kind");
    }
    assertFileDataPayloadBytesValid({ bytes: loaded.plaintext });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  referenceIdentity,
};
