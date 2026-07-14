import {
  HizoFSCommitSchemaDto,
  type HizoFSCommitDto,
} from '@/00-storage/00-dto/hizofs.dto';
import { validateHizoFSStableId } from '@/00-storage/service/hizofs/id';
import {
  assertHizoFSNonNegativeSafeInteger,
  assertHizoFSObjectId,
} from './semantic-validation';
import type { HizoFSRecordStore } from './record-store';

export class HizoFSCommitStore {
  constructor({ recordStore }: {
    recordStore: HizoFSRecordStore;
  }) {
    this.recordStore = recordStore;
  }

  private readonly recordStore: HizoFSRecordStore;

  async write({ commit }: {
    commit: HizoFSCommitDto;
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
  }): Promise<HizoFSCommitDto> {
    const { metadata } = await this.recordStore.read({
      objectId,
      expectedKind: 'commit',
      schema: HizoFSCommitSchemaDto,
      binaryPayload: 'forbidden',
    });
    assertCommit({ commit: metadata });
    return metadata;
  }
}

function assertCommit({ commit }: {
  commit: HizoFSCommitDto;
}): void {
  assertHizoFSNonNegativeSafeInteger({
    value: commit.revision,
    fieldName: 'HizoFS commit revision',
  });
  validateHizoFSStableId({
    value: commit.rootDirectoryNodeId,
    fieldName: 'HizoFS rootDirectoryNodeId',
  });
  assertHizoFSObjectId({
    value: commit.inodeIndexRootObjectId,
    fieldName: 'HizoFS inodeIndexRootObjectId',
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
