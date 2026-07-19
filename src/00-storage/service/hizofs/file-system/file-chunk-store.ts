import {
  HizoFSFileChunkSchemaDto,
  type HizoFSFileChunkDto,
} from '@/00-storage/00-dto/hizofs.dto';
import {
  assertHizoFSFileChunk,
  assertHizoFSFileChunkByteLength,
} from './semantic-validation';
import type { HizoFSRecordStore } from './record-store';

export type HizoFSLazyFileChunkPayload = {
  readonly binaryPayloadByteLength: number;
  readonly createBinaryPayload: () => Promise<Uint8Array>;
  readonly discardBinaryPayload: () => void;
};

export class HizoFSFileChunkStore {
  constructor({ recordStore }: {
    recordStore: HizoFSRecordStore;
  }) {
    this.recordStore = recordStore;
  }

  private readonly recordStore: HizoFSRecordStore;

  async write({ binaryPayload, chunkSize }: {
    binaryPayload: Uint8Array;
    chunkSize: number;
  }): Promise<string> {
    const chunk: HizoFSFileChunkDto = {};
    assertHizoFSFileChunk({ chunk, binaryPayload, chunkSize });
    return this.recordStore.write({
      kind: 'file_chunk',
      metadata: chunk,
      binaryPayload,
    });
  }

  async writeMany({ binaryPayloads, chunkSize }: {
    binaryPayloads: readonly Uint8Array[];
    chunkSize: number;
  }): Promise<readonly string[]> {
    const chunk: HizoFSFileChunkDto = {};
    for (const binaryPayload of binaryPayloads) {
      assertHizoFSFileChunk({ chunk, binaryPayload, chunkSize });
    }
    return this.recordStore.writeMany({
      records: binaryPayloads.map(binaryPayload => ({
        kind: 'file_chunk',
        recordVersion: 1,
        metadata: chunk,
        binaryPayload,
      })),
    });
  }

  async writeManyPipelined({
    payloads,
    chunkSize,
    maximumPlaintextRecordsInFlight,
  }: {
    payloads: readonly HizoFSLazyFileChunkPayload[];
    chunkSize: number;
    maximumPlaintextRecordsInFlight: number;
  }): Promise<readonly string[]> {
    const chunk: HizoFSFileChunkDto = {};
    for (const payload of payloads) {
      assertHizoFSFileChunkByteLength({
        chunk,
        binaryPayloadByteLength: payload.binaryPayloadByteLength,
        chunkSize,
      });
    }
    return this.recordStore.writeFileChunksPipelined({
      records: payloads,
      maximumPlaintextRecordsInFlight,
    });
  }

  async readRange({
    objectId,
    chunkSize,
    offset,
    length,
  }: {
    objectId: string;
    chunkSize: number;
    offset: number;
    length: number;
  }): Promise<Uint8Array> {
    const {
      metadata,
      binaryPayload,
      binaryPayloadByteLength,
    } = await this.recordStore.readBinaryPayloadRange({
      objectId,
      expectedKind: 'file_chunk',
      schema: HizoFSFileChunkSchemaDto,
      offset,
      length,
    });
    assertHizoFSFileChunkByteLength({
      chunk: metadata,
      binaryPayloadByteLength,
      chunkSize,
    });
    return binaryPayload;
  }

  async read({ objectId, chunkSize }: {
    objectId: string;
    chunkSize: number;
  }): Promise<Uint8Array> {
    const { metadata, binaryPayload } = await this.recordStore.read({
      objectId,
      expectedKind: 'file_chunk',
      schema: HizoFSFileChunkSchemaDto,
      binaryPayload: 'allowed',
    });
    assertHizoFSFileChunk({ chunk: metadata, binaryPayload, chunkSize });
    return binaryPayload;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
