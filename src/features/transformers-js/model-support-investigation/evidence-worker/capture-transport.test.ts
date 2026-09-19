// @vitest-environment node
import { createHash, webcrypto } from 'node:crypto';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exposeWorkerRemote, releaseWorkerRemote, wrapWorkerRemote } from '@/utils/worker-transport';
import { createInitialInvestigationCheckpoint } from '@/features/transformers-js/model-support-investigation/logic/investigation-recovery';
import { captureScenarioInput } from '@/features/transformers-js/model-support-investigation/logic/production-provider-capture-plan';
import { createProductionProviderTrace } from '@/features/transformers-js/model-support-investigation/logic/production-provider-trace';
import type { ProductionProviderCaptureSnapshot } from '@/features/transformers-js/model-support-investigation/logic/production-provider-capture-owner';
import type { ProductionProviderNativeCollectionSnapshot } from '@/features/transformers-js/model-support-investigation/logic/production-provider-generation-capture-owner';
import { createProductionProviderNativeEvidence, PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES } from '@/features/transformers-js/model-support-investigation/logic/production-provider-native-evidence';
import { createProductionProviderCaptureEvidence, readProductionProviderCaptureEvidence } from '@/features/transformers-js/model-support-investigation/logic/production-provider-capture-evidence';
import { createProductionProviderCapturePolicy } from '@/features/transformers-js/model-support-investigation/logic/production-provider-capture-policy';
import { createProductionProviderInvestigationSummaryEvidence, readProductionProviderInvestigationSummaryEvidence } from '@/features/transformers-js/model-support-investigation/logic/production-provider-investigation-summary';
import type { ProductionProviderInvestigationResult } from '@/features/transformers-js/model-support-investigation/logic/run-production-provider-investigation';
import { verifyGeneratedEvidenceArchive } from '@/features/transformers-js/model-support-investigation/logic/verify-evidence-archive';
import { createModelSupportInvestigationEvidenceWorkerRequest, readModelSupportInvestigationEvidenceWorkerRequest } from './request';
import { createModelSupportInvestigationBatchEvidenceWorkerRequest, readModelSupportInvestigationBatchEvidenceWorkerRequest } from './batch-request';
import { createModelSupportInvestigationEvidenceWorker } from './impl';
import type { IModelSupportInvestigationEvidenceWorker } from './types';

// Synthetic transport controls, not model outputs or claims of a native Load.
// The actual strict encoders, Comlink structured clone, ZIP writer and independent
// ZIP reader run against in-memory Blob files; no inference or browser is needed.
function fixture({ runId }: { runId: string }) {
  const modelId = 'fixture/model';
  const checkpoint = createInitialInvestigationCheckpoint({ modelId, runId, now: () => '2026-09-10T00:00:00.000Z' });
  const context = { runId, workerEpoch: 1, requestId: `${runId}-first-turn`, generationCallId: 1 };
  const policy = createProductionProviderCapturePolicy({ plan: 'first-only' });
  const trace = createProductionProviderTrace({ requestId: context.requestId, limits: policy.traceLimits });
  trace.settle({ outcome: 'fulfilled', error: undefined });
  const provider: ProductionProviderCaptureSnapshot = {
    format: 'production-provider-capture-v2', runId, modelId, plan: 'first-only', run: { status: 'completed' },
    lifetime: 'open', abortReason: undefined, disposal: 'not-requested', observation: 'open', events: [],
    requests: [{ runId, requestId: context.requestId, scenario: 'first-turn', status: 'settled', notStartedReason: undefined,
      input: captureScenarioInput({ scenario: 'first-turn', firstSettled: undefined }), trace: trace.snapshot() }],
    capabilities: { providerCallbacks: 'bounded-projection', nativeInvocations: 'not-collected-by-this-owner', tools: 'not-selected', images: 'not-selected' },
  };
  checkpoint.run.productionProviderCapture = provider;
  const native: ProductionProviderNativeCollectionSnapshot = {
    format: 'production-provider-native-collection-v1', runId, maximumWorkerEpochs: 8, phase: 'finished', unrecordedWorkerCreations: 0, incompleteReasons: [],
    epochs: [{ workerEpoch: 1, lifetime: { status: 'observed', value: { runId, workerEpoch: 1, session: 'active', issuedCalls: [context], loadRequests: [{ requestedModelId: modelId, requestedRevision: undefined }], incompleteReasons: [] } },
      collection: { status: 'returned', result: { status: 'captured', capture: {
        schemaVersion: 1, runId, workerEpoch: 1, byteOrder: 'little-endian',
        limits: { maxCalls: 1, maxInvocationsPerCall: 1, maxEvents: 4, maxTextBytes: 256, maxTensorBytes: 16, maxTotalTensorBytes: 16, maxTokensPerStreamEvent: 4, maxTotalStreamTokens: 8, maxTotalStreamTokenBytes: 64 },
        calls: [{ context, loadIdentity: { status: 'not-observed', reason: 'no-completed-load' }, outcome: 'fulfilled', invocations: [{ nativeInvocationOrdinal: 1, stream: { status: 'not-attempted' } }] }],
        events: [{ kind: 'sequence', identity: { ...context, nativeInvocationOrdinal: 1 }, resultShape: 'tensor', snapshot: { status: 'captured', dtype: 'uint8', dims: [2], byteLength: 2, bytes: Uint8Array.of(5, 6) } }],
        incompleteReasons: [], unobserved: ['native-stop-cause', 'native-forward-input', 'kv-bytes'],
      } } } }],
  };
  const summary: ProductionProviderInvestigationResult['summary'] = {
    format: 'production-provider-investigation-v1', policy, completion: 'completed', stopReason: undefined, providerEvidence: 'available',
    providerProgress: { runId, modelId, plan: 'first-only', run: { status: 'completed' }, lifetime: 'closed', activeRequest: undefined, totalRequests: 1, selectedRequests: 1, settledRequests: 1, loadStatus: 'idle' },
    requests: [{ requestId: context.requestId, scenario: 'first-turn', status: 'settled', notStartedReason: undefined, outcome: 'fulfilled', settledCompleteness: 'complete', completeness: 'complete', limits: { ...policy.traceLimits, maximumFieldCharacters: 16384 }, retainedCharacters: 0, eventCount: 0 }],
    cutoff: { format: 'production-provider-native-cutoff-v1', runId, reason: 'normal-completion', phaseAtCutoff: 'finished', maximumWorkerEpochs: 8, unrecordedWorkerCreations: 0, incompleteReasons: [], epochs: [{ workerEpoch: 1, lifetime: { status: 'observed', session: 'active', issuedCallCount: 1, loadRequestCount: 1 }, collectionStatus: 'returned' }] },
    nativeEvidenceStatus: 'available', cleanup: 'completed', sealOwnership: 'settled', progressCallbackFailures: 0,
  };
  checkpoint.run.productionProviderInvestigation = summary;
  return { ...checkpoint, provider, native, summary };
}

// Rebuild all outer digests after a semantic mutation: a checksum failure must
// not mask the summary owner/reference contract being exercised.
async function remanifestArchive({ zip, runId }: { zip: JSZip; runId: string }): Promise<Blob> {
  const files = await Promise.all(Object.entries(zip.files).filter(([path, file]) => !file.dir && path !== 'manifest.json').map(async ([path, file]) => {
    const bytes = await file.async('uint8array');
    return { path, byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
  zip.file('manifest.json', JSON.stringify({ schemaVersion: 1, runId, generatedAt: '2026-09-10T00:00:00.000Z', files }));
  return zip.generateAsync({ type: 'blob' });
}

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', vi.fn(() => {
    throw new Error('Evidence transport must not access the network');
  }));
  vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn(() => {
    throw new Error('Evidence transport must not access OPFS');
  }) } });
});

afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(navigator.storage.getDirectory).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Provider and native Evidence Worker transport', () => {
  it('preserves Provider own undefined fields through the request Blob and strict re-export', async () => {
    const { run, recovery, provider } = fixture({ runId: 'provider-wire' });
    const expected = createProductionProviderCaptureEvidence({ capture: provider, runId: run.runId, modelId: run.modelId });
    const request = createModelSupportInvestigationEvidenceWorkerRequest({ run, recovery });
    const restored = await readModelSupportInvestigationEvidenceWorkerRequest({ request: structuredClone(request) });
    const capture = restored.run.productionProviderCapture;
    if (capture === undefined) throw new Error('Missing Provider capture');
    expect(Object.hasOwn(capture, 'abortReason')).toBe(true);
    expect(Object.hasOwn(capture.requests[0]!.trace, 'failure')).toBe(true);
    expect(Object.hasOwn(capture.requests[0]!.input!.parameters, 'presencePenalty')).toBe(true);
    expect(createProductionProviderCaptureEvidence({ capture, runId: run.runId, modelId: run.modelId }).json).toBe(expected.json);
    const summary = restored.run.productionProviderInvestigation;
    if (summary === undefined) throw new Error('Missing Provider summary');
    expect(Object.hasOwn(summary, 'stopReason')).toBe(true);
    expect(Object.hasOwn(summary.requests[0]!, 'notStartedReason')).toBe(true);
  });

  it('keeps native Blob files outside the batch JSON request', async () => {
    const { run, recovery, provider, native } = fixture({ runId: 'native-wire' });
    const nativeEvidence = await createProductionProviderNativeEvidence({ native, provider, maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES });
    const request = createModelSupportInvestigationBatchEvidenceWorkerRequest({ batchId: 'wire-batch', items: [{ target: run.modelId, status: 'passed', run, recovery, error: undefined, nativeEvidence }] });
    expect(await request.text()).not.toContain('"nativeEvidence":');
    expect(await request.text()).not.toContain('generation-native/tensors/');
    const restored = await readModelSupportInvestigationBatchEvidenceWorkerRequest({ request });
    expect(restored.items[0]).not.toHaveProperty('nativeEvidence');
    expect(restored.items[0]?.run?.productionProviderCapture).toEqual(provider);
  });

  it('exports and re-exports exact Provider JSON and native bytes through actual Comlink', async () => {
    const { run, recovery, provider, native, summary } = fixture({ runId: 'comlink-wire' });
    const nativeEvidence = await createProductionProviderNativeEvidence({ native, provider, maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES });
    const expectedProvider = createProductionProviderCaptureEvidence({ capture: provider, runId: run.runId, modelId: run.modelId }).json;
    const expectedSummary = createProductionProviderInvestigationSummaryEvidence({ summary, runId: run.runId, modelId: run.modelId }).json;
    const channel = new MessageChannel();
    exposeWorkerRemote<IModelSupportInvestigationEvidenceWorker>({ api: createModelSupportInvestigationEvidenceWorker(), endpoint: channel.port1 });
    const remote = wrapWorkerRemote<IModelSupportInvestigationEvidenceWorker>({ endpoint: channel.port2 });
    try {
      const input = { request: createModelSupportInvestigationEvidenceWorkerRequest({ run, recovery }), nativeEvidence };
      const first = await remote.createPartialEvidence(input);
      const reopened = structuredClone({ run, recovery, nativeEvidence });
      const repeatedInput = { request: createModelSupportInvestigationEvidenceWorkerRequest(reopened), nativeEvidence: reopened.nativeEvidence };
      const second = await remote.createPartialEvidence(repeatedInput);
      for (const archive of [first, second]) {
        const zip = await JSZip.loadAsync(await archive.blob.arrayBuffer());
        expect(await zip.file('production-provider/capture.json')!.async('string')).toBe(expectedProvider);
        const summaryJson = await zip.file('production-provider/summary.json')!.async('string');
        expect(summaryJson).toBe(expectedSummary);
        const restoredSummary = readProductionProviderInvestigationSummaryEvidence({ json: summaryJson, runId: run.runId, modelId: run.modelId });
        expect(Object.hasOwn(restoredSummary, 'stopReason')).toBe(true);
        expect(Object.hasOwn(restoredSummary.requests[0]!, 'notStartedReason')).toBe(true);
        expect(JSON.parse(await zip.file('run.json')!.async('string')).productionProviderInvestigation).toEqual({ format: 'production-provider-investigation-summary-reference-v1', path: 'production-provider/summary.json' });
        expect(await zip.file('generation-native/capture.json')!.async('string')).toBe(nativeEvidence.json);
        expect(await zip.file('generation-native/tensors/000001.bin')!.async('uint8array')).toEqual(Uint8Array.of(5, 6));
        const capture = readProductionProviderCaptureEvidence({ json: await zip.file('production-provider/capture.json')!.async('string'), runId: run.runId, modelId: run.modelId });
        expect(Object.hasOwn(capture.requests[0]!.input!.parameters, 'stop')).toBe(true);
      }
      expect(new Uint8Array(await nativeEvidence.binaries[0]!.blob.arrayBuffer())).toEqual(Uint8Array.of(5, 6));
    } finally {
      await releaseWorkerRemote({ remote });
      channel.port1.close();
      channel.port2.close();
    }
  });

  it('round-trips batch sidecars by run identity through Comlink and re-exports without recollection', async () => {
    const first = fixture({ runId: 'batch-first' });
    const second = fixture({ runId: 'batch-second' });
    const items = await Promise.all([first, second].map(async item => ({
      target: item.run.modelId, status: 'passed' as const, run: item.run, recovery: item.recovery, error: undefined,
      nativeEvidence: await createProductionProviderNativeEvidence({ native: item.native, provider: item.provider, maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES }),
    })));
    const channel = new MessageChannel();
    exposeWorkerRemote<IModelSupportInvestigationEvidenceWorker>({ api: createModelSupportInvestigationEvidenceWorker(), endpoint: channel.port1 });
    const remote = wrapWorkerRemote<IModelSupportInvestigationEvidenceWorker>({ endpoint: channel.port2 });
    try {
      for (const retainedItems of [items, structuredClone(items)]) {
        const archive = await remote.createBatchEvidence({
          request: createModelSupportInvestigationBatchEvidenceWorkerRequest({ batchId: 'paired-batch', items: retainedItems }),
          nativeEvidence: retainedItems.map(item => item.nativeEvidence),
        });
        const zip = await JSZip.loadAsync(await archive.blob.arrayBuffer());
        for (const [index, item] of retainedItems.entries()) {
          const prefix = `models/${String(index + 1).padStart(3, '0')}-fixture-model/`;
          expect(await zip.file(prefix + 'generation-native/capture.json')!.async('string')).toBe(item.nativeEvidence.json);
          expect(await zip.file(prefix + 'generation-native/tensors/000001.bin')!.async('uint8array')).toEqual(Uint8Array.of(5, 6));
          const capture = readProductionProviderCaptureEvidence({ json: await zip.file(prefix + 'production-provider/capture.json')!.async('string'), runId: item.run.runId, modelId: item.run.modelId });
          expect(Object.hasOwn(capture.requests[0]!.trace, 'failure')).toBe(true);
          const summary = readProductionProviderInvestigationSummaryEvidence({ json: await zip.file(prefix + 'production-provider/summary.json')!.async('string'), runId: item.run.runId, modelId: item.run.modelId });
          expect(Object.hasOwn(summary.providerProgress, 'activeRequest')).toBe(true);
        }
      }
    } finally {
      await releaseWorkerRemote({ remote });
      channel.port1.close();
      channel.port2.close();
    }
  });

  it('preserves a summary-only ZIP when Provider evidence was refused', async () => {
    const { run, recovery, summary } = fixture({ runId: 'summary-only' });
    run.productionProviderCapture = undefined;
    run.productionProviderInvestigation = { ...summary, providerEvidence: 'refused', nativeEvidenceStatus: 'provider-evidence-refused' };
    const worker = createModelSupportInvestigationEvidenceWorker();
    const archive = await worker.createPartialEvidence({ request: createModelSupportInvestigationEvidenceWorkerRequest({ run, recovery }) });
    const zip = await JSZip.loadAsync(await archive.blob.arrayBuffer());
    expect(zip.file('production-provider/capture.json')).toBeNull();
    expect(zip.file('generation-native/capture.json')).toBeNull();
    const saved = readProductionProviderInvestigationSummaryEvidence({ json: await zip.file('production-provider/summary.json')!.async('string'), runId: run.runId, modelId: run.modelId });
    expect(saved.providerEvidence).toBe('refused');
    expect(Object.hasOwn(saved.requests[0]!, 'notStartedReason')).toBe(true);
  });

  it('rejects a raw Provider object injected into ordinary request JSON', async () => {
    const { run, provider } = fixture({ runId: 'raw-provider' });
    const request = new Blob([JSON.stringify({ schemaVersion: 2, run: { runId: run.runId, modelId: run.modelId, productionProviderCapture: provider } })]);
    await expect(readModelSupportInvestigationEvidenceWorkerRequest({ request })).rejects.toThrow('Raw Provider capture is not allowed');
  });

  it('rejects an unowned summary document with valid outer hashes', async () => {
    const { run, recovery } = fixture({ runId: 'unowned-summary' });
    const archive = await createModelSupportInvestigationEvidenceWorker().createPartialEvidence({ request: createModelSupportInvestigationEvidenceWorkerRequest({ run, recovery }) });
    const zip = await JSZip.loadAsync(await archive.blob.arrayBuffer());
    const savedRun = JSON.parse(await zip.file('run.json')!.async('string'));
    delete savedRun.productionProviderInvestigation;
    zip.file('run.json', JSON.stringify(savedRun));
    await expect(verifyGeneratedEvidenceArchive({ blob: await remanifestArchive({ zip, runId: run.runId }) })).rejects.toThrow('missing its Production investigation summary owner');
  });

  it('rejects a dangling summary reference with valid outer hashes', async () => {
    const { run, recovery } = fixture({ runId: 'missing-summary' });
    const archive = await createModelSupportInvestigationEvidenceWorker().createPartialEvidence({ request: createModelSupportInvestigationEvidenceWorkerRequest({ run, recovery }) });
    const zip = await JSZip.loadAsync(await archive.blob.arrayBuffer());
    zip.remove('production-provider/summary.json');
    await expect(verifyGeneratedEvidenceArchive({ blob: await remanifestArchive({ zip, runId: run.runId }) })).rejects.toThrow('missing its Production investigation summary owner');
  });

  it('rejects a foreign summary document with valid outer hashes', async () => {
    const { run, recovery } = fixture({ runId: 'summary-owner' });
    const foreign = fixture({ runId: 'summary-foreign' });
    const archive = await createModelSupportInvestigationEvidenceWorker().createPartialEvidence({ request: createModelSupportInvestigationEvidenceWorkerRequest({ run, recovery }) });
    const zip = await JSZip.loadAsync(await archive.blob.arrayBuffer());
    zip.file('production-provider/summary.json', createProductionProviderInvestigationSummaryEvidence({ summary: foreign.summary, runId: foreign.run.runId, modelId: foreign.run.modelId }).json);
    await expect(verifyGeneratedEvidenceArchive({ blob: await remanifestArchive({ zip, runId: run.runId }) })).rejects.toThrow('Invalid Production Provider investigation summary');
  });

  it('rejects a raw summary injected into ordinary request JSON', async () => {
    const { run, summary } = fixture({ runId: 'raw-summary' });
    const request = new Blob([JSON.stringify({ schemaVersion: 2, run: { runId: run.runId, modelId: run.modelId, productionProviderInvestigation: summary } })]);
    await expect(readModelSupportInvestigationEvidenceWorkerRequest({ request })).rejects.toThrow('Raw Provider capture is not allowed');
  });

  it('rejects dedicated summary evidence belonging to another run', async () => {
    const { run, summary } = fixture({ runId: 'wire-summary-owner' });
    const providerInvestigationEvidence = createProductionProviderInvestigationSummaryEvidence({ summary, runId: run.runId, modelId: run.modelId }).json;
    const request = new Blob([JSON.stringify({ schemaVersion: 2, run: { runId: 'other-run', modelId: run.modelId }, providerInvestigationEvidence })]);
    await expect(readModelSupportInvestigationEvidenceWorkerRequest({ request })).rejects.toThrow('Invalid Production Provider investigation summary');
  });

  it('rejects Provider evidence belonging to another run', async () => {
    const { run, provider } = fixture({ runId: 'foreign-provider' });
    const providerCaptureEvidence = createProductionProviderCaptureEvidence({ capture: provider, runId: run.runId, modelId: run.modelId }).json;
    const request = new Blob([JSON.stringify({ schemaVersion: 2, run: { runId: 'other-run', modelId: run.modelId }, providerCaptureEvidence })]);
    await expect(readModelSupportInvestigationEvidenceWorkerRequest({ request })).rejects.toThrow('Invalid Production Provider capture evidence');
  });

  it('rejects an accessor at the host-only capture boundary without evaluating it', () => {
    const { run, recovery } = fixture({ runId: 'accessor-provider' });
    const getter = vi.fn(() => {
      throw new Error('Untrusted capture accessor');
    });
    Object.defineProperty(run, 'productionProviderCapture', { get: getter });
    expect(() => createModelSupportInvestigationEvidenceWorkerRequest({ run, recovery })).toThrow('Invalid Provider capture in Evidence request');
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects a native sidecar array with the wrong target count', async () => {
    const { run, recovery } = fixture({ runId: 'missing-sidecar-slot' });
    const request = createModelSupportInvestigationBatchEvidenceWorkerRequest({ batchId: 'wrong-count', items: [{ target: run.modelId, status: 'passed', run, recovery, error: undefined }] });
    await expect(createModelSupportInvestigationEvidenceWorker().createBatchEvidence({ request, nativeEvidence: [] })).rejects.toThrow('Native sidecar target count mismatch');
  });

  it('rejects a native sidecar assigned to another run before creating a ZIP', async () => {
    const original = fixture({ runId: 'native-owner' });
    const other = fixture({ runId: 'other-native-owner' });
    const nativeEvidence = await createProductionProviderNativeEvidence({ native: original.native, provider: original.provider, maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES });
    const request = createModelSupportInvestigationEvidenceWorkerRequest({ run: other.run, recovery: other.recovery });
    await expect(createModelSupportInvestigationEvidenceWorker().createPartialEvidence({ request, nativeEvidence })).rejects.toThrow('Invalid native capture evidence');
  });
});
