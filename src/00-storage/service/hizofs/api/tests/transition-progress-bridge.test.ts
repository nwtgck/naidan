import { describe, expect, it } from 'vitest';
import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  createHomeRecordReference,
  createInodeNumber,
  createInodeRevision,
  createUInt64,
  parseFileSystemId,
  parseSegmentId,
} from '@/00-storage/service/hizofs/00-format';
import {
  HizoFSTransitionImportJournal,
  type HizoFSTransitionImportJournalBinding,
} from '@/00-storage/service/hizofs/api';
import type { StreamingNamespaceImportCheckpoint } from '@/00-storage/service/hizofs/filesystem/bulk/streaming-namespace-import';
import { parseTransitionOperationId } from '@/00-storage/service/naidan-persistence-control/00-format';
import { createTransitionNamespaceCopyCursor } from '@/00-storage/service/naidan-persistence-control/transition/namespace-copy';
import type { TransitionRuntimeProgress } from '@/00-storage/service/naidan-persistence-control/transition/transition-coordinator';
import { RuntimeHizoFSTransitionProgress } from '@/00-storage/service/naidan-opfs/runtime-hizofs-transition-progress';
import type { RuntimeTransitionBinding } from '@/00-storage/service/naidan-opfs/runtime-transition-binding';

const operationId = parseTransitionOperationId({ value: 'operation000000000001' });
const targetFileSystemId = parseFileSystemId({ value: 'abcdefghijklmnopqrstu' });
const binding: RuntimeTransitionBinding = {
  operationId,
  sourceAuthorityIdentity: 'plain-authority-1',
  sourceEndpoint: { type: 'plain' },
  targetAuthorityIdentity: 'hizofs-candidate-1',
  targetEndpoint: { fileSystemId: targetFileSystemId, type: 'hizofs' },
};
const journalBinding: HizoFSTransitionImportJournalBinding = {
  operationIdentity: operationId,
  sourceAuthorityIdentity: binding.sourceAuthorityIdentity,
  sourceEndpointIdentity: '{"type":"plain"}',
  targetAuthorityIdentity: binding.targetAuthorityIdentity,
  targetEndpointIdentity: `{"type":"hizofs","fileSystemId":"${targetFileSystemId}"}`,
};

function checkpoint(): StreamingNamespaceImportCheckpoint {
  const rootReference = createHomeRecordReference({ fields: {
    byteOffset: createUInt64({ value: 128n }),
    frameLength: 96,
    recordKind: HIZOFS_V1_FORMAT_CONSTANTS.recordKinds.inode_table_page,
    segmentId: parseSegmentId({ bytes: new Uint8Array(16).fill(7) }),
  } });
  return {
    activeFile: undefined,
    directories: [{
      directory: {
        content: { entries: [], type: 'inline' },
        inodeNumber: createInodeNumber({ value: 1n }),
        inodeRevision: createInodeRevision({ value: 1n }),
        previousName: undefined,
        timestamps: { createdAt: null, modifiedAt: null },
      },
      path: [],
    }],
    nextInodeNumber: createInodeNumber({ value: 2n }),
    rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
    rootInodeTableRootHomeRef: rootReference,
  };
}

function copyingProgress({ completedEntries }: {
  completedEntries: bigint;
}): TransitionRuntimeProgress {
  return {
    copyCursor: { ...createTransitionNamespaceCopyCursor(), completedEntries },
    operationId,
    source: binding.sourceEndpoint,
    sourceAuthorityIdentity: binding.sourceAuthorityIdentity,
    stage: 'copying',
    target: binding.targetEndpoint,
  };
}

function runtime(): RuntimeHizoFSTransitionProgress {
  return new RuntimeHizoFSTransitionProgress({ binding, journalBinding });
}

describe('runtime-only HizoFS transition progress', () => {
  it('commits a staged provider checkpoint with the matching portable cursor', async () => {
    const progress = runtime();
    const opened = await HizoFSTransitionImportJournal.open({
      binding: journalBinding,
      port: progress.providerJournalPort,
    });

    await opened.journal.saveActive({ checkpoint: checkpoint() });
    await expect(progress.progressPort.load({ operationId })).resolves.toBeUndefined();
    await progress.progressPort.save({ progress: copyingProgress({ completedEntries: 0n }) });

    await expect(progress.progressPort.load({ operationId }))
      .resolves.toEqual(copyingProgress({ completedEntries: 0n }));
    const reopened = await HizoFSTransitionImportJournal.open({
      binding: journalBinding,
      port: progress.providerJournalPort,
    });
    expect(reopened.candidate?.type).toBe('active');
  });

  it('continues bounded slices only while the same runtime owner is alive', async () => {
    const progress = runtime();
    const opened = await HizoFSTransitionImportJournal.open({
      binding: journalBinding,
      port: progress.providerJournalPort,
    });
    await opened.journal.saveSealed({ sealed: {
      nextInodeNumber: createInodeNumber({ value: 2n }),
      rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      rootInodeTableRootHomeRef: checkpoint().rootInodeTableRootHomeRef,
    } });
    await progress.progressPort.save({ progress: copyingProgress({ completedEntries: 0n }) });
    await progress.progressPort.save({ progress: copyingProgress({ completedEntries: 7n }) });

    await expect(progress.progressPort.load({ operationId }))
      .resolves.toEqual(copyingProgress({ completedEntries: 7n }));
    const reopened = await HizoFSTransitionImportJournal.open({
      binding: journalBinding,
      port: progress.providerJournalPort,
    });
    expect(reopened.candidate?.type).toBe('sealed');
  });

  it('loses both cursors and private candidates with a new runtime owner', async () => {
    const first = runtime();
    const opened = await HizoFSTransitionImportJournal.open({
      binding: journalBinding,
      port: first.providerJournalPort,
    });
    await opened.journal.saveActive({ checkpoint: checkpoint() });
    await first.progressPort.save({ progress: copyingProgress({ completedEntries: 0n }) });

    const afterProcessLoss = runtime();
    await expect(afterProcessLoss.progressPort.load({ operationId })).resolves.toBeUndefined();
    const reopened = await HizoFSTransitionImportJournal.open({
      binding: journalBinding,
      port: afterProcessLoss.providerJournalPort,
    });
    expect(reopened.candidate).toBeUndefined();
  });

  it('rejects unstaged progress and another operation or binding', async () => {
    const progress = runtime();
    await expect(progress.progressPort.save({ progress: copyingProgress({ completedEntries: 0n }) }))
      .rejects.toThrow('before the target checkpoint is staged');
    await expect(progress.progressPort.load({
      operationId: parseTransitionOperationId({ value: 'another-operation-001' }),
    }))
      .rejects.toThrow('another operation');
    expect(() => new RuntimeHizoFSTransitionProgress({
      binding,
      journalBinding: { ...journalBinding, targetAuthorityIdentity: 'another-target' },
    })).toThrow('binding disagrees');
  });
});
