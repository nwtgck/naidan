import type { ZodType } from 'zod';
import type {
  HizoFSLazyFileChunkRecord,
  HizoFSObjectStore,
  HizoFSObjectStoreRecord,
} from '@/00-storage/service/hizofs/object-store/object-store';
import type { HizoFSRecordKind } from '@/00-storage/service/hizofs/format/record';
import {
  HizoFSCorruptionError,
  HizoFSUnsupportedFormatError,
} from '@/00-storage/service/hizofs/errors';

export class HizoFSRecordStore {
  constructor({ objectStore }: {
    objectStore: HizoFSObjectStore;
  }) {
    this.objectStore = objectStore;
  }

  private readonly objectStore: HizoFSObjectStore;

  async write<T>({ kind, metadata, binaryPayload }: {
    kind: HizoFSRecordKind;
    metadata: T;
    binaryPayload: Uint8Array;
  }): Promise<string> {
    return this.objectStore.create({
      record: {
        kind,
        recordVersion: 1,
        metadata,
        binaryPayload,
      },
    });
  }

  async writeMany({ records }: {
    records: readonly HizoFSObjectStoreRecord[];
  }): Promise<readonly string[]> {
    return this.objectStore.createMany({ records });
  }

  async writeFileChunksPipelined({
    records,
    maximumPlaintextRecordsInFlight,
  }: {
    records: readonly HizoFSLazyFileChunkRecord[];
    maximumPlaintextRecordsInFlight: number;
  }): Promise<readonly string[]> {
    return this.objectStore.createFileChunksPipelined({
      records,
      maximumPlaintextRecordsInFlight,
    });
  }

  async readBinaryPayloadRange<T>({
    objectId,
    expectedKind,
    schema,
    offset,
    length,
  }: {
    objectId: string;
    expectedKind: HizoFSRecordKind;
    schema: ZodType<T>;
    offset: number;
    length: number;
  }): Promise<{
    readonly metadata: T;
    readonly binaryPayload: Uint8Array;
    readonly binaryPayloadByteLength: number;
  }> {
    const record = await this.objectStore.readBinaryPayloadRange({
      objectId,
      offset,
      length,
    });
    if (record === undefined) {
      throw new HizoFSCorruptionError({
        message: `HizoFS object is missing: ${objectId}`,
        cause: undefined,
      });
    }
    if (record.kind !== expectedKind) {
      throw new HizoFSCorruptionError({
        message: `HizoFS object kind mismatch: expected ${expectedKind}, received ${record.kind}`,
        cause: undefined,
      });
    }
    if (record.recordVersion !== 1) {
      throw new HizoFSUnsupportedFormatError({
        message: `HizoFS ${expectedKind} record version is unsupported: ${String(record.recordVersion)}`,
      });
    }
    const parsed = schema.safeParse(record.metadata);
    if (!parsed.success) {
      throw new HizoFSCorruptionError({
        message: `HizoFS ${expectedKind} metadata is structurally invalid`,
        cause: parsed.error,
      });
    }
    return {
      metadata: parsed.data,
      binaryPayload: record.binaryPayload,
      binaryPayloadByteLength: record.binaryPayloadByteLength,
    };
  }

  async read<T>({ objectId, expectedKind, schema, binaryPayload }: {
    objectId: string;
    expectedKind: HizoFSRecordKind;
    schema: ZodType<T>;
    binaryPayload: 'allowed' | 'forbidden';
  }): Promise<{
    readonly metadata: T;
    readonly binaryPayload: Uint8Array;
  }> {
    const record = await this.objectStore.read({ objectId });
    if (record === undefined) {
      throw new HizoFSCorruptionError({
        message: `HizoFS object is missing: ${objectId}`,
        cause: undefined,
      });
    }
    if (record.kind !== expectedKind) {
      throw new HizoFSCorruptionError({
        message: `HizoFS object kind mismatch: expected ${expectedKind}, received ${record.kind}`,
        cause: undefined,
      });
    }
    if (record.recordVersion !== 1) {
      throw new HizoFSUnsupportedFormatError({
        message: `HizoFS ${expectedKind} record version is unsupported: ${String(record.recordVersion)}`,
      });
    }
    if (binaryPayload === 'forbidden' && record.binaryPayload.byteLength !== 0) {
      throw new HizoFSCorruptionError({
        message: `HizoFS ${expectedKind} record contains an unexpected binary payload`,
        cause: undefined,
      });
    }

    const parsed = schema.safeParse(record.metadata);
    if (!parsed.success) {
      throw new HizoFSCorruptionError({
        message: `HizoFS ${expectedKind} metadata is structurally invalid`,
        cause: parsed.error,
      });
    }
    return {
      metadata: parsed.data,
      binaryPayload: record.binaryPayload,
    };
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
