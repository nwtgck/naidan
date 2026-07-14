import {
  HizoFSSuperblockSchemaDto,
  type HizoFSSuperblockDto,
} from '@/00-storage/00-dto/hizofs.dto';
import {
  HizoFSCorruptionError,
  HizoFSUnsupportedFormatError,
} from '@/00-storage/service/hizofs/errors';
import type { HizoFSObjectStore } from './object-store';

type Candidate = {
  readonly slot: 0 | 1;
  readonly value: HizoFSSuperblockDto;
};

export class HizoFSSuperblockStore {
  constructor({ objectStore, fileSystemId }: {
    objectStore: HizoFSObjectStore;
    fileSystemId: string;
  }) {
    this.objectStore = objectStore;
    this.fileSystemId = fileSystemId;
  }

  private readonly objectStore: HizoFSObjectStore;
  private readonly fileSystemId: string;

  async read(): Promise<HizoFSSuperblockDto | undefined> {
    return (await this.readCandidates())[0];
  }

  async readCandidates(): Promise<readonly HizoFSSuperblockDto[]> {
    const candidates: Candidate[] = [];
    const corruptions: unknown[] = [];

    for (const slot of [0, 1] as const) {
      let record;
      try {
        record = await this.objectStore.readSuperblock({ slot });
      } catch (error) {
        if (error instanceof HizoFSUnsupportedFormatError) {
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
        throw new HizoFSUnsupportedFormatError({
          message: `HizoFS superblock slot ${String(slot)} has an unsupported record kind`,
        });
      }
      if (record.recordVersion !== 1) {
        throw new HizoFSUnsupportedFormatError({
          message: `HizoFS superblock record version is unsupported: ${String(record.recordVersion)}`,
        });
      }
      if (record.binaryPayload.byteLength !== 0) {
        throw new HizoFSCorruptionError({
          message: 'HizoFS superblock contains an unexpected binary payload',
          cause: undefined,
        });
      }

      const value = HizoFSSuperblockSchemaDto.parse(record.metadata);
      if (value.fileSystemId !== this.fileSystemId) {
        throw new HizoFSCorruptionError({
          message: 'HizoFS superblock fileSystemId does not match its descriptor',
          cause: undefined,
        });
      }
      if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) {
        throw new HizoFSCorruptionError({
          message: 'HizoFS superblock sequence is invalid',
          cause: undefined,
        });
      }
      candidates.push({ slot, value });
    }

    candidates.sort((left, right) => right.value.sequence - left.value.sequence);
    if (candidates.length === 0) {
      if (corruptions.length > 0) {
        throw new HizoFSCorruptionError({
          message: 'No valid HizoFS superblock slot remains',
          cause: new AggregateError(corruptions),
        });
      }
      return [];
    }
    if (
      candidates.length >= 2
      && candidates[0]?.value.sequence === candidates[1]?.value.sequence
    ) {
      throw new HizoFSCorruptionError({
        message: 'HizoFS superblock slots have the same sequence',
        cause: undefined,
      });
    }
    return candidates.map(candidate => candidate.value);
  }

  async write({ value }: {
    value: HizoFSSuperblockDto;
  }): Promise<void> {
    if (value.fileSystemId !== this.fileSystemId) {
      throw new Error('HizoFS superblock fileSystemId does not match the open file system');
    }
    if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) {
      throw new Error('HizoFS superblock sequence must be a non-negative safe integer');
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
