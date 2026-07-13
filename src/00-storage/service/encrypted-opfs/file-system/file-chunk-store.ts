import {
  EncryptedOpfsFileChunkSchemaDto,
  type EncryptedOpfsFileChunkDto,
} from '@/00-storage/00-dto/encrypted-opfs.dto';
import { assertEncryptedOpfsFileChunk } from './semantic-validation';
import type { EncryptedOpfsRecordStore } from './record-store';

export class EncryptedOpfsFileChunkStore {
  constructor({ recordStore }: {
    recordStore: EncryptedOpfsRecordStore;
  }) {
    this.recordStore = recordStore;
  }

  private readonly recordStore: EncryptedOpfsRecordStore;

  async write({ chunk, binaryPayload, chunkSize }: {
    chunk: EncryptedOpfsFileChunkDto;
    binaryPayload: Uint8Array;
    chunkSize: number;
  }): Promise<string> {
    assertEncryptedOpfsFileChunk({ chunk, binaryPayload, chunkSize });
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
      schema: EncryptedOpfsFileChunkSchemaDto,
      binaryPayload: 'allowed',
    });
    assertEncryptedOpfsFileChunk({ chunk: metadata, binaryPayload, chunkSize });
    if (metadata.nodeId !== expectedNodeId || metadata.chunkIndex !== expectedChunkIndex) {
      throw new Error('EncryptedOpfs file chunk identity does not match its extent reference');
    }
    return binaryPayload;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
