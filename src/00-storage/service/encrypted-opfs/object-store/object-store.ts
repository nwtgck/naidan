import type { EncryptedOpfsBackingStore } from '@/00-storage/service/encrypted-opfs/backing-store/backing-store';
import { EncryptedOpfsCorruptionError } from '@/00-storage/service/encrypted-opfs/errors';
import {
  decryptEncryptedOpfsObject,
  encryptEncryptedOpfsObject,
} from '@/00-storage/service/encrypted-opfs/crypto/object-crypto';
import {
  decodeEncryptedOpfsObjectEnvelope,
  encodeEncryptedOpfsObjectEnvelope,
} from '@/00-storage/service/encrypted-opfs/format/object-envelope';
import {
  decodeEncryptedOpfsRecord,
  encodeEncryptedOpfsRecord,
  type DecodedEncryptedOpfsRecord,
  type EncryptedOpfsRecordKind,
} from '@/00-storage/service/encrypted-opfs/format/record';
import {
  createEncryptedOpfsObjectId,
  getEncryptedOpfsObjectShard,
} from './object-id';

export type EncryptedOpfsObjectStoreRecord = {
  readonly kind: EncryptedOpfsRecordKind;
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
    return ['objects', getEncryptedOpfsObjectShard({ objectId }), `${objectId}.eopfs`];
  case 'superblock':
    return [`${objectId}.eopfs`];
  default: {
    const _ex: never = area;
    throw new Error(`Unhandled EncryptedOpfs object area: ${String(_ex)}`);
  }
  }
}

export class EncryptedOpfsObjectStore {
  constructor({ backingStore, rootKey, fileSystemId }: {
    backingStore: EncryptedOpfsBackingStore;
    rootKey: CryptoKey;
    fileSystemId: string;
  }) {
    this.backingStore = backingStore;
    this.rootKey = rootKey;
    this.fileSystemId = fileSystemId;
  }

  private readonly backingStore: EncryptedOpfsBackingStore;
  private readonly rootKey: CryptoKey;
  private readonly fileSystemId: string;

  async create({ record }: {
    record: EncryptedOpfsObjectStoreRecord;
  }): Promise<string> {
    const objectId = createEncryptedOpfsObjectId();
    await this.writeObject({ objectId, area: 'object', record });
    return objectId;
  }

  async read({ objectId }: {
    objectId: string;
  }): Promise<DecodedEncryptedOpfsRecord | undefined> {
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
    record: EncryptedOpfsObjectStoreRecord;
  }): Promise<void> {
    await this.writeObject({
      objectId: `superblock-${String(slot)}`,
      area: 'superblock',
      record,
    });
  }

  async readSuperblock({ slot }: {
    slot: 0 | 1;
  }): Promise<DecodedEncryptedOpfsRecord | undefined> {
    return this.readObject({
      objectId: `superblock-${String(slot)}`,
      area: 'superblock',
    });
  }

  private async writeObject({ objectId, area, record }: {
    objectId: string;
    area: 'object' | 'superblock';
    record: EncryptedOpfsObjectStoreRecord;
  }): Promise<void> {
    const plaintext = encodeEncryptedOpfsRecord(record);
    const { nonce, ciphertext } = await encryptEncryptedOpfsObject({
      rootKey: this.rootKey,
      fileSystemId: this.fileSystemId,
      objectIdentity: objectId,
      area,
      plaintext,
    });
    await this.backingStore.write({
      path: getPhysicalPath({ area, objectId }),
      bytes: encodeEncryptedOpfsObjectEnvelope({ nonce, ciphertext }),
    });
  }

  private async readObject({ objectId, area }: {
    objectId: string;
    area: 'object' | 'superblock';
  }): Promise<DecodedEncryptedOpfsRecord | undefined> {
    const physical = await this.backingStore.read({
      path: getPhysicalPath({ area, objectId }),
    });
    if (physical === undefined) {
      return undefined;
    }
    const { nonce, ciphertext } = decodeEncryptedOpfsObjectEnvelope({ physical });
    let plaintext: Uint8Array;
    try {
      plaintext = await decryptEncryptedOpfsObject({
        rootKey: this.rootKey,
        fileSystemId: this.fileSystemId,
        objectIdentity: objectId,
        area,
        nonce,
        ciphertext,
      });
    } catch (error) {
      throw new EncryptedOpfsCorruptionError({
        message: `EncryptedOpfs ${area} authentication failed`,
        cause: error,
      });
    }
    return decodeEncryptedOpfsRecord({ plaintext });
  }

  private getObjectPath({ objectId }: {
    objectId: string;
  }): readonly string[] {
    return [
      'objects',
      getEncryptedOpfsObjectShard({ objectId }),
      `${objectId}.eopfs`,
    ];
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
