import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeDownloadVerificationRuntimeEvidence } from './complete-download-verification-runtime-evidence';
import { reuseDownloadedProductionRevision } from './reuse-downloaded-production-revision';
import type { DownloadVerificationEvidenceInput } from '@/features/transformers-js/download-verification/evidence/types';
import type { DownloadVerificationCachedRevisionInventory } from './inspect-cached-revisions';
import type { ModelLoadResult } from '@/features/transformers-js/types';
import type { TransformersJsProgressCallback } from '@/features/transformers-js/types';
import { withCacheAcceptanceDeadline } from '@/features/transformers-js/model-support-investigation/logic/cache-acceptance-deadline';
import { runInvestigationTargetsSequentially } from '@/features/transformers-js/model-support-investigation/logic/run-investigation-targets-sequentially';
import { createInitialInvestigationCheckpoint } from '@/features/transformers-js/model-support-investigation/logic/investigation-recovery';

const mocks = vi.hoisted(() => ({
  verify: vi.fn(), dispose: vi.fn(), create: vi.fn(),
}));
vi.mock('@/features/transformers-js/download-verification/candidate-acceptance-worker/client-hosted', () => ({
  createDownloadVerificationCandidateAcceptanceWorkerClient: mocks.create,
}));
afterEach(() => vi.clearAllMocks());

const REVISION = 'a'.repeat(40);
function input(): DownloadVerificationEvidenceInput {
  return {
    schemaVersion: 1, runId: 'lifecycle', mode: 'probe-only',
    run: {
      modelId: 'fixture/lifecycle', normalizedModelId: 'fixture/lifecycle', requestedRevision: 'main',
      resolvedRevision: REVISION, repositoryFileCount: 0, repositoryFiles: [], transportObservations: [],
      skippedModelArtifactCount: 0, bytesConsumed: 0, maximumBytes: 1024,
      startedAt: '2026-09-08T00:00:00.000Z', finishedAt: '2026-09-08T00:00:00.001Z',
    },
    modelArtifactObservations: [], modelArtifactObservationError: undefined,
    cacheBefore: undefined, cacheInspectionError: undefined,
  };
}
function inventory(): DownloadVerificationCachedRevisionInventory {
  return {
    modelId: 'fixture/lifecycle', normalizedModelId: 'fixture/lifecycle',
    revisions: [{
      revision: REVISION, kind: 'immutable-sha', totalBytes: 100, fileCount: 2,
      completionMarkerCount: 2, incompleteFileCount: 0, zeroByteFileCount: 0,
      weightFileCount: 1, lastModified: 1, status: 'committed-file-set',
    }],
  };
}

describe('MSI cache acceptance cancellation through the real orchestration chain', () => {
  it('reports post-failure cache inspection before waiting for it', async () => {
    const onProgress = vi.fn();
    const result = await completeDownloadVerificationRuntimeEvidence({
      evidence: input(), storageRoot: {} as FileSystemDirectoryHandle,
      onProgress,
      reuseRevision: async () => {
        throw new Error('Acceptance fixture failure');
      },
      inspectCachedRevisions: async () => {
        expect(onProgress).toHaveBeenLastCalledWith({ progress: {
          phase: 'cache-after', revision: REVISION, candidate: undefined, info: undefined,
        } });
        return inventory();
      },
    });
    expect(result.runtimeCompletion?.status).toBe('failed');
  });

  it('moves to the next batch model after a real acceptance deadline has disposed the previous worker', async () => {
    const controller = new AbortController();
    const pending = Promise.withResolvers<ModelLoadResult>();
    mocks.verify.mockReturnValue(pending.promise);
    mocks.dispose.mockResolvedValue(undefined);
    mocks.create.mockReturnValue({ verifyDownloadedModelRevision: mocks.verify, dispose: mocks.dispose });
    const visited: string[] = [];
    try {
      const executions = await runInvestigationTargetsSequentially({
        targets: ['fixture/lifecycle', 'fixture/next'],
        shouldInterrupt: () => false, takeSkipRequest: () => false, onUpdate: () => undefined,
        runTarget: async ({ target }) => {
          visited.push(target);
          if (target === 'fixture/lifecycle') await withCacheAcceptanceDeadline({
            controller, timeoutMs: 100,
            start: () => completeDownloadVerificationRuntimeEvidence({
              evidence: input(), signal: controller.signal, storageRoot: {} as FileSystemDirectoryHandle,
              reuseRevision: async args => await reuseDownloadedProductionRevision({ ...args, inspectCachedRevisions: async () => inventory() }),
              inspectCachedRevisions: async () => inventory(),
            }),
          });
          expect(mocks.dispose).toHaveBeenCalledOnce();
          const checkpoint = createInitialInvestigationCheckpoint({ modelId: target, runId: target, now: () => '2026-09-08T00:00:00.000Z' });
          return { ...checkpoint.run, status: 'passed', error: undefined };
        },
      });
      expect(visited).toEqual(['fixture/lifecycle', 'fixture/next']);
      expect(executions.map(item => item.status)).toEqual(['failed', 'passed']);
      expect(executions[0]?.error).toContain('cache acceptance');
    } finally {
      pending.resolve({ device: 'webgpu', dtype: 'q4' });
    }
  });
  it.each(['user', 'deadline'])('disposes the active worker after %s cancellation without trying the next candidate or forwarding late progress', async cancellation => {
    const controller = new AbortController();
    const pending = Promise.withResolvers<ModelLoadResult>();
    let lateProgress: TransformersJsProgressCallback | undefined;
    mocks.verify.mockImplementation(({ progressCallback }: { progressCallback: TransformersJsProgressCallback }) => {
      lateProgress = progressCallback;
      progressCallback({ info: { status: 'progress', file: 'model_q4f16.onnx', loaded: 10, total: 100 } });
      return pending.promise;
    });
    mocks.dispose.mockResolvedValue(undefined);
    mocks.create.mockReturnValue({
      verifyDownloadedModelCandidate: mocks.verify,
      verifyDownloadedModelRevision: mocks.verify,
      dispose: mocks.dispose,
    });
    const inspectAfter = vi.fn(async () => inventory());
    const onProgress = vi.fn();
    const outcome = withCacheAcceptanceDeadline({ controller, timeoutMs: cancellation === 'deadline' ? 100 : 10_000, start: () => completeDownloadVerificationRuntimeEvidence({
      evidence: input(), signal: controller.signal,
      onProgress,
      storageRoot: {} as FileSystemDirectoryHandle,
      reusableCandidateOrderByRevision: { [REVISION]: [{ device: 'webgpu', dtype: 'q4f16' }, { device: 'webgpu', dtype: 'q4' }] },
      // Only replace filesystem I/O. Completion, reuse, revision orchestration,
      // candidate acceptance and abort handling are the actual implementation.
      reuseRevision: async args => await reuseDownloadedProductionRevision({
        ...args, inspectCachedRevisions: async () => inventory(),
      }),
      inspectCachedRevisions: inspectAfter,
    }) }).then(value => ({ status: 'resolved' as const, value }), error => ({ status: 'rejected' as const, error }));
    const reason = new Error('User stopped this model');
    try {
      await vi.waitFor(() => expect(mocks.verify).toHaveBeenCalledTimes(1));
      if (cancellation === 'user') controller.abort(reason);
      await vi.waitFor(() => expect(mocks.dispose).toHaveBeenCalledTimes(1));
      expect(await outcome).toEqual({ status: 'rejected', error: controller.signal.reason });
      expect(onProgress.mock.calls.map(([event]) => event.progress.phase)).toEqual(['cache-inventory', 'revision-acceptance', 'candidate-acceptance', 'runtime']);
      const delivered = onProgress.mock.calls.length;
      lateProgress?.({ info: { status: 'ready' } });
      expect(onProgress).toHaveBeenCalledTimes(delivered);
      expect(mocks.verify).toHaveBeenCalledTimes(1);
      expect(inspectAfter).not.toHaveBeenCalled();
    } finally {
      // Drain the deliberately held mock even when the pre-fix assertion fails.
      pending.resolve({ device: 'webgpu', dtype: 'q4f16' });
      await outcome;
    }
  });

  it('does not create an acceptance worker when stopped during cache inventory', async () => {
    const controller = new AbortController();
    const pending = Promise.withResolvers<DownloadVerificationCachedRevisionInventory>();
    const entered = vi.fn(() => pending.promise);
    const reason = new Error('Stopped during inventory');
    const outcome = completeDownloadVerificationRuntimeEvidence({
      evidence: input(), signal: controller.signal, storageRoot: {} as FileSystemDirectoryHandle,
      reuseRevision: async args => await reuseDownloadedProductionRevision({ ...args, inspectCachedRevisions: entered }),
      inspectCachedRevisions: async () => inventory(),
    }).then(value => ({ status: 'resolved' as const, value }), error => ({ status: 'rejected' as const, error }));
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    controller.abort(reason);
    pending.resolve(inventory());
    expect(await outcome).toEqual({ status: 'rejected', error: reason });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
