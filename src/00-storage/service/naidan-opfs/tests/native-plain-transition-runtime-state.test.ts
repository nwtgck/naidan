import { describe, expect, it } from 'vitest';
import { parseTransitionOperationId } from '@/00-storage/service/naidan-persistence-control/00-format';
import type { TransitionRuntimeProgress } from '@/00-storage/service/naidan-persistence-control/transition/transition-coordinator';
import { createTransitionNamespaceVerificationCursor } from '@/00-storage/service/naidan-persistence-control/transition/namespace-verification';
import {
  NativePlainTransitionRuntimeState,
} from '@/00-storage/service/naidan-opfs/native-plain-transition-runtime-state';
import { TEST_ONLY as PERSISTENCE_RUNTIME_TEST_ONLY } from '@/00-storage/service/naidan-opfs/persistence-runtime-contract';
import type { RuntimeTransitionBinding } from '@/00-storage/service/naidan-opfs/runtime-transition-binding';

const operationId = parseTransitionOperationId({ value: 'operation000000000000' });
const sourceId = PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({
  fileSystemId: 'a00000000000000000000',
}).mode.activeFileSystemId;
const binding: RuntimeTransitionBinding = {
  operationId,
  sourceAuthorityIdentity: 'hizofs-source-authority-v1',
  sourceEndpoint: { fileSystemId: sourceId, type: 'hizofs' },
  targetAuthorityIdentity: 'canonical-plain-target-v1',
  targetEndpoint: { type: 'plain' },
};

function verifyingProgress(): TransitionRuntimeProgress {
  return {
    operationId,
    source: binding.sourceEndpoint,
    sourceAuthorityIdentity: binding.sourceAuthorityIdentity,
    stage: 'verifying',
    target: binding.targetEndpoint,
    verificationCursor: createTransitionNamespaceVerificationCursor(),
  };
}

function runtime(): NativePlainTransitionRuntimeState {
  return new NativePlainTransitionRuntimeState({ binding });
}

describe('native plain transition runtime state', () => {
  it('keeps lifecycle and portable progress across slices in one invocation', async () => {
    const state = runtime();
    await expect(state.prepareTarget()).resolves.toBe('preparing');
    await expect(state.progressPort.load({ operationId })).resolves.toMatchObject({ stage: 'copying' });

    await state.stageLifecycle({ lifecycle: 'active' });
    const progress = verifyingProgress();
    await state.progressPort.save({ progress });

    await expect(state.currentLifecycle()).resolves.toBe('active');
    await expect(state.progressPort.load({ operationId })).resolves.toEqual(progress);
  });

  it('starts empty after process loss instead of restoring a target marker', async () => {
    const first = runtime();
    await first.prepareTarget();
    await first.stageLifecycle({ lifecycle: 'active' });
    await first.progressPort.save({ progress: verifyingProgress() });

    const afterProcessLoss = runtime();
    await expect(afterProcessLoss.currentLifecycle()).resolves.toBeUndefined();
    await expect(afterProcessLoss.progressPort.load({ operationId })).resolves.toBeUndefined();
    await expect(afterProcessLoss.prepareTarget()).resolves.toBe('preparing');
  });

  it('turns sealed into published before releasing its runtime marker', async () => {
    const state = runtime();
    await state.prepareTarget();
    await state.stageLifecycle({ lifecycle: 'sealed' });
    await state.progressPort.save({ progress: verifyingProgress() });
    await state.progressPort.clear({ operationId });

    await expect(state.currentLifecycle()).resolves.toBe('published');
    await state.progressPort.clear({ operationId });
    await expect(state.currentLifecycle()).resolves.toBeUndefined();
    await expect(state.progressPort.load({ operationId })).resolves.toBeUndefined();
  });

  it('drops every invocation-local marker when a target is abandoned', async () => {
    const state = runtime();
    await state.prepareTarget();
    await state.stageLifecycle({ lifecycle: 'sealed' });
    await state.progressPort.save({ progress: verifyingProgress() });

    await state.abandonTarget({ operationId });

    await expect(state.currentLifecycle()).resolves.toBeUndefined();
    await expect(state.progressPort.load({ operationId })).resolves.toBeUndefined();
  });

  it('rejects lifecycle regression, another operation, and another binding', async () => {
    const state = runtime();
    await state.prepareTarget();
    await state.stageLifecycle({ lifecycle: 'sealed' });
    await expect(state.stageLifecycle({ lifecycle: 'active' })).rejects.toThrow('cannot move');
    await expect(state.progressPort.load({
      operationId: parseTransitionOperationId({ value: 'another-operation-001' }),
    }))
      .rejects.toThrow('another operation');
    await expect(state.progressPort.save({
      progress: { ...verifyingProgress(), sourceAuthorityIdentity: 'another-source' },
    })).rejects.toThrow('another transition binding');
  });
});
