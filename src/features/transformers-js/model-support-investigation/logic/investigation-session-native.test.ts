// @vitest-environment node
import { webcrypto } from 'node:crypto';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exposeWorkerRemote, releaseWorkerRemote, wrapWorkerRemote } from '@/utils/worker-transport';
import { createModelSupportInvestigationEvidenceWorker } from '@/features/transformers-js/model-support-investigation/evidence-worker/impl';
import { createModelSupportInvestigationEvidenceWorkerRequest } from '@/features/transformers-js/model-support-investigation/evidence-worker/request';
import { createModelSupportInvestigationBatchEvidenceWorkerRequest } from '@/features/transformers-js/model-support-investigation/evidence-worker/batch-request';
import type { IModelSupportInvestigationEvidenceWorker } from '@/features/transformers-js/model-support-investigation/evidence-worker/types';
import { createInitialInvestigationCheckpoint } from './investigation-recovery';
import { captureScenarioInput } from './production-provider-capture-plan';
import { createProductionProviderTrace } from './production-provider-trace';
import type { ProductionProviderCaptureSnapshot } from './production-provider-capture-owner';
import type { ProductionProviderNativeCollectionSnapshot } from './production-provider-generation-capture-owner';
import { createProductionProviderNativeEvidence, PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES } from './production-provider-native-evidence';
import { createProductionProviderCaptureEvidence, readProductionProviderCaptureEvidence } from './production-provider-capture-evidence';
import { configurationForPreset } from './investigation-config';
import { createInvestigationSessionView, recallInvestigationSession, TEST_ONLY, type InvestigationSessionSnapshot } from './investigation-session';
import { measureInvestigationProviderRetention } from './investigation-provider-retention';

// Only the model output is synthetic. Session retention, immutable sidecars,
// request codecs, Comlink, Evidence Worker and ZIP implementations are real.
async function capturedSession({ batchId, modelId }: { batchId: string; modelId: string }): Promise<Extract<InvestigationSessionSnapshot, { view: 'results' }>> {
  const runId = `${batchId}-run`;
  const checkpoint = createInitialInvestigationCheckpoint({ runId, modelId, now: () => '2026-09-10T00:00:00.000Z' });
  const context = { runId, workerEpoch: 1, requestId: `${runId}-first-turn`, generationCallId: 1 };
  const trace = createProductionProviderTrace({ requestId: context.requestId, limits: { maximumEvents: 16, maximumCharacters: 1024 } });
  trace.settle({ outcome: 'fulfilled', error: undefined });
  const provider: ProductionProviderCaptureSnapshot = {
    format: 'production-provider-capture-v2', runId, modelId, plan: 'first-only', run: { status: 'completed' },
    lifetime: 'open', abortReason: undefined, disposal: 'not-requested', observation: 'open', events: [],
    requests: [{ runId, requestId: context.requestId, scenario: 'first-turn', status: 'settled', notStartedReason: undefined,
      input: captureScenarioInput({ scenario: 'first-turn', firstSettled: undefined }), trace: trace.snapshot() }],
    capabilities: { providerCallbacks: 'bounded-projection', nativeInvocations: 'not-collected-by-this-owner', tools: 'not-selected', images: 'not-selected' },
  };
  checkpoint.run.productionProviderCapture = provider;
  const bytes = Uint8Array.of(5, 6);
  const native: ProductionProviderNativeCollectionSnapshot = {
    format: 'production-provider-native-collection-v1', runId, maximumWorkerEpochs: 8, phase: 'finished', unrecordedWorkerCreations: 0, incompleteReasons: [],
    epochs: [{ workerEpoch: 1, lifetime: { status: 'observed', value: { runId, workerEpoch: 1, session: 'active', issuedCalls: [context], loadRequests: [{ requestedModelId: modelId, requestedRevision: undefined }], incompleteReasons: [] } },
      collection: { status: 'returned', result: { status: 'captured', capture: {
        schemaVersion: 1, runId, workerEpoch: 1, byteOrder: 'little-endian',
        limits: { maxCalls: 1, maxInvocationsPerCall: 1, maxEvents: 4, maxTextBytes: 256, maxTensorBytes: 16, maxTotalTensorBytes: 16, maxTokensPerStreamEvent: 4, maxTotalStreamTokens: 8, maxTotalStreamTokenBytes: 64 },
        calls: [{ context, loadIdentity: { status: 'not-observed', reason: 'no-completed-load' }, outcome: 'fulfilled', invocations: [{ nativeInvocationOrdinal: 1, stream: { status: 'not-attempted' } }] }],
        events: [{ kind: 'sequence', identity: { ...context, nativeInvocationOrdinal: 1 }, resultShape: 'tensor', snapshot: { status: 'captured', dtype: 'uint8', dims: [2], byteLength: 2, bytes } }],
        incompleteReasons: [], unobserved: ['native-stop-cause', 'native-forward-input', 'kv-bytes'],
      } } } }],
  };
  const sidecar = await createProductionProviderNativeEvidence({ native, provider, maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES });
  bytes.fill(99);
  return {
    view: 'results', batchId, targets: [modelId], configuration: configurationForPreset({ preset: 'full' }),
    executions: [{ target: modelId, status: 'passed', run: checkpoint.run, error: undefined }],
    runs: [[modelId, checkpoint.run]], recoveries: [[modelId, checkpoint.recovery]], replayMetadata: [],
    nativeEvidence: [[modelId, sidecar]], selectedTarget: modelId,
    reservedProviderRetention: { nativeBinaryBytes: 0, nativeJsonCharacters: 0, providerJsonCharacters: 0 },
  };
}

beforeEach(() => {
  TEST_ONLY.clear();
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', vi.fn(() => {
    throw new Error('Session retention must not access the network');
  }));
  vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn(() => {
    throw new Error('Session retention must not access OPFS');
  }) } });
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  expect(navigator.storage.getDirectory).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  TEST_ONLY.clear();
});

describe('Session native evidence retention and actual Evidence Worker export', () => {
  it('reopens and re-exports the adopted prefix while retirement still owns a pending release', async () => {
    const source = await capturedSession({ batchId: 'retained', modelId: 'fixture/first' });
    const first = createInvestigationSessionView({ initialSnapshot: undefined });
    first.remember({ snapshot: source });
    const pendingRelease = Promise.withResolvers<void>();
    const retirement = first.retire({ dispose: () => pendingRelease.promise });
    const snapshot = recallInvestigationSession({ seededTarget: 'fixture/first' });
    if (snapshot?.view !== 'results') throw new Error('Missing retained results');
    const reopened = createInvestigationSessionView({ initialSnapshot: snapshot });
    expect(reopened.initialReadiness).toBe('waiting-for-teardown');
    const run = snapshot.runs[0]![1];
    const provider = run.productionProviderCapture!;
    expect(Object.hasOwn(provider, 'abortReason')).toBe(true);
    const expectedProvider = createProductionProviderCaptureEvidence({ capture: provider, runId: run.runId, modelId: run.modelId }).json;
    const nativeEvidence = snapshot.nativeEvidence[0]![1];
    expect(nativeEvidence.binaries[0]!.blob).toBeInstanceOf(Blob);
    const channel = new MessageChannel();
    exposeWorkerRemote<IModelSupportInvestigationEvidenceWorker>({ api: createModelSupportInvestigationEvidenceWorker(), endpoint: channel.port1 });
    const remote = wrapWorkerRemote<IModelSupportInvestigationEvidenceWorker>({ endpoint: channel.port2 });
    try {
      for (const retained of [snapshot, structuredClone(snapshot)]) {
        const archive = await remote.createPartialEvidence({
          request: createModelSupportInvestigationEvidenceWorkerRequest({ run: retained.runs[0]![1], recovery: retained.recoveries[0]![1] }),
          nativeEvidence: retained.nativeEvidence[0]![1],
        });
        const zip = await JSZip.loadAsync(await archive.blob.arrayBuffer());
        const readme = await zip.file('SUMMARY.md')!.async('string');
        expect(readme).toContain('Public Provider requests are recorded');
        expect(readme).not.toContain('Production Lane was not run.');
        expect(await zip.file('production-provider/capture.json')!.async('string')).toBe(expectedProvider);
        expect(await zip.file('generation-native/capture.json')!.async('string')).toBe(nativeEvidence.json);
        expect(await zip.file('generation-native/tensors/000001.bin')!.async('uint8array')).toEqual(Uint8Array.of(5, 6));
      }
      pendingRelease.resolve();
      expect(await retirement).toEqual({ status: 'complete' });
      expect(await reopened.ready).toEqual({ status: 'complete' });
    } finally {
      pendingRelease.resolve();
      await releaseWorkerRemote({ remote });
      channel.port1.close(); channel.port2.close();
    }
  });

  it('replaces the same batch reservation history and preserves independent model ordinals in batch export', async () => {
    const first = await capturedSession({ batchId: 'first', modelId: 'fixture/first' });
    const second = await capturedSession({ batchId: 'second', modelId: 'fixture/second' });
    const view = createInvestigationSessionView({ initialSnapshot: undefined });
    view.remember({ snapshot: first });
    view.remember({ snapshot: second });
    const reopenedFirst = recallInvestigationSession({ seededTarget: 'fixture/first' });
    if (reopenedFirst?.view !== 'results') throw new Error('Missing first batch');
    view.remember({ snapshot: reopenedFirst });
    const measure = (snapshot: Extract<InvestigationSessionSnapshot, { view: 'results' }>) => measureInvestigationProviderRetention({ runs: new Map(snapshot.runs), nativeEvidence: new Map(snapshot.nativeEvidence) });
    expect(measure(reopenedFirst)).toEqual(measure(first));
    expect(recallInvestigationSession({ seededTarget: 'fixture/second' })?.batchId).toBe('second');
    const items = [reopenedFirst, second].map(snapshot => ({ target: snapshot.targets[0]!, status: 'passed' as const, run: snapshot.runs[0]![1], recovery: snapshot.recoveries[0]![1], error: undefined, nativeEvidence: snapshot.nativeEvidence[0]![1] }));
    const archive = await createModelSupportInvestigationEvidenceWorker().createBatchEvidence({ request: createModelSupportInvestigationBatchEvidenceWorkerRequest({ batchId: 'combined', items }), nativeEvidence: items.map(item => item.nativeEvidence) });
    const zip = await JSZip.loadAsync(await archive.blob.arrayBuffer());
    for (const [index, item] of items.entries()) {
      const prefix = `models/${String(index + 1).padStart(3, '0')}-${item.target.replace('/', '-')}/`;
      expect(await zip.file(prefix + 'generation-native/tensors/000001.bin')!.async('uint8array')).toEqual(Uint8Array.of(5, 6));
      const restored = readProductionProviderCaptureEvidence({ json: await zip.file(prefix + 'production-provider/capture.json')!.async('string'), runId: item.run.runId, modelId: item.run.modelId });
      expect(Object.hasOwn(restored.requests[0]!.trace, 'failure')).toBe(true);
    }
  });
});
