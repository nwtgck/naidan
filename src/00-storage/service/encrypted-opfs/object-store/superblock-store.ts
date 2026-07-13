import {
  EncryptedOpfsSuperblockSchemaDto,
  type EncryptedOpfsSuperblockDto,
} from '@/00-storage/00-dto/encrypted-opfs.dto';
import {
  EncryptedOpfsCorruptionError,
  EncryptedOpfsUnsupportedFormatError,
} from '@/00-storage/service/encrypted-opfs/errors';
import type { EncryptedOpfsObjectStore } from './object-store';

type Candidate = {
  readonly slot: 0 | 1;
  readonly value: EncryptedOpfsSuperblockDto;
};

export class EncryptedOpfsSuperblockStore {
  constructor({ objectStore, fileSystemId }: {
    objectStore: EncryptedOpfsObjectStore;
    fileSystemId: string;
  }) {
    this.objectStore = objectStore;
    this.fileSystemId = fileSystemId;
  }

  private readonly objectStore: EncryptedOpfsObjectStore;
  private readonly fileSystemId: string;

  async read(): Promise<EncryptedOpfsSuperblockDto | undefined> {
    return (await this.readCandidates())[0];
  }

  async readCandidates(): Promise<readonly EncryptedOpfsSuperblockDto[]> {
    const candidates: Candidate[] = [];
    const corruptions: unknown[] = [];

    for (const slot of [0, 1] as const) {
      let record;
      try {
        record = await this.objectStore.readSuperblock({ slot });
      } catch (error) {
        if (error instanceof EncryptedOpfsUnsupportedFormatError) {
          throw error;
        }
        corruptions.push(error);
        continue;
      }
      if (record === undefined) {
        continue;
      }
      switch (record.kind) {
      case 'superblock':
        break;
      default:
        throw new EncryptedOpfsUnsupportedFormatError({
          message: `EncryptedOpfs superblock slot ${String(slot)} has an unsupported record kind`,
        });
      }
      if (record.recordVersion !== 1) {
        throw new EncryptedOpfsUnsupportedFormatError({
          message: `EncryptedOpfs superblock record version is unsupported: ${String(record.recordVersion)}`,
        });
      }
      if (record.binaryPayload.byteLength !== 0) {
        throw new EncryptedOpfsCorruptionError({
          message: 'EncryptedOpfs superblock contains an unexpected binary payload',
          cause: undefined,
        });
      }

      const value = EncryptedOpfsSuperblockSchemaDto.parse(record.metadata);
      if (value.fileSystemId !== this.fileSystemId) {
        throw new EncryptedOpfsCorruptionError({
          message: 'EncryptedOpfs superblock fileSystemId does not match its descriptor',
          cause: undefined,
        });
      }
      if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) {
        throw new EncryptedOpfsCorruptionError({
          message: 'EncryptedOpfs superblock sequence is invalid',
          cause: undefined,
        });
      }
      candidates.push({ slot, value });
    }

    candidates.sort((left, right) => right.value.sequence - left.value.sequence);
    if (candidates.length === 0) {
      if (corruptions.length > 0) {
        throw new EncryptedOpfsCorruptionError({
          message: 'No valid EncryptedOpfs superblock slot remains',
          cause: new AggregateError(corruptions),
        });
      }
      return [];
    }
    if (
      candidates.length >= 2
      && candidates[0]?.value.sequence === candidates[1]?.value.sequence
    ) {
      throw new EncryptedOpfsCorruptionError({
        message: 'EncryptedOpfs superblock slots have the same sequence',
        cause: undefined,
      });
    }
    return candidates.map(candidate => candidate.value);
  }

  async write({ value }: {
    value: EncryptedOpfsSuperblockDto;
  }): Promise<void> {
    if (value.fileSystemId !== this.fileSystemId) {
      throw new Error('EncryptedOpfs superblock fileSystemId does not match the open file system');
    }
    if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) {
      throw new Error('EncryptedOpfs superblock sequence must be a non-negative safe integer');
    }
    await this.objectStore.writeSuperblock({
      slot: value.sequence % 2 as 0 | 1,
      record: {
        kind: 'superblock',
        recordVersion: 1,
        metadata: value,
        binaryPayload: new Uint8Array(),
      },
    });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
