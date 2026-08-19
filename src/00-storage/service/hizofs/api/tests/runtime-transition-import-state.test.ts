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
import type {
  HizoFSTransitionImportCandidate,
  HizoFSTransitionImportStatePort,
} from '@/00-storage/service/hizofs/api';
import type { StreamingNamespaceImportCheckpoint } from '@/00-storage/service/hizofs/filesystem/bulk/streaming-namespace-import';
import { parseTransitionOperationId } from '@/00-storage/service/naidan-persistence-control/00-format';
import { createTransitionNamespaceCopyCursor } from '@/00-storage/service/naidan-persistence-control/transition/namespace-copy';
import { createTransitionNamespaceVerificationCursor } from '@/00-storage/service/naidan-persistence-control/transition/namespace-verification';
import type { TransitionRuntimeProgress } from '@/00-storage/service/naidan-persistence-control/transition/transition-coordinator';
import { RuntimeHizoFSTransitionImportState } from '@/00-storage/service/naidan-opfs/runtime-hizofs-transition-import-state';
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

function checkpoint({ nextInodeNumber = 2n }: {
  nextInodeNumber?: bigint;
} = {}): StreamingNamespaceImportCheckpoint {
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
    nextInodeNumber: createInodeNumber({ value: nextInodeNumber }),
    rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
    rootInodeTableRootHomeRef: rootReference,
  };
}

function activeCandidate({ nextInodeNumber = 2n }: {
  nextInodeNumber?: bigint;
} = {}): HizoFSTransitionImportCandidate {
  return { checkpoint: checkpoint({ nextInodeNumber }), type: 'active' };
}

function sealedCandidate(): HizoFSTransitionImportCandidate {
  return {
    sealed: {
      nextInodeNumber: createInodeNumber({ value: 4n }),
      rootDirectoryInodeNumber: createInodeNumber({ value: 1n }),
      rootInodeTableRootHomeRef: checkpoint().rootInodeTableRootHomeRef,
    },
    type: 'sealed',
  };
}

function copyingProgress({ completedEntries }: {
  completedEntries: bigint;
}): Extract<TransitionRuntimeProgress, { stage: 'copying' }> {
  return {
    copyCursor: { ...createTransitionNamespaceCopyCursor(), completedEntries },
    operationId,
    source: binding.sourceEndpoint,
    sourceAuthorityIdentity: binding.sourceAuthorityIdentity,
    stage: 'copying',
    target: binding.targetEndpoint,
  };
}

function verifyingProgress(): Extract<TransitionRuntimeProgress, { stage: 'verifying' }> {
  return {
    operationId,
    source: binding.sourceEndpoint,
    sourceAuthorityIdentity: binding.sourceAuthorityIdentity,
    stage: 'verifying',
    target: binding.targetEndpoint,
    verificationCursor: createTransitionNamespaceVerificationCursor(),
  };
}

function runtime(): RuntimeHizoFSTransitionImportState {
  return new RuntimeHizoFSTransitionImportState({ binding });
}

describe('HizoFS transition invocation runtime state', () => {
  it('commits one owned active candidate with the portable cursor from the same slice', async () => {
    const state = runtime();
    const candidate = activeCandidate();
    await state.importStatePort.stageCandidate({ candidate, operationIdentity: operationId });
    await expect(state.importStatePort.loadCandidate({ operationIdentity: operationId })).resolves.toBeUndefined();
    await expect(state.progressPort.load({ operationId })).resolves.toBeUndefined();

    await state.progressPort.save({ progress: copyingProgress({ completedEntries: 0n }) });
    if (candidate.type !== 'active') throw new Error('expected active candidate');
    (candidate.checkpoint.directories[0]?.path as string[]).push('mutated-after-stage');

    await expect(state.progressPort.load({ operationId }))
      .resolves.toEqual(copyingProgress({ completedEntries: 0n }));
    await expect(state.importStatePort.loadCandidate({ operationIdentity: operationId }))
      .resolves.toMatchObject({ checkpoint: { directories: [{ path: [] }] }, type: 'active' });
  });

  it('discards only the uncommitted target candidate after a failed slice', async () => {
    const state = runtime();
    await state.importStatePort.stageCandidate({
      candidate: activeCandidate(),
      operationIdentity: operationId,
    });
    await state.progressPort.save({ progress: copyingProgress({ completedEntries: 0n }) });
    await state.importStatePort.stageCandidate({
      candidate: activeCandidate({ nextInodeNumber: 3n }),
      operationIdentity: operationId,
    });

    await state.importStatePort.discardStagedCandidate({ operationIdentity: operationId });

    await expect(state.importStatePort.loadCandidate({ operationIdentity: operationId }))
      .resolves.toMatchObject({ checkpoint: { nextInodeNumber: 2n }, type: 'active' });
    await state.importStatePort.stageCandidate({
      candidate: activeCandidate({ nextInodeNumber: 4n }),
      operationIdentity: operationId,
    });
    await state.progressPort.save({ progress: copyingProgress({ completedEntries: 4n }) });
    await expect(state.importStatePort.loadCandidate({ operationIdentity: operationId }))
      .resolves.toMatchObject({ checkpoint: { nextInodeNumber: 4n }, type: 'active' });
  });

  it('continues active slices and retains one sealed private root through verification', async () => {
    const state = runtime();
    await state.importStatePort.stageCandidate({
      candidate: activeCandidate(),
      operationIdentity: operationId,
    });
    await state.progressPort.save({ progress: copyingProgress({ completedEntries: 0n }) });
    await state.importStatePort.stageCandidate({
      candidate: activeCandidate({ nextInodeNumber: 3n }),
      operationIdentity: operationId,
    });
    await state.progressPort.save({ progress: copyingProgress({ completedEntries: 7n }) });
    await expect(state.importStatePort.loadCandidate({ operationIdentity: operationId }))
      .resolves.toMatchObject({ checkpoint: { nextInodeNumber: 3n }, type: 'active' });

    await state.importStatePort.stageCandidate({ candidate: sealedCandidate(), operationIdentity: operationId });
    await state.progressPort.save({ progress: verifyingProgress() });
    await state.progressPort.save({ progress: {
      ...verifyingProgress(),
      verificationCursor: { ...createTransitionNamespaceVerificationCursor(), verifiedEntries: 5n },
    } });
    await expect(state.importStatePort.loadCandidate({ operationIdentity: operationId }))
      .resolves.toMatchObject({ sealed: { nextInodeNumber: 4n }, type: 'sealed' });
  });

  it('loses both portable progress and private candidates with its runtime owner', async () => {
    const first = runtime();
    await first.importStatePort.stageCandidate({ candidate: activeCandidate(), operationIdentity: operationId });
    await first.progressPort.save({ progress: copyingProgress({ completedEntries: 0n }) });

    const afterRuntimeLoss = runtime();
    await expect(afterRuntimeLoss.progressPort.load({ operationId })).resolves.toBeUndefined();
    await expect(afterRuntimeLoss.importStatePort.loadCandidate({ operationIdentity: operationId }))
      .resolves.toBeUndefined();
  });

  it('does not advance progress when provider candidate staging fails', async () => {
    const state = runtime();
    const failingProviderPort: HizoFSTransitionImportStatePort = {
      ...state.importStatePort,
      stageCandidate: async (): Promise<void> => {
        throw new Error('injected provider candidate failure');
      },
    };

    await expect(failingProviderPort.stageCandidate({
      candidate: activeCandidate(),
      operationIdentity: operationId,
    })).rejects.toThrow('injected provider candidate failure');
    await expect(state.progressPort.save({ progress: copyingProgress({ completedEntries: 0n }) }))
      .rejects.toThrow('same target slice');
    await expect(state.progressPort.load({ operationId })).resolves.toBeUndefined();
  });

  it('rejects stale operations, endpoint binding changes, duplicate slices, and sealed regression', async () => {
    const state = runtime();
    const otherOperationId = parseTransitionOperationId({ value: 'another-operation-001' });
    await expect(state.importStatePort.loadCandidate({ operationIdentity: otherOperationId }))
      .rejects.toThrow('another operation');
    await expect(state.progressPort.load({ operationId: otherOperationId }))
      .rejects.toThrow('another operation');
    await expect(state.progressPort.clear({ operationId: otherOperationId }))
      .rejects.toThrow('another operation');

    await state.importStatePort.stageCandidate({ candidate: activeCandidate(), operationIdentity: operationId });
    await expect(state.importStatePort.stageCandidate({
      candidate: activeCandidate({ nextInodeNumber: 3n }),
      operationIdentity: operationId,
    })).rejects.toThrow('uncommitted target slice');
    await expect(state.progressPort.save({ progress: {
      ...copyingProgress({ completedEntries: 0n }),
      target: { type: 'plain' },
    } })).rejects.toThrow('another transition binding');
    await state.progressPort.save({ progress: copyingProgress({ completedEntries: 0n }) });

    await state.importStatePort.stageCandidate({ candidate: sealedCandidate(), operationIdentity: operationId });
    await state.progressPort.save({ progress: verifyingProgress() });
    await expect(state.importStatePort.stageCandidate({ candidate: activeCandidate(), operationIdentity: operationId }))
      .rejects.toThrow('cannot return to an active checkpoint');
  });
});
