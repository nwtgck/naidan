import type { HizoFSBackingStore } from '@/00-storage/service/hizofs/backing-store/backing-store';
import { HizoFSCorruptionError } from '@/00-storage/service/hizofs/errors';
import {
  decryptHizoFSObject,
  encryptHizoFSObject,
} from '@/00-storage/service/hizofs/crypto/object-crypto';
import {
  decodeHizoFSObjectEnvelope,
  encodeHizoFSObjectEnvelope,
} from '@/00-storage/service/hizofs/format/object-envelope';
import {
  decodeHizoFSRecord,
  encodeHizoFSRecord,
  type DecodedHizoFSRecord,
  type HizoFSRecordKind,
} from '@/00-storage/service/hizofs/format/record';
import {
  createHizoFSObjectId,
  getHizoFSObjectShard,
} from './object-id';

export type HizoFSObjectStoreRecord = {
  readonly kind: HizoFSRecordKind;
  readonly recordVersion: number;
  readonly metadata: unknown;
  readonly binaryPayload: Uint8Array;
};

function getPhysicalPath({ area, objectId }: {
  area: 'object' | 'superblock';
  objectId: string;
}): readonly string[] {
  switch (area) {
  case 'object':
    return ['objects', getHizoFSObjectShard({ objectId }), `${objectId}.enc`];
  case 'superblock':
    return [`${objectId}.enc`];
  default: {
    const _ex: never = area;
    throw new Error(`Unhandled HizoFS object area: ${String(_ex)}`);
  }
  }
}

export class HizoFSObjectStore {
  constructor({ backingStore, rootKey, fileSystemId }: {
    backingStore: HizoFSBackingStore;
    rootKey: CryptoKey;
    fileSystemId: string;
  }) {
    this.backingStore = backingStore;
    this.rootKey = rootKey;
    this.fileSystemId = fileSystemId;
  }

  private readonly backingStore: HizoFSBackingStore;
  private readonly rootKey: CryptoKey;
  private readonly fileSystemId: string;

  async create({ record }: {
    record: HizoFSObjectStoreRecord;
  }): Promise<string> {
    const objectId = createHizoFSObjectId();
    await this.writeObject({ objectId, area: 'object', record });
    return objectId;
  }

  async read({ objectId }: {
    objectId: string;
  }): Promise<DecodedHizoFSRecord | undefined> {
    return this.readObject({ objectId, area: 'object' });
  }

  async remove({ objectId }: {
    objectId: string;
  }): Promise<void> {
    await this.backingStore.remove({
      path: this.getObjectPath({ objectId }),
      recursive: false,
    });
  }

  async writeSuperblock({ slot, record }: {
    slot: 0 | 1;
    record: HizoFSObjectStoreRecord;
  }): Promise<void> {
    await this.writeObject({
      objectId: `superblock-${String(slot)}`,
      area: 'superblock',
      record,
    });
  }

  async readSuperblock({ slot }: {
    slot: 0 | 1;
  }): Promise<DecodedHizoFSRecord | undefined> {
    return this.readObject({
      objectId: `superblock-${String(slot)}`,
      area: 'superblock',
    });
  }

  private async writeObject({ objectId, area, record }: {
    objectId: string;
    area: 'object' | 'superblock';
    record: HizoFSObjectStoreRecord;
  }): Promise<void> {
    const plaintext = encodeHizoFSRecord(record);
    const { nonce, ciphertext } = await encryptHizoFSObject({
      rootKey: this.rootKey,
      fileSystemId: this.fileSystemId,
      objectIdentity: objectId,
      area,
      plaintext,
    });
    await this.backingStore.write({
      path: getPhysicalPath({ area, objectId }),
      bytes: encodeHizoFSObjectEnvelope({ nonce, ciphertext }),
    });
  }

  private async readObject({ objectId, area }: {
    objectId: string;
    area: 'object' | 'superblock';
  }): Promise<DecodedHizoFSRecord | undefined> {
    const physical = await this.backingStore.read({
      path: getPhysicalPath({ area, objectId }),
    });
    if (physical === undefined) {
      return undefined;
    }
    const { nonce, ciphertext } = decodeHizoFSObjectEnvelope({ physical });
    let plaintext: Uint8Array;
    try {
      plaintext = await decryptHizoFSObject({
        rootKey: this.rootKey,
        fileSystemId: this.fileSystemId,
        objectIdentity: objectId,
        area,
        nonce,
        ciphertext,
      });
    } catch (error) {
      throw new HizoFSCorruptionError({
        message: `HizoFS ${area} authentication failed`,
        cause: error,
      });
    }
    return decodeHizoFSRecord({ plaintext });
  }

  private getObjectPath({ objectId }: {
    objectId: string;
  }): readonly string[] {
    return [
      'objects',
      getHizoFSObjectShard({ objectId }),
      `${objectId}.enc`,
    ];
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
