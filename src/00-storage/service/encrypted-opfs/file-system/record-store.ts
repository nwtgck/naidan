import type { ZodType } from 'zod';
import type { EncryptedOpfsObjectStore } from '@/00-storage/service/encrypted-opfs/object-store/object-store';
import type { EncryptedOpfsRecordKind } from '@/00-storage/service/encrypted-opfs/format/record';
import {
  EncryptedOpfsCorruptionError,
  EncryptedOpfsUnsupportedFormatError,
} from '@/00-storage/service/encrypted-opfs/errors';

export class EncryptedOpfsRecordStore {
  constructor({ objectStore }: {
    objectStore: EncryptedOpfsObjectStore;
  }) {
    this.objectStore = objectStore;
  }

  private readonly objectStore: EncryptedOpfsObjectStore;

  async write<T>({ kind, metadata, binaryPayload }: {
    kind: EncryptedOpfsRecordKind;
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

  async read<T>({ objectId, expectedKind, schema, binaryPayload }: {
    objectId: string;
    expectedKind: EncryptedOpfsRecordKind;
    schema: ZodType<T>;
    binaryPayload: 'allowed' | 'forbidden';
  }): Promise<{
    readonly metadata: T;
    readonly binaryPayload: Uint8Array;
  }> {
    const record = await this.objectStore.read({ objectId });
    if (record === undefined) {
      throw new EncryptedOpfsCorruptionError({
        message: `EncryptedOpfs object is missing: ${objectId}`,
        cause: undefined,
      });
    }
    if (record.kind !== expectedKind) {
      throw new EncryptedOpfsCorruptionError({
        message: `EncryptedOpfs object kind mismatch: expected ${expectedKind}, received ${record.kind}`,
        cause: undefined,
      });
    }
    if (record.recordVersion !== 1) {
      throw new EncryptedOpfsUnsupportedFormatError({
        message: `EncryptedOpfs ${expectedKind} record version is unsupported: ${String(record.recordVersion)}`,
      });
    }
    if (binaryPayload === 'forbidden' && record.binaryPayload.byteLength !== 0) {
      throw new EncryptedOpfsCorruptionError({
        message: `EncryptedOpfs ${expectedKind} record contains an unexpected binary payload`,
        cause: undefined,
      });
    }

    const parsed = schema.safeParse(record.metadata);
    if (!parsed.success) {
      throw new EncryptedOpfsCorruptionError({
        message: `EncryptedOpfs ${expectedKind} metadata is structurally invalid`,
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
