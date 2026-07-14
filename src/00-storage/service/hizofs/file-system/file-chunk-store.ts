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
