import {
  EncryptedOpfsCommitSchemaDto,
  type EncryptedOpfsCommitDto,
} from '@/00-storage/00-dto/encrypted-opfs.dto';
import { validateEncryptedOpfsStableId } from '@/00-storage/service/encrypted-opfs/id';
import {
  assertEncryptedOpfsNonNegativeSafeInteger,
  assertEncryptedOpfsObjectId,
} from './semantic-validation';
import type { EncryptedOpfsRecordStore } from './record-store';

export class EncryptedOpfsCommitStore {
  constructor({ recordStore }: {
    recordStore: EncryptedOpfsRecordStore;
  }) {
    this.recordStore = recordStore;
  }

  private readonly recordStore: EncryptedOpfsRecordStore;

  async write({ commit }: {
    commit: EncryptedOpfsCommitDto;
  }): Promise<string> {
    assertCommit({ commit });
    return this.recordStore.write({
      kind: 'commit',
      metadata: commit,
      binaryPayload: new Uint8Array(),
    });
  }

  async read({ objectId }: {
    objectId: string;
  }): Promise<EncryptedOpfsCommitDto> {
    const { metadata } = await this.recordStore.read({
      objectId,
      expectedKind: 'commit',
      schema: EncryptedOpfsCommitSchemaDto,
      binaryPayload: 'forbidden',
    });
    assertCommit({ commit: metadata });
    return metadata;
  }
}

function assertCommit({ commit }: {
  commit: EncryptedOpfsCommitDto;
}): void {
  assertEncryptedOpfsNonNegativeSafeInteger({
    value: commit.revision,
    fieldName: 'EncryptedOpfs commit revision',
  });
  validateEncryptedOpfsStableId({
    value: commit.rootDirectoryNodeId,
    fieldName: 'EncryptedOpfs rootDirectoryNodeId',
  });
  assertEncryptedOpfsObjectId({
    value: commit.inodeIndexRootObjectId,
    fieldName: 'EncryptedOpfs inodeIndexRootObjectId',
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
