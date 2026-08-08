import {
  encodeHomeRecordReference,
  encodePhysicalRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import { AuthenticatedMetadataRecordCache } from "./metadata-record-cache";
import {
  AuthenticatedSegmentCapacityError,
  encodedHizoFSRecord,
  type AppendedRecord,
  type AuthenticatedSegmentAppendTarget,
  type AuthenticatedSegmentWriter,
  type EncodedHizoFSRecord,
} from "./record-appender";

const MAXIMUM_PENDING_RECORDS = 128;
const MAXIMUM_PENDING_FRAME_BYTES = 1024 * 1024;

export class AuthenticatedMetadataAppendBatchFlushRequiredError extends Error {
  constructor({ cause }: { cause?: unknown } = {}) {
    super("metadata append batch must be flushed before staging another record", { cause });
    this.name = "AuthenticatedMetadataAppendBatchFlushRequiredError";
  }
}

function bytesEqual({ left, right }: { left: Uint8Array; right: Uint8Array }): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function sameAppendResult({ actual, expected }: {
  actual: AppendedRecord;
  expected: AppendedRecord;
}): boolean {
  if (actual.type !== expected.type) return false;
  if (!bytesEqual({
    left: encodePhysicalRecordReference({ reference: actual.physicalReference }),
    right: encodePhysicalRecordReference({ reference: expected.physicalReference }),
  })) return false;
  switch (actual.type) {
  case "physical_only": return expected.type === "physical_only";
  case "home":
    return expected.type === "home" && bytesEqual({
      left: encodeHomeRecordReference({ reference: actual.homeReference }),
      right: encodeHomeRecordReference({ reference: expected.homeReference }),
    });
  default: return actual satisfies never;
  }
}

/**
 * Holds one bounded mutation-local set of immutable metadata Records before
 * physical append. References are deterministic from the active Segment tail,
 * so parent pages can encode child references before the batch is persisted.
 *
 * WHY: the batch does not weaken the canonical append proof. Flush still uses
 * one trusted-tail check, write+sync, explicit close, and exact read-back over
 * the complete dependency-ordered byte range. Provisional plaintext is admitted
 * only to the mutation cache; the session cache is updated only after that
 * durable append proof succeeds, so a failed mutation cannot leave a stale
 * reusable reference behind.
 */
export class AuthenticatedMetadataAppendBatch {
  private readonly mutationCache: AuthenticatedMetadataRecordCache;
  private readonly sharedCache: AuthenticatedMetadataRecordCache | undefined;
  private readonly target: AuthenticatedSegmentAppendTarget;
  private readonly writer: AuthenticatedSegmentWriter;
  private closed = false;
  private plannedResults: AppendedRecord[] = [];
  private records: EncodedHizoFSRecord[] = [];

  constructor({ mutationCache, sharedCache, writer }: {
    mutationCache: AuthenticatedMetadataRecordCache;
    sharedCache?: AuthenticatedMetadataRecordCache;
    writer: AuthenticatedSegmentWriter;
  }) {
    this.mutationCache = mutationCache;
    this.sharedCache = sharedCache;
    this.writer = writer;
    this.target = Object.freeze({
      append: async ({ records }) => await this.stage({ records }),
      encodeRecordPayload: ({ encode }) => this.writer.encodeRecordPayload({ encode }),
      segmentClass: writer.segmentClass,
    });
  }

  appendTarget(): AuthenticatedSegmentAppendTarget {
    return this.target;
  }

  hasRecords(): boolean {
    return this.records.length !== 0;
  }

  isBoundTo({ writer }: { writer: AuthenticatedSegmentWriter }): boolean {
    return this.writer === writer;
  }

  pendingFrameBytes(): number {
    return this.plannedResults.reduce((total, result) => total + result.physicalReference.frameLength, 0);
  }

  private requireOpen(): void {
    if (this.closed) throw new Error("metadata append batch is closed");
  }

  private async stage({ records }: {
    records: readonly EncodedHizoFSRecord[];
  }): Promise<readonly AppendedRecord[]> {
    this.requireOpen();
    if (records.length === 0) throw new RangeError("metadata append batch must not stage an empty record set");
    const snapshots = records.map(record => encodedHizoFSRecord({
      plaintext: record.plaintext,
      recordKind: record.recordKind,
    }));
    try {
      if (this.records.length !== 0 && this.records.length + snapshots.length > MAXIMUM_PENDING_RECORDS) {
        throw new AuthenticatedMetadataAppendBatchFlushRequiredError();
      }
      let planned: readonly AppendedRecord[];
      try {
        planned = this.writer.previewAppend({ records: [...this.records, ...snapshots] });
      } catch (cause: unknown) {
        if (cause instanceof AuthenticatedSegmentCapacityError && this.records.length !== 0) {
          throw new AuthenticatedMetadataAppendBatchFlushRequiredError({ cause });
        }
        throw cause;
      }
      const nextFrameBytes = planned.reduce(
        (total, result) => total + result.physicalReference.frameLength,
        0,
      );
      if (
        this.records.length !== 0
        && nextFrameBytes > MAXIMUM_PENDING_FRAME_BYTES
      ) {
        throw new AuthenticatedMetadataAppendBatchFlushRequiredError();
      }
      const newlyPlanned = planned.slice(this.records.length);
      if (newlyPlanned.length !== snapshots.length) {
        throw new Error("metadata append preview result count is inconsistent");
      }
      this.records.push(...snapshots);
      this.plannedResults = [...planned];
      for (let index = 0; index < snapshots.length; index += 1) {
        const snapshot = snapshots[index];
        const result = newlyPlanned[index];
        if (snapshot === undefined || result === undefined) {
          throw new Error("metadata append staging index invariant failed");
        }
        switch (result.type) {
        case "home":
          this.mutationCache.admitAuthenticatedWrite({
            plaintext: snapshot.plaintext,
            recordKind: snapshot.recordKind,
            reference: result.homeReference,
          });
          break;
        case "physical_only":
          throw new TypeError("mutation metadata append batch cannot stage a physical-only Record");
        default: result satisfies never;
        }
      }
      return newlyPlanned;
    } catch (cause: unknown) {
      for (const snapshot of snapshots) snapshot.plaintext.fill(0);
      throw cause;
    }
  }

  async flush(): Promise<void> {
    this.requireOpen();
    if (this.records.length === 0) {
      this.closed = true;
      return;
    }
    const records = this.records;
    const expected = this.plannedResults;
    this.records = [];
    this.plannedResults = [];
    this.closed = true;
    try {
      let actual: readonly AppendedRecord[];
      try {
        actual = await this.writer.append({ records });
      } catch (cause: unknown) {
        if (cause instanceof AuthenticatedSegmentCapacityError) {
          this.writer.abandon();
          throw new Error("metadata append preview and physical append capacity disagreed", { cause });
        }
        throw cause;
      }
      if (
        actual.length !== expected.length
        || actual.some((result, index) => {
          const expectedResult = expected[index];
          return expectedResult === undefined || !sameAppendResult({ actual: result, expected: expectedResult });
        })
      ) {
        this.writer.abandon();
        throw new Error("metadata append preview and physical append references disagreed");
      }
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        const result = actual[index];
        if (record === undefined || result === undefined) {
          this.writer.abandon();
          throw new Error("metadata append flush index invariant failed");
        }
        switch (result.type) {
        case "home":
          this.sharedCache?.admitAuthenticatedWrite({
            plaintext: record.plaintext,
            recordKind: record.recordKind,
            reference: result.homeReference,
          });
          break;
        case "physical_only":
          this.writer.abandon();
          throw new TypeError("mutation metadata append batch persisted a physical-only Record");
        default: result satisfies never;
        }
      }
    } catch (cause: unknown) {
      this.writer.abandon();
      throw cause;
    } finally {
      for (const record of records) record.plaintext.fill(0);
    }
  }

  discard(): void {
    if (this.closed) return;
    this.closed = true;
    for (const record of this.records) record.plaintext.fill(0);
    this.records = [];
    this.plannedResults = [];
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  MAXIMUM_PENDING_FRAME_BYTES,
  MAXIMUM_PENDING_RECORDS,
  sameAppendResult,
};
