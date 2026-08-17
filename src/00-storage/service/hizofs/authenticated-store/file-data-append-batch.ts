import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  assertFileDataPayloadBytesValid,
  sameRecordReferenceFields,
  type HomeRecordReference,
} from "@/00-storage/service/hizofs/00-format";
import {
  AuthenticatedSegmentCapacityError,
  type AppendedRecord,
  type AuthenticatedSegmentAppendPreviewPlanner,
  type AuthenticatedSegmentWriter,
  type TransferredPlaintextRecord,
} from "./record-appender";

const MAXIMUM_PENDING_RECORDS = 128;
const MAXIMUM_PENDING_FRAME_BYTES = 4 * 1024 * 1024;

export const HIZOFS_FILE_DATA_APPEND_BATCH_RESOURCE_LIMITS = Object.freeze({
  maximumPendingFrameBytes: MAXIMUM_PENDING_FRAME_BYTES,
  maximumPendingRecords: MAXIMUM_PENDING_RECORDS,
});

export class AuthenticatedFileDataAppendBatchFlushRequiredError extends Error {
  constructor({ cause }: { cause?: unknown } = {}) {
    super("File Data append batch must be flushed before staging another Record", { cause });
    this.name = "AuthenticatedFileDataAppendBatchFlushRequiredError";
  }
}

function sameAppendResult({ actual, expected }: {
  actual: AppendedRecord;
  expected: AppendedRecord;
}): boolean {
  return actual.type === "home"
    && expected.type === "home"
    && sameRecordReferenceFields({ left: actual.physicalReference, right: expected.physicalReference })
    && sameRecordReferenceFields({ left: actual.homeReference, right: expected.homeReference });
}

/**
 * Holds a bounded prepared-writable-local File Data batch before physical I/O.
 *
 * WHY: a writable stream is not published until close/commit, so making every
 * staged write perform its own sync plus exact read-back adds durability work
 * that the external operation has not requested. References are predicted from
 * the leased Data Segment tail, then the whole bounded batch is persisted with
 * the same canonical trusted-tail, sync, and read-back proof used by a normal
 * append. The batch owns private snapshots, so caller mutation cannot change a
 * staged Record after write() resolves.
 */
export class AuthenticatedFileDataAppendBatch {
  private readonly appendPreviewPlanner: AuthenticatedSegmentAppendPreviewPlanner;
  private readonly writer: AuthenticatedSegmentWriter;
  private closed = false;
  private pendingFrameBytesValue = 0;
  private plannedResults: AppendedRecord[] = [];
  private records: TransferredPlaintextRecord[] = [];

  constructor({ writer }: { writer: AuthenticatedSegmentWriter }) {
    switch (writer.segmentClass) {
    case "data": break;
    case "metadata": throw new TypeError("File Data append batch requires a data Segment writer");
    default: writer.segmentClass satisfies never;
    }
    this.writer = writer;
    this.appendPreviewPlanner = writer.createAppendPreviewPlanner();
  }

  hasRecords(): boolean {
    return this.records.length !== 0;
  }

  isBoundTo({ writer }: { writer: AuthenticatedSegmentWriter }): boolean {
    return this.writer === writer;
  }

  private requireOpen(): void {
    if (this.closed) throw new Error("File Data append batch is closed");
  }

  stage({ bytes }: { bytes: Uint8Array }): HomeRecordReference {
    this.requireOpen();
    assertFileDataPayloadBytesValid({ bytes });
    if (this.records.length >= MAXIMUM_PENDING_RECORDS) {
      throw new AuthenticatedFileDataAppendBatchFlushRequiredError();
    }
    const plaintext = this.writer.encodeRecordPayload({ encode: () => bytes });
    const snapshot = this.writer.snapshotRecordForTransferredAppend({
      plaintext,
      recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.file_data,
    });
    try {
      let nextFrameBytes = this.pendingFrameBytesValue;
      let planned: readonly AppendedRecord[];
      try {
        planned = this.appendPreviewPlanner.previewAppend({
          acceptPreview: ({ results }) => {
            const [result] = results;
            if (result === undefined || results.length !== 1) {
              throw new Error("File Data append preview result count is inconsistent");
            }
            const acceptedFrameBytes = this.pendingFrameBytesValue + result.physicalReference.frameLength;
            if (this.records.length !== 0 && acceptedFrameBytes > MAXIMUM_PENDING_FRAME_BYTES) {
              throw new AuthenticatedFileDataAppendBatchFlushRequiredError();
            }
            nextFrameBytes = acceptedFrameBytes;
          },
          records: [snapshot],
        });
      } catch (cause: unknown) {
        if (cause instanceof AuthenticatedSegmentCapacityError && this.records.length !== 0) {
          throw new AuthenticatedFileDataAppendBatchFlushRequiredError({ cause });
        }
        throw cause;
      }
      const [result] = planned;
      if (result === undefined || result.type !== "home") {
        throw new TypeError("File Data append preview must produce one Home Record Reference");
      }
      this.records.push(snapshot);
      this.plannedResults.push(result);
      this.pendingFrameBytesValue = nextFrameBytes;
      return result.homeReference;
    } catch (cause: unknown) {
      snapshot.plaintext.fill(0);
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
    this.pendingFrameBytesValue = 0;
    this.closed = true;
    try {
      let actual: readonly AppendedRecord[];
      try {
        actual = await this.writer.appendTransferredPlaintextRecords({
          clearPlaintextBeforePhysicalIo: true,
          records,
        });
      } catch (cause: unknown) {
        if (cause instanceof AuthenticatedSegmentCapacityError) {
          this.writer.abandon();
          throw new Error("File Data append preview and physical append capacity disagreed", { cause });
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
        throw new Error("File Data append preview and physical append references disagreed");
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
    this.pendingFrameBytesValue = 0;
  }
}

// Export internal bounds used only for focused resource-bound tests.
export const TEST_ONLY = {
  MAXIMUM_PENDING_FRAME_BYTES,
  MAXIMUM_PENDING_RECORDS,
};
