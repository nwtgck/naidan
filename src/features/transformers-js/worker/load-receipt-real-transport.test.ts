// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createProviderReplayTestRuntime } from '@/features/transformers-js/replay-models/support/provider-replay-test-runtime';

// Actual startup, Comlink, offline common Load and tokenizer execute. Only the
// browser module/OPFS platform and heavyweight ORT construction are substituted.
// No generation is issued, including to make a Load receipt observable.
describe('ordinary Load receipt through actual Worker communication without generation', () => {
  it('retains accepted provenance at zero generation, never reloads on take, and clears it on unload', async () => {
    const modelId = 'HuggingFaceTB/SmolLM2-135M-Instruct';
    const revision = '12fd25f77366fa6b3b4b768ec3050bf629380bac';
    const runId = 'load-without-generation';
    const harness = await createProviderReplayTestRuntime({
      modelId, expectedRevision: revision, cacheRevision: revision, metadataCache: "all-fixture",
      artifacts: [{ path: 'onnx/model_q4f16.onnx', bytes: Uint8Array.of(1, 2, 3) }],
      imagePlatform: undefined,
      generate: async () => {
        throw new Error('This control must not issue native generation');
      },
    });
    const { createTransformersJsGenerationCaptureClient } = await import('./client-hosted');
    const activeRequest = vi.fn(() => undefined);
    const capture = createTransformersJsGenerationCaptureClient({
      runId, workerEpoch: 1, getActiveRequest: activeRequest,
      limits: { maxCalls: 8, maxInvocationsPerCall: 4, maxEvents: 256, maxTextBytes: 8192,
        maxTensorBytes: 8192, maxTotalTensorBytes: 65536,
        maxTokensPerStreamEvent: 4096, maxTotalStreamTokens: 16384, maxTotalStreamTokenBytes: 262144 },
    });
    try {
      expect(await capture.client.loadDownloadedModel({ modelId, revisionSelection: { kind: 'pinned', revision: revision }, progressCallback: () => undefined }))
        .toStrictEqual({ device: 'webgpu', dtype: 'q4f16' });
      const first = await capture.takeGenerationCapture();
      expect(first.status).toBe('not-started');
      if (first.status !== 'not-started') throw new Error('Generation unexpectedly started');
      expect(first.loadObservation).toMatchObject({
        format: 'production-load-observation-v1', owner: { runId, workerEpoch: 1 }, loadOrdinal: 1,
        outcome: { status: 'accepted', receipt: {
          modelId, loaderRevisionOption: { status: 'provided', value: revision },
          cacheLookup: { source: 'read-only-opfs-scoped-match', revision },
          candidate: { device: 'webgpu', dtype: 'q4f16' },
          resourceHealth: 'healthy-after-close', accessBoundary: 'production-offline-read-only',
          completion: 'model-session-and-tokenizer-processor-ready',
          limitations: { wholeFileProvenance: 'not-verified', allPlannedBodiesConsumed: 'not-certified' },
        } },
      });
      const lifetime = capture.getCaptureLifetime();
      expect(lifetime).toMatchObject({ issuedCalls: [], incompleteReasons: [] });
      // Requested selection is separate from the actual accepted receipt above.
      expect(lifetime.loadRequests).toEqual([{
        requestedModelId: modelId,
        requestedRevision: revision,
        revisionSelection: { kind: 'pinned', revision },
      }]);
      expect(await capture.takeGenerationCapture()).toEqual(first);
      expect(activeRequest).not.toHaveBeenCalled();
      expect(harness.observations.inferenceCalls).toHaveLength(0);
      expect(harness.observations.workers).toHaveLength(1);
      const worker = harness.observations.workers[0]!;
      const loadEnvelope = z.object({ type: z.literal('APPLY'), path: z.tuple([z.literal('loadDownloadedModel')]) }).passthrough();
      expect(worker.hostMessages.filter(message => loadEnvelope.safeParse(message).success)).toHaveLength(1);
      await capture.client.unloadModel();
      const cleared = await capture.takeGenerationCapture();
      expect(cleared).toMatchObject({ status: 'not-started', loadObservation: {
        owner: { runId, workerEpoch: 1 }, loadOrdinal: 1, outcome: { status: 'cleared' },
      } });
      expect(worker.hostMessages.filter(message => loadEnvelope.safeParse(message).success)).toHaveLength(1);
      await capture.client.dispose();
      expect(worker.terminated).toBe(true);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      try {
        await capture.client.dispose();
      } finally {
        await harness.close();
      }
    }
  }, 30_000);
});
