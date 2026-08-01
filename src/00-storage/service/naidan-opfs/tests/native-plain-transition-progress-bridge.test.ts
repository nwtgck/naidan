import { describe, expect, it, vi } from 'vitest';
import {
  NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS,
  parseTransitionOperationId,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import { TEST_ONLY as PERSISTENCE_RUNTIME_TEST_ONLY } from '@/00-storage/service/naidan-opfs/persistence-runtime-contract';
import type {
  AuthenticatedTransitionProgressBinding,
  AuthenticatedTransitionProgressSnapshot,
} from '@/00-storage/service/naidan-persistence-control/transition/authenticated-transition-progress-companion';
import type { TransitionRuntimeProgress } from '@/00-storage/service/naidan-persistence-control/transition/transition-coordinator';
import { createTransitionNamespaceVerificationCursor } from '@/00-storage/service/naidan-persistence-control/transition/namespace-verification';
import { NativePlainTransitionProgressBridge } from '@/00-storage/service/naidan-opfs/native-plain-transition-progress-bridge';

const operationId = parseTransitionOperationId({ value: 'operation000000000000' });
const sourceId = PERSISTENCE_RUNTIME_TEST_ONLY.createEncryptedInspection({
  fileSystemId: 'a00000000000000000000',
}).mode.activeFileSystemId;
const binding: AuthenticatedTransitionProgressBinding = {
  operationId,
  providerCheckpointCodec: NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS.providerCheckpointCodecs.nativePlain,
  sourceAuthorityIdentity: 'hizofs-source-authority-v1',
  sourceEndpoint: { fileSystemId: sourceId, type: 'hizofs' },
  targetAuthorityIdentity: 'canonical-plain-target-v1',
  targetEndpoint: { type: 'plain' },
};

class MemoryCompanion {
  snapshot: AuthenticatedTransitionProgressSnapshot | undefined;
  readonly publish = vi.fn(async ({ expectedJournalGeneration, progress }: {
    expectedJournalGeneration: bigint | undefined;
    progress: AuthenticatedTransitionProgressSnapshot;
  }) => {
    if (this.snapshot?.journalGeneration !== expectedJournalGeneration) throw new Error('companion CAS conflict');
    this.snapshot = structuredClone({ ...progress, providerCheckpointCodec: binding.providerCheckpointCodec });
    return structuredClone(this.snapshot);
  });
  readonly load = vi.fn(async () => structuredClone(this.snapshot));
  readonly clear = vi.fn(async ({ expectedJournalGeneration }: { expectedJournalGeneration: bigint }) => {
    if (this.snapshot?.journalGeneration !== expectedJournalGeneration) throw new Error('companion clear conflict');
    this.snapshot = undefined;
  });
}

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

describe('native plain transition progress bridge', () => {
  it('publishes preparing with the initial portable cursor exactly once', async () => {
    const companion = new MemoryCompanion();
    const bridge = new NativePlainTransitionProgressBridge({ binding, companion });
    await expect(bridge.prepareTarget()).resolves.toBe('preparing');
    expect(companion.publish).toHaveBeenCalledTimes(1);
    expect(companion.snapshot?.journalGeneration).toBe(0n);
    expect(companion.snapshot?.providerCheckpointState).toBe('active');

    const resumed = new NativePlainTransitionProgressBridge({ binding, companion });
    await expect(resumed.prepareTarget()).resolves.toBe('preparing');
    expect(companion.publish).toHaveBeenCalledTimes(1);
    await expect(resumed.progressPort.load({ operationId })).resolves.toMatchObject({ stage: 'copying' });
  });

  it('publishes target lifecycle and portable progress in one generation', async () => {
    const companion = new MemoryCompanion();
    const bridge = new NativePlainTransitionProgressBridge({ binding, companion });
    await bridge.prepareTarget();
    await bridge.stageLifecycle({ lifecycle: 'active' });
    const progress = verifyingProgress();
    await bridge.progressPort.save({ progress });

    expect(companion.snapshot?.journalGeneration).toBe(1n);
    expect(companion.snapshot?.providerCheckpointState).toBe('active');
    const resumed = new NativePlainTransitionProgressBridge({ binding, companion });
    await expect(resumed.currentLifecycle()).resolves.toBe('active');
    await expect(resumed.progressPort.load({ operationId })).resolves.toEqual(progress);
  });

  it('keeps the exact active marker on restart instead of clearing target bytes', async () => {
    const companion = new MemoryCompanion();
    const bridge = new NativePlainTransitionProgressBridge({ binding, companion });
    await bridge.prepareTarget();
    await bridge.stageLifecycle({ lifecycle: 'active' });
    await bridge.progressPort.save({ progress: verifyingProgress() });

    const resumed = new NativePlainTransitionProgressBridge({ binding, companion });
    await expect(resumed.prepareTarget()).resolves.toBe('active');
    expect(companion.clear).not.toHaveBeenCalled();
  });

  it('turns sealed into published before physically clearing the exact marker', async () => {
    const companion = new MemoryCompanion();
    const bridge = new NativePlainTransitionProgressBridge({ binding, companion });
    await bridge.prepareTarget();
    await bridge.stageLifecycle({ lifecycle: 'sealed' });
    await bridge.progressPort.save({ progress: verifyingProgress() });
    await bridge.progressPort.clear({ operationId });

    expect(companion.snapshot?.journalGeneration).toBe(2n);
    expect(companion.clear).not.toHaveBeenCalled();
    const published = new NativePlainTransitionProgressBridge({ binding, companion });
    await expect(published.currentLifecycle()).resolves.toBe('published');
    await published.progressPort.clear({ operationId });
    expect(companion.snapshot).toBeUndefined();
    expect(companion.clear).toHaveBeenCalledWith({ expectedJournalGeneration: 2n });
  });

  it('resumes a committed published marker after publication response loss', async () => {
    const memory = new MemoryCompanion();
    const bridge = new NativePlainTransitionProgressBridge({ binding, companion: memory });
    await bridge.prepareTarget();
    await bridge.stageLifecycle({ lifecycle: 'sealed' });
    await bridge.progressPort.save({ progress: verifyingProgress() });
    const failure = new Error('published marker response lost');
    let loseResponse = true;
    const faultingCompanion = {
      clear: memory.clear,
      load: memory.load,
      publish: vi.fn(async (input: Parameters<MemoryCompanion['publish']>[0]) => {
        const snapshot = await memory.publish(input);
        if (loseResponse && snapshot.journalGeneration === 2n) {
          loseResponse = false;
          throw failure;
        }
        return snapshot;
      }),
    };

    const switching = new NativePlainTransitionProgressBridge({ binding, companion: faultingCompanion });
    await expect(switching.progressPort.clear({ operationId })).rejects.toBe(failure);
    expect(memory.snapshot?.journalGeneration).toBe(2n);
    expect(memory.snapshot?.providerCheckpointState).toBe('sealed');

    const resumed = new NativePlainTransitionProgressBridge({ binding, companion: memory });
    await expect(resumed.currentLifecycle()).resolves.toBe('published');
    await expect(resumed.progressPort.clear({ operationId })).resolves.toBeUndefined();
    expect(memory.snapshot).toBeUndefined();
  });

  it('converges to marker absence after clear commits but its response is lost', async () => {
    const memory = new MemoryCompanion();
    const bridge = new NativePlainTransitionProgressBridge({ binding, companion: memory });
    await bridge.prepareTarget();
    await bridge.stageLifecycle({ lifecycle: 'sealed' });
    await bridge.progressPort.save({ progress: verifyingProgress() });
    await bridge.progressPort.clear({ operationId });
    const failure = new Error('marker clear response lost');
    let loseResponse = true;
    const faultingCompanion = {
      clear: vi.fn(async (input: Parameters<MemoryCompanion['clear']>[0]) => {
        await memory.clear(input);
        if (loseResponse) {
          loseResponse = false;
          throw failure;
        }
      }),
      load: memory.load,
      publish: memory.publish,
    };

    const clearing = new NativePlainTransitionProgressBridge({ binding, companion: faultingCompanion });
    await expect(clearing.progressPort.clear({ operationId })).rejects.toBe(failure);
    expect(memory.snapshot).toBeUndefined();

    const resumed = new NativePlainTransitionProgressBridge({ binding, companion: memory });
    await expect(resumed.currentLifecycle()).resolves.toBeUndefined();
    await expect(resumed.progressPort.clear({ operationId })).resolves.toBeUndefined();
    expect(faultingCompanion.clear).toHaveBeenCalledOnce();
  });

  it('rejects lifecycle regression and another operation', async () => {
    const companion = new MemoryCompanion();
    const bridge = new NativePlainTransitionProgressBridge({ binding, companion });
    await bridge.prepareTarget();
    await bridge.stageLifecycle({ lifecycle: 'sealed' });
    await expect(bridge.stageLifecycle({ lifecycle: 'active' })).rejects.toThrow('cannot move');
    await expect(bridge.progressPort.load({ operationId: 'another-operation' as typeof operationId })).rejects.toThrow('another operation');
  });
});
