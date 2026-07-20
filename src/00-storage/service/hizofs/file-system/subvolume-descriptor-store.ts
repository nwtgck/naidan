import {
  HizoFSSubvolumeDescriptorSchemaDto,
  type HizoFSSubvolumeDescriptorDto,
} from '@/00-storage/00-dto/hizofs.dto';
import { validateHizoFSStableId } from '@/00-storage/service/hizofs/id';
import { assertHizoFSObjectId } from './semantic-validation';
import type { HizoFSRecordStore } from './record-store';

export class HizoFSSubvolumeDescriptorStore {
  constructor({ recordStore }: { recordStore: HizoFSRecordStore }) {
    this.recordStore = recordStore;
  }

  private readonly recordStore: HizoFSRecordStore;

  async write({ descriptor }: {
    descriptor: HizoFSSubvolumeDescriptorDto;
  }): Promise<string> {
    assertDescriptor({ descriptor });
    return this.recordStore.write({
      kind: 'subvolume_descriptor',
      metadata: descriptor,
      binaryPayload: new Uint8Array(),
    });
  }

  async read({ objectId }: { objectId: string }): Promise<HizoFSSubvolumeDescriptorDto> {
    const { metadata } = await this.recordStore.read({
      objectId,
      expectedKind: 'subvolume_descriptor',
      schema: HizoFSSubvolumeDescriptorSchemaDto,
      binaryPayload: 'forbidden',
    });
    assertDescriptor({ descriptor: metadata });
    return metadata;
  }
}

function assertDescriptor({ descriptor }: {
  descriptor: HizoFSSubvolumeDescriptorDto;
}): void {
  validateHizoFSStableId({
    value: descriptor.subvolumeId,
    fieldName: 'HizoFS subvolume ID',
  });
  switch (descriptor.access) {
  case 'read':
    assertHizoFSObjectId({
      value: descriptor.fixedCommitObjectId,
      fieldName: 'HizoFS fixed subvolume commit ObjectRef',
    });
    break;
  case 'read_write':
    break;
  default: {
    const _ex: never = descriptor;
    throw new Error(`Unhandled HizoFS subvolume descriptor: ${String(_ex)}`);
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
