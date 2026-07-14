import {
  HizoFSFileChunkSchemaDto,
  type HizoFSFileChunkDto,
} from '@/00-storage/00-dto/hizofs.dto';
import { assertHizoFSFileChunk } from './semantic-validation';
import type { HizoFSRecordStore } from './record-store';

export class HizoFSFileChunkStore {
  constructor({ recordStore }: {
    recordStore: HizoFSRecordStore;
  }) {
    this.recordStore = recordStore;
  }

  private readonly recordStore: HizoFSRecordStore;

  async write({ chunk, binaryPayload, chunkSize }: {
    chunk: HizoFSFileChunkDto;
    binaryPayload: Uint8Array;
    chunkSize: number;
  }): Promise<string> {
    assertHizoFSFileChunk({ chunk, binaryPayload, chunkSize });
    return this.recordStore.write({
      kind: 'file_chunk',
      metadata: chunk,
      binaryPayload,
    });
  }

  async read({ objectId, expectedNodeId, expectedChunkIndex, chunkSize }: {
    objectId: string;
    expectedNodeId: string;
    expectedChunkIndex: number;
    chunkSize: number;
  }): Promise<Uint8Array> {
    const { metadata, binaryPayload } = await this.recordStore.read({
      objectId,
      expectedKind: 'file_chunk',
      schema: HizoFSFileChunkSchemaDto,
      binaryPayload: 'allowed',
    });
    assertHizoFSFileChunk({ chunk: metadata, binaryPayload, chunkSize });
    if (metadata.nodeId !== expectedNodeId || metadata.chunkIndex !== expectedChunkIndex) {
      throw new Error('HizoFS file chunk identity does not match its extent reference');
    }
    return binaryPayload;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
