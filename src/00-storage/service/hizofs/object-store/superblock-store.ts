import {
  HizoFSSuperblockSchemaDto,
  type HizoFSSuperblockDto,
} from '@/00-storage/00-dto/hizofs.dto';
import {
  HizoFSCorruptionError,
  HizoFSUnsupportedFormatError,
} from '@/00-storage/service/hizofs/errors';
import type { HizoFSObjectStore } from './object-store';
import { assertHizoFSObjectId } from '@/00-storage/service/hizofs/file-system/semantic-validation';
import type { HizoFSHeadScope } from '@/00-storage/service/hizofs/segment-store/head-scope';

type Candidate = {
  readonly slot: 0 | 1;
  readonly value: HizoFSSuperblockDto;
};

export type HizoFSSuperblockCandidateSet = {
  readonly candidates: readonly HizoFSSuperblockDto[];
  readonly unusableSlotCount: number;
};

export class HizoFSSuperblockStore {
  constructor({ objectStore, fileSystemId, headScope }: {
    objectStore: HizoFSObjectStore;
    fileSystemId: string;
    headScope: HizoFSHeadScope;
  }) {
    this.objectStore = objectStore;
    this.fileSystemId = fileSystemId;
    this.headScope = headScope;
  }

  private readonly objectStore: HizoFSObjectStore;
  private readonly fileSystemId: string;
  readonly headScope: HizoFSHeadScope;

  async read(): Promise<HizoFSSuperblockDto | undefined> {
    return (await this.readCandidateSet()).candidates[0];
  }

  async readCandidates(): Promise<readonly HizoFSSuperblockDto[]> {
    return (await this.readCandidateSet()).candidates;
  }

  async readCandidateSet(): Promise<HizoFSSuperblockCandidateSet> {
    const candidates: Candidate[] = [];
    const corruptions: unknown[] = [];
    let missingSlotCount = 0;

    for (const slot of [0, 1] as const) {
      try {
        const record = await this.objectStore.readSuperblock({
          scope: this.headScope,
          slot,
        });
        if (record === undefined) {
          missingSlotCount += 1;
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
            message: 'HizoFS superblock fileSystemId does not match the root-key-derived file system ID',
            cause: undefined,
          });
        }
        if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) {
          throw new HizoFSCorruptionError({
            message: 'HizoFS superblock sequence is invalid',
            cause: undefined,
          });
        }
        assertHizoFSObjectId({
          value: value.subvolumeDescriptorObjectId,
          fieldName: 'HizoFS root subvolume descriptor ObjectRef',
        });
        candidates.push({ slot, value });
      } catch (error) {
        if (error instanceof HizoFSUnsupportedFormatError) {
          // An authenticated format this reader does not understand must not
          // be hidden by selecting an older writable generation.
          throw error;
        }
        corruptions.push(error);
      }
    }

    candidates.sort((left, right) => right.value.sequence - left.value.sequence);
    if (candidates.length === 0) {
      const onlyCorruption = corruptions.length === 1
        ? corruptions[0]
        : undefined;
      if (onlyCorruption instanceof HizoFSCorruptionError) {
        throw onlyCorruption;
      }
      if (corruptions.length > 0) {
        throw new HizoFSCorruptionError({
          message: 'No valid HizoFS superblock slot remains',
          cause: new AggregateError(corruptions),
        });
      }
      return { candidates: [], unusableSlotCount: 2 };
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
    return {
      candidates: candidates.map(candidate => candidate.value),
      unusableSlotCount: corruptions.length + missingSlotCount,
    };
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
    assertHizoFSObjectId({
      value: value.subvolumeDescriptorObjectId,
      fieldName: 'HizoFS root subvolume descriptor ObjectRef',
    });
    await this.objectStore.writeSuperblock({
      scope: this.headScope,
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
