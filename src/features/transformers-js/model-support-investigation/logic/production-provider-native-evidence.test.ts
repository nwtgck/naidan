// @vitest-environment node
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerationCaptureReadResult } from '@/features/transformers-js/worker/generation-capture-protocol';
import type { ProductionProviderNativeCollectionSnapshot } from './production-provider-generation-capture-owner';
import type { ProductionProviderCaptureSnapshot } from './production-provider-capture-owner';
import { createProductionProviderNativeEvidence, verifyProductionProviderNativeEvidence, measureProductionProviderNativeEvidenceSidecar, verifyProductionProviderNativeEvidenceSidecar, readProductionProviderLoadObservations, PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES, TEST_ONLY } from './production-provider-native-evidence';
import type { ProductionLoadObservation } from '@/features/transformers-js/worker/load-receipt';
import { providerLoadRuntimeCompletion } from './provider-load-runtime-completion';
import { createProductionProviderCapturePolicy } from './production-provider-capture-policy';
import type { ProductionProviderInvestigationResult } from './run-production-provider-investigation';

type Native = Extract<GenerationCaptureReadResult, { status: 'captured' }>['capture'];
const context = { runId: 'native-export', workerEpoch: 1, requestId: 'native-export-first-turn', generationCallId: 1 };
const identity = { ...context, nativeInvocationOrdinal: 1 };

function providerFixture(): ProductionProviderCaptureSnapshot {
  return {
    format: 'production-provider-capture-v2', runId: context.runId, modelId: 'fixture/model', plan: 'first-only', run: { status: 'completed' }, lifetime: 'open', abortReason: undefined, disposal: 'not-requested', observation: 'open', events: [{ sequence: 0, kind: 'run-started', activeRequestId: undefined }],
    requests: [{ runId: context.runId, requestId: context.requestId, scenario: 'first-turn', status: 'settled', notStartedReason: undefined,
      input: { messages: [{ role: 'user', content: 'Template probe user message.' }], parameters: { temperature: 0, topP: 1, maxCompletionTokens: 16, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } }, tools: [] },
      trace: {
        format: 'production-provider-trace-v2', requestId: context.requestId,
        limits: { maximumEvents: 20, maximumCharacters: 1024, maximumFieldCharacters: 16384 },
        completeness: 'complete', failure: undefined, events: [], lateEvents: [], retainedCharacters: 0,
        settled: { sequence: 0, outcome: { status: 'fulfilled' }, events: [], completeness: 'complete', failure: undefined },
      },
    }], capabilities: { providerCallbacks: 'bounded-projection', nativeInvocations: 'not-collected-by-this-owner', tools: 'not-selected', images: 'not-selected' },
  };
}
function nativeFixture(): Native {
  return {
    schemaVersion: 1, runId: context.runId, workerEpoch: 1, byteOrder: 'little-endian',
    limits: { maxCalls: 32, maxInvocationsPerCall: 8, maxEvents: 4096, maxTextBytes: 262144, maxTensorBytes: 16777216, maxTotalTensorBytes: 67108864, maxTokensPerStreamEvent: 65536, maxTotalStreamTokens: 262144, maxTotalStreamTokenBytes: 8388608 },
    calls: [{ context, loadIdentity: { status: 'not-observed', reason: 'no-completed-load' }, outcome: 'fulfilled', invocations: [{ nativeInvocationOrdinal: 1, stream: { status: 'available', restoration: 'restored' } }] }],
    events: [
      { kind: 'native-call', identity, phase: 'entering' },
      { kind: 'inputs', identity, phase: 'native-kwargs', values: [{ name: 'input_ids', snapshot: { status: 'captured', dtype: 'uint8', dims: [2], byteLength: 2, bytes: Uint8Array.of(5, 6) } }] },
      { kind: 'native-stream', identity, operation: 'put', phase: 'entering', streamCallOrdinal: 1, detail: { kind: 'tokens', tokenType: 'bigint', groups: [['9007199254740993', '4']] } },
      { kind: 'native-stream', identity, operation: 'put', phase: 'returned', streamCallOrdinal: 1, detail: { kind: 'none' } },
      { kind: 'sequence', identity, resultShape: 'tensor', snapshot: { status: 'captured', dtype: 'uint8', dims: [0], byteLength: 0, bytes: new Uint8Array(0) } },
      { kind: 'native-call', identity, phase: 'fulfilled' },
    ], incompleteReasons: [], unobserved: ['native-stop-cause', 'native-forward-input', 'kv-bytes'],
  };
}
function collectionFixture({ capture }: { capture: Native }): ProductionProviderNativeCollectionSnapshot {
  return { format: 'production-provider-native-collection-v1', runId: context.runId, maximumWorkerEpochs: 8, phase: 'finished', unrecordedWorkerCreations: 0, incompleteReasons: [], epochs: [{ workerEpoch: 1,
    lifetime: { status: 'observed', value: { runId: context.runId, workerEpoch: 1, session: 'active', issuedCalls: [context], loadRequests: [{ requestedModelId: 'fixture/model', requestedRevision: undefined }], incompleteReasons: [] } },
    collection: { status: 'returned', result: { status: 'captured', capture } },
  }] };
}
function completedSummary(): ProductionProviderInvestigationResult['summary'] {
  return {
    format: 'production-provider-investigation-v1', policy: createProductionProviderCapturePolicy({ plan: 'first-only' }),
    completion: 'completed', stopReason: undefined, providerEvidence: 'available',
    providerProgress: { runId: context.runId, modelId: 'fixture/model', plan: 'first-only', run: { status: 'completed' }, lifetime: 'closed', activeRequest: undefined,
      totalRequests: 1, selectedRequests: 1, settledRequests: 1, loadStatus: 'ready' },
    requests: [{ requestId: context.requestId, scenario: 'first-turn', status: 'settled', notStartedReason: undefined, outcome: 'fulfilled',
      settledCompleteness: 'complete', completeness: 'complete', limits: { maximumEvents: 1024, maximumCharacters: 65536, maximumFieldCharacters: 16384 }, retainedCharacters: 0, eventCount: 0 }],
    cutoff: { format: 'production-provider-native-cutoff-v1', runId: context.runId, reason: 'normal-completion', phaseAtCutoff: 'finished', maximumWorkerEpochs: 8,
      unrecordedWorkerCreations: 0, incompleteReasons: [], epochs: [{ workerEpoch: 1,
        lifetime: { status: 'observed', session: 'active', issuedCallCount: 1, loadRequestCount: 1 }, collectionStatus: 'returned' }] },
    nativeEvidenceStatus: 'available', cleanup: 'completed', sealOwnership: 'settled', progressCallbackFailures: 0,
  };
}
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', vi.fn(() => {
    throw new Error('Network forbidden in native exporter tests');
  }));
  vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn(() => {
    throw new Error('Storage forbidden in native exporter tests');
  }) } });
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(navigator.storage.getDirectory).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('native capture post-run export', () => {
  it.each(['captured', 'not-started'] as const)('round-trips an independently owned Load receipt with native status %s', async status => {
    const baseline = collectionFixture({ capture: nativeFixture() });
    const loadObservation: ProductionLoadObservation = {
      format: 'production-load-observation-v1', owner: { runId: context.runId, workerEpoch: 1 }, loadOrdinal: 1,
      outcome: { status: 'accepted', receipt: {
        format: 'production-offline-load-receipt-v1', modelId: 'fixture/model', loaderRevisionOption: { status: 'omitted' },
        autoClass: 'AutoModelForCausalLM', processor: 'tokenizer', candidate: { device: 'wasm', dtype: 'q4' },
        plannedRequiredPaths: ['config.json', 'onnx/model_q4.onnx'],
        cacheLookup: { source: 'read-only-opfs-scoped-match', revision: 'main', hitPaths: ['config.json', 'onnx/model_q4.onnx'] },
        completion: 'model-session-and-tokenizer-processor-ready', resourceHealth: 'healthy-after-close', accessBoundary: 'production-offline-read-only',
        limitations: { wholeFileProvenance: 'not-verified', allPlannedBodiesConsumed: 'not-certified' },
      } },
    };
    const native: ProductionProviderNativeCollectionSnapshot = { ...baseline, epochs: baseline.epochs.map(epoch => ({ ...epoch,
      collection: { status: 'returned', result: status === 'captured'
        ? { status, capture: nativeFixture(), loadObservation } : { status, loadObservation } },
    })) };
    const provider = providerFixture();
    const sidecar = await createProductionProviderNativeEvidence({ native, provider, maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES });
    expect(readProductionProviderLoadObservations({ json: sidecar.json, provider })).toEqual([loadObservation]);
    await expect(verifyProductionProviderNativeEvidenceSidecar({ evidence: sidecar, provider, maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES })).resolves.toEqual(sidecar);
    const summary = completedSummary();
    const current = { repositoryResolvedRevision: 'a'.repeat(40), provider, summary, nativeJson: sidecar.json };
    expect(providerLoadRuntimeCompletion(current)?.status).toBe('accepted');
    const unrecorded = { ...summary, cutoff: { ...summary.cutoff, unrecordedWorkerCreations: 1, incompleteReasons: ['epoch-limit'] as ['epoch-limit'] } };
    expect(providerLoadRuntimeCompletion({ ...current, summary: unrecorded })?.status).toBe('exhausted');
    const inactive = JSON.parse(sidecar.json);
    inactive.epochs[0].lifetime.value.session = 'inactive';
    await expect(verifyProductionProviderNativeEvidenceSidecar({ evidence: { ...sidecar, json: JSON.stringify(inactive) }, provider, maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES })).rejects.toThrow();
    const encoded = JSON.parse(sidecar.json);
    encoded.epochs[0].collection.result.loadObservation.owner.runId = 'foreign-owner';
    await expect(verifyProductionProviderNativeEvidenceSidecar({ evidence: { ...sidecar, json: JSON.stringify(encoded) }, provider, maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES })).rejects.toThrow();
  });

  it('bounds the actual pretty-JSON metadata increment and retains metadata-limit as partial evidence', async () => {
    const capture = nativeFixture();
    const baseline = await createProductionProviderNativeEvidence({ native: collectionFixture({ capture }), provider: providerFixture(), maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES });
    const input = capture.events.find(event => event.kind === 'inputs');
    if (input?.kind !== 'inputs') throw new Error('Expected inputs');
    input.values.push({ name: 'reshaped_input_sizes', snapshot: { status: 'image-sizes', values: Array.from({ length: 8 }, () => [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]) } });
    const sidecar = await createProductionProviderNativeEvidence({ native: collectionFixture({ capture }), provider: providerFixture(), maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES });
    const extraBytes = new TextEncoder().encode(sidecar.json).byteLength - new TextEncoder().encode(baseline.json).byteLength;
    expect(extraBytes).toBeGreaterThan(512);
    expect(extraBytes).toBeLessThanOrEqual(2048);
    input.values.at(-1)!.snapshot = { status: 'not-recorded', reason: 'metadata-limit' };
    capture.incompleteReasons = ['metadata-limit', 'unrecorded-value'];
    const partial = await createProductionProviderNativeEvidence({ native: collectionFixture({ capture }), provider: providerFixture(), maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES });
    expect(partial.summary).toMatchObject({ recording: 'partial', refusedEpochCount: 0, capturedCallCount: 1, unrecordedValueCount: 1 });
  });

  it.each([
    { name: 'original_sizes', snapshot: { status: 'image-sizes', values: [[0, 1]] } },
    { name: 'original_sizes', snapshot: { status: 'image-sizes', values: [[1, 2, 3]] } },
    { name: 'original_sizes', snapshot: { status: 'image-sizes', values: [[1, Number.MAX_SAFE_INTEGER + 1]] } },
    { name: 'original_sizes', snapshot: { status: 'matrix', values: [[1, 2]] } },
    { name: 'input_ids', snapshot: { status: 'image-sizes', values: [[1, 2]] } },
    { name: 'private_metadata', snapshot: { status: 'image-sizes', values: [[1, 2]] } },
  ])('rejects forged encoded image metadata $name $snapshot', async field => {
    const capture = nativeFixture();
    const input = capture.events.find(event => event.kind === 'inputs');
    if (input?.kind !== 'inputs') throw new Error('Expected inputs');
    input.values.push({ name: 'original_sizes', snapshot: { status: 'image-sizes', values: [[1, 2]] } });
    const sidecar = await createProductionProviderNativeEvidence({ native: collectionFixture({ capture }), provider: providerFixture(), maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES });
    // Modify only the input value in the independently decoded wire document.
    const encoded = JSON.parse(sidecar.json) as { epochs: Array<{ collection: { result: { capture: { events: Array<{ kind: string; values?: unknown[] }> } } } }> };
    const event = encoded.epochs[0]!.collection.result.capture.events.find(event => event.kind === 'inputs');
    if (!event?.values) throw new Error('Missing encoded inputs');
    event.values[event.values.length - 1] = field;
    await expect(verifyProductionProviderNativeEvidenceSidecar({ evidence: { ...sidecar, json: JSON.stringify(encoded) }, provider: providerFixture(), maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES })).rejects.toThrow();
  });
  it('exports validated image size metadata without refusing its whole epoch', async () => {
    const capture = nativeFixture();
    const input = capture.events.find(event => event.kind === 'inputs');
    if (input?.kind !== 'inputs') throw new Error('Missing input fixture');
    // Untrusted protocol input deliberately enters through the export validator.
    input.values.push({ name: 'original_sizes', snapshot: { status: 'not-recorded', reason: 'excluded-field' } });
    Reflect.set(input.values.at(-1)!, 'snapshot', { status: 'image-sizes', values: [[1, 1], [2, 3]] });
    const sidecar = await createProductionProviderNativeEvidence({ native: collectionFixture({ capture }), provider: providerFixture(), maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES });
    expect(sidecar.summary.refusedEpochCount).toBe(0);
    expect(sidecar.summary.capturedCallCount).toBe(1);
    expect(sidecar.summary.unrecordedValueCount).toBe(0);
    expect(JSON.stringify(JSON.parse(sidecar.json))).toContain('"status":"image-sizes","values":[[1,1],[2,3]]');
    await expect(verifyProductionProviderNativeEvidenceSidecar({ evidence: structuredClone(sidecar), provider: providerFixture(), maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES })).resolves.toEqual(sidecar);
  });
  it('classifies entered native records with missing Load and invocation settings as partial', async () => {
    const sidecar = await createProductionProviderNativeEvidence({ native: collectionFixture({ capture: nativeFixture() }), provider: providerFixture(), maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES });
    expect(sidecar.summary).toEqual({
      phase: 'finished', refusedEpochCount: 0, recording: 'partial', capturedCallCount: 1, enteredNativeInvocationCount: 1,
      issuedNotObservedCallCount: 0, unavailableEpochCount: 0, incompleteEpochCount: 0,
      unobservedLoadCount: 1, incompleteInvocationCount: 1, unrecordedValueCount: 0,
    });
    expect(Object.isFrozen(sidecar.summary)).toBe(true);
    const verified = await verifyProductionProviderNativeEvidenceSidecar({ evidence: structuredClone(sidecar), provider: providerFixture(), maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES });
    expect(verified.summary).toEqual(sidecar.summary);
  });

  it('does not interpret a returned not-started RPC as a native recording', async () => {
    const native = collectionFixture({ capture: nativeFixture() });
    const sidecar = await createProductionProviderNativeEvidence({ native: { ...native, epochs: [{ ...native.epochs[0]!, collection: { status: 'returned', result: { status: 'not-started' } } }] }, provider: providerFixture(), maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES });
    expect(sidecar.summary).toEqual({
      phase: 'finished', refusedEpochCount: 0, recording: 'not-recorded', capturedCallCount: 0, enteredNativeInvocationCount: 0,
      issuedNotObservedCallCount: 1, unavailableEpochCount: 1, incompleteEpochCount: 0,
      unobservedLoadCount: 0, incompleteInvocationCount: 0, unrecordedValueCount: 0,
    });
    expect(sidecar.binaries).toEqual([]);
  });

  it('keeps call records without native entry distinct from a native invocation', async () => {
    const capture = nativeFixture();
    capture.events = [];
    const sidecar = await createProductionProviderNativeEvidence({ native: collectionFixture({ capture }), provider: providerFixture(), maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES });
    expect(sidecar.summary.recording).toBe('not-recorded');
    expect(sidecar.summary.capturedCallCount).toBe(1);
    expect(sidecar.summary.enteredNativeInvocationCount).toBe(0);
    expect(sidecar.summary.incompleteInvocationCount).toBe(1);
  });

  it('records bounded capture loss and missing tensor snapshots without dropping the sidecar', async () => {
    const capture = nativeFixture();
    capture.incompleteReasons = ['tensor-limit'];
    const input = capture.events.find(event => event.kind === 'inputs');
    if (input?.kind !== 'inputs') throw new Error('Missing fixture input');
    input.values[0]!.snapshot = { status: 'not-recorded', reason: 'tensor-limit' };
    const sidecar = await createProductionProviderNativeEvidence({ native: collectionFixture({ capture }), provider: providerFixture(), maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES });
    expect(sidecar.summary.recording).toBe('partial');
    expect(sidecar.summary.incompleteEpochCount).toBe(1);
    expect(sidecar.summary.unrecordedValueCount).toBe(1);
    await expect(verifyProductionProviderNativeEvidenceSidecar({ evidence: sidecar, provider: providerFixture(), maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES })).resolves.toEqual(sidecar);
  });

  it('rejects a forged recording classification after validating the native document', async () => {
    const sidecar = await createProductionProviderNativeEvidence({ native: collectionFixture({ capture: nativeFixture() }), provider: providerFixture(), maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES });
    await expect(verifyProductionProviderNativeEvidenceSidecar({ evidence: { ...sidecar, summary: { ...sidecar.summary, recording: 'recorded', incompleteInvocationCount: 0, unobservedLoadCount: 0 } }, provider: providerFixture(), maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES })).rejects.toThrow('Invalid native capture evidence');
  });

  it('measures sidecar sizes without Blob reads and validates cloned Blob data through intrinsic methods', async () => {
    const provider = providerFixture();
    const sidecar = await createProductionProviderNativeEvidence({ native: collectionFixture({ capture: nativeFixture() }), provider, maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES });
    const cloned = structuredClone(sidecar);
    const getter = vi.fn(() => {
      throw new Error('Attached Blob properties are not evidence');
    });
    Object.defineProperty(cloned.binaries[0]!.blob, 'arrayBuffer', { get: getter });
    Object.defineProperty(cloned.binaries[0]!.blob, 'privateValue', { get: getter });
    const read = vi.spyOn(Blob.prototype, 'arrayBuffer');
    const digest = vi.spyOn(crypto.subtle, 'digest');
    expect(measureProductionProviderNativeEvidenceSidecar({ evidence: cloned })).toEqual({ binaryBytes: 2, jsonCharacters: sidecar.json.length });
    expect(read).not.toHaveBeenCalled();
    expect(digest).not.toHaveBeenCalled();
    const verified = await verifyProductionProviderNativeEvidenceSidecar({ evidence: cloned, provider, maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES });
    expect(verified.json).toBe(sidecar.json);
    expect(getter).not.toHaveBeenCalled();
    expect(Object.hasOwn(verified.binaries[0]!.blob, 'privateValue')).toBe(false);
    expect(new Uint8Array(await verified.binaries[0]!.blob.arrayBuffer())).toEqual(Uint8Array.of(5, 6));
  });

  it('rejects sidecar extra fields, accessors and forged summary before Blob reads', async () => {
    const provider = providerFixture();
    const sidecar = await createProductionProviderNativeEvidence({ native: collectionFixture({ capture: nativeFixture() }), provider, maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES });
    const read = vi.spyOn(Blob.prototype, 'arrayBuffer');
    const extra = { ...sidecar, privateValue: '/private/not-evidence' };
    await expect(verifyProductionProviderNativeEvidenceSidecar({ evidence: extra, provider, maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES })).rejects.toThrow(/^Invalid native capture evidence$/u);
    const getter = vi.fn(() => {
      throw new Error('Must not execute evidence getters');
    });
    const accessor = Object.defineProperty({ ...sidecar }, 'json', { get: getter });
    expect(() => measureProductionProviderNativeEvidenceSidecar({ evidence: accessor })).toThrow(/^Invalid native capture evidence$/u);
    await expect(verifyProductionProviderNativeEvidenceSidecar({ evidence: { ...sidecar, summary: { ...sidecar.summary, refusedEpochCount: 1 } }, provider, maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES })).rejects.toThrow(/^Invalid native capture evidence$/u);
    expect(getter).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects a Blob-prototype forgery without invoking its own size getter', async () => {
    const provider = providerFixture();
    const sidecar = await createProductionProviderNativeEvidence({ native: collectionFixture({ capture: nativeFixture() }), provider, maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES });
    const getter = vi.fn(() => 2);
    const fake = Object.defineProperty(Object.create(Blob.prototype), 'size', { get: getter });
    expect(() => measureProductionProviderNativeEvidenceSidecar({ evidence: { ...sidecar, binaries: [{ ...sidecar.binaries[0]!, blob: fake }] } })).toThrow(/^Invalid native capture evidence$/u);
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects size, hash, missing and extra binary entries instead of trusting sidecar labels', async () => {
    const provider = providerFixture();
    const sidecar = await createProductionProviderNativeEvidence({ native: collectionFixture({ capture: nativeFixture() }), provider, maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES });
    const first = sidecar.binaries[0]!;
    expect(() => measureProductionProviderNativeEvidenceSidecar({ evidence: { ...sidecar, binaries: [{ ...first, byteLength: 1 }] } })).toThrow(/^Invalid native capture evidence$/u);
    await expect(verifyProductionProviderNativeEvidenceSidecar({ evidence: { ...sidecar, binaries: [{ ...first, blob: new Blob([Uint8Array.of(7, 8)]) }, sidecar.binaries[1]!] }, provider, maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES })).rejects.toThrow(/^Invalid native capture evidence$/u);
    await expect(verifyProductionProviderNativeEvidenceSidecar({ evidence: { ...sidecar, binaries: [] }, provider, maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES })).rejects.toThrow(/^Invalid native capture evidence$/u);
    await expect(verifyProductionProviderNativeEvidenceSidecar({ evidence: { ...sidecar, binaries: [...sidecar.binaries, { ...sidecar.binaries[1]!, path: 'generation-native/tensors/000003.bin' }] }, provider, maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES })).rejects.toThrow(/^Invalid native capture evidence$/u);
  });

  it('retains only immutable Blob binaries across structured cloning and source tensor mutation', async () => {
    const capture = nativeFixture();
    const event = capture.events[1];
    if (event?.kind !== 'inputs' || event.values[0]?.snapshot.status !== 'captured') throw new Error('Expected test tensor');
    const source = event.values[0].snapshot.bytes;
    const sidecar = await createProductionProviderNativeEvidence({ native: collectionFixture({ capture }), provider: providerFixture(), maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES });
    expect(sidecar.binaries[0]!.blob).toBeInstanceOf(Blob);
    expect(Object.hasOwn(sidecar.binaries[0]!, 'bytes')).toBe(false);
    expect(Object.isFrozen(sidecar)).toBe(true);
    expect(Object.isFrozen(sidecar.binaries)).toBe(true);
    source.fill(9);
    const cloned = structuredClone(sidecar);
    expect(cloned.binaries[0]!.blob).toBeInstanceOf(Blob);
    expect(new Uint8Array(await cloned.binaries[0]!.blob.arrayBuffer())).toEqual(Uint8Array.of(5, 6));
    expect(cloned.json).toBe(sidecar.json);
  });

  it('hands hashing an owned plan with no source object or backing-buffer references', () => {
    const provider = providerFixture();
    const native = collectionFixture({ capture: nativeFixture() });
    const digest = vi.spyOn(crypto.subtle, 'digest');
    const prepared = TEST_ONLY.prepareNativeEvidence({ native, provider, maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES });
    expect(digest).not.toHaveBeenCalled();
    // Inspect the data graph actually passed to the asynchronous sealer, not
    // heap/GC timing. Shared immutable strings are intentionally unrestricted.
    function collectObjects({ value, objects }: { value: unknown; objects: Set<object> }): void {
      if (typeof value !== 'object' || value === null || objects.has(value)) return;
      objects.add(value);
      if (ArrayBuffer.isView(value)) {
        objects.add(value.buffer);
      } else if (value instanceof Map) {
        for (const [key, entry] of value) {
          collectObjects({ value: key, objects });
          collectObjects({ value: entry, objects });
        }
      } else {
        for (const entry of Object.values(value)) collectObjects({ value: entry, objects });
      }
    }
    const sources = new Set<object>();
    collectObjects({ value: provider, objects: sources });
    collectObjects({ value: native, objects: sources });
    const owned = new Set<object>();
    collectObjects({ value: prepared, objects: owned });
    expect([...owned].filter(value => sources.has(value))).toEqual([]);
    expect(prepared.binaries.map(binary => Array.from(binary.bytes))).toEqual([[5, 6], []]);
  });

  it('rejects an exhausted enclosing byte budget before copying or hashing any tensor', async () => {
    const provider = providerFixture();
    const native = collectionFixture({ capture: nativeFixture() });
    const copy = vi.spyOn(Uint8Array.prototype, 'slice');
    const hash = vi.spyOn(crypto.subtle, 'digest');
    await expect(createProductionProviderNativeEvidence({ native, provider, maximumBinaryBytes: 1 })).rejects.toThrow(/^Invalid native capture evidence$/u);
    expect(copy).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
  });

  it('rejects conflicting successful Load identities for one epoch ordinal during export', async () => {
    const capture = nativeFixture();
    const load: Native['calls'][number]['loadIdentity'] = { status: 'ready', workerLoadOrdinal: 1, requestedModelId: 'fixture/model', cleanModelId: 'fixture/model', requestedRevision: { status: 'provided', value: 'revision-a' }, autoClass: 'AutoModelForCausalLM', processor: 'tokenizer', selectedCandidate: { device: 'webgpu', dtype: 'q4f16' }, resolvedRevision: { status: 'not-observed' }, sessionExecutionProvider: { status: 'not-observed' } };
    capture.calls[0]!.loadIdentity = load;
    const secondContext = { ...context, generationCallId: 2 };
    capture.calls.push({ context: secondContext, loadIdentity: { ...load, requestedRevision: { status: 'provided', value: 'revision-b' } }, outcome: 'fulfilled', invocations: [] });
    const native = collectionFixture({ capture });
    const lifetime = native.epochs[0]!.lifetime;
    if (lifetime.status !== 'observed') throw new Error('Expected test lifetime');
    const withIssued = { ...native, epochs: [{ ...native.epochs[0]!, lifetime: { ...lifetime, value: { ...lifetime.value, issuedCalls: [context, secondContext] } } }] };
    await expect(createProductionProviderNativeEvidence({ maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES, native: withIssued, provider: providerFixture() })).rejects.toThrow(/^Invalid native capture evidence$/u);
  });

  it('accepts identical Load identities and rejects a forged candidate for the same ordinal when reading', async () => {
    const provider = providerFixture();
    const capture = nativeFixture();
    const load: Native['calls'][number]['loadIdentity'] = { status: 'ready', workerLoadOrdinal: 1, requestedModelId: 'fixture/model', cleanModelId: 'fixture/model', requestedRevision: { status: 'omitted' }, autoClass: 'AutoModelForCausalLM', processor: 'tokenizer', selectedCandidate: { device: 'webgpu', dtype: 'q4f16' }, resolvedRevision: { status: 'not-observed' }, sessionExecutionProvider: { status: 'not-observed' } };
    capture.calls[0]!.loadIdentity = load;
    const secondContext = { ...context, generationCallId: 2 };
    capture.calls.push({ context: secondContext, loadIdentity: { ...load }, outcome: 'fulfilled', invocations: [] });
    const native = collectionFixture({ capture });
    const lifetime = native.epochs[0]!.lifetime;
    if (lifetime.status !== 'observed') throw new Error('Expected test lifetime');
    const exported = await createProductionProviderNativeEvidence({ maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES, native: { ...native, epochs: [{ ...native.epochs[0]!, lifetime: { ...lifetime, value: { ...lifetime.value, issuedCalls: [context, secondContext] } } }] }, provider });
    const readBinary = vi.fn(async ({ reference }: { reference: { path: string } }) => new Uint8Array(await exported.binaries.find(binary => binary.path === reference.path)!.blob.arrayBuffer()));
    await expect(verifyProductionProviderNativeEvidence({ json: exported.json, provider, readBinary })).resolves.toEqual({ referencedPaths: exported.binaries.map(binary => binary.path), summary: exported.summary });
    readBinary.mockClear();
    const forged = JSON.parse(exported.json);
    forged.epochs[0].collection.result.capture.calls[1].loadIdentity.selectedCandidate = { device: 'wasm', dtype: 'q4' };
    await expect(verifyProductionProviderNativeEvidence({ json: JSON.stringify(forged), provider, readBinary })).rejects.toThrow(/^Invalid native capture evidence$/u);
    expect(readBinary).not.toHaveBeenCalled();
  });

  it('verifies exported native payloads against manifest-verified binary references', async () => {
    const provider = providerFixture();
    const exported = await createProductionProviderNativeEvidence({ maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES, native: collectionFixture({ capture: nativeFixture() }), provider });
    const readBinary = vi.fn(async ({ reference }: { reference: { path: string; byteLength: number; sha256: string } }) => {
      const binary = exported.binaries.find(binary => binary.path === reference.path);
      if (binary === undefined || binary.sha256 !== reference.sha256 || binary.byteLength !== reference.byteLength) throw new Error('Invalid manifest reference');
      return new Uint8Array(await binary.blob.arrayBuffer());
    });
    const verified = await verifyProductionProviderNativeEvidence({ json: exported.json, provider, readBinary });
    expect(verified.referencedPaths).toEqual(exported.binaries.map(binary => binary.path));
    expect(readBinary).toHaveBeenCalledTimes(2);
  });

  it('decodes undefined only in known positions while preserving omitted budget fields', async () => {
    const provider = providerFixture();
    const capture = nativeFixture();
    capture.events.push({ kind: 'settings', identity, value: {
      requested: { maxCompletionTokens: { status: 'omitted' }, temperature: { status: 'undefined' }, topP: { status: 'omitted' } },
      budget: { source: 'transformers-default', pastTokenCount: 0, maxNewTokens: undefined },
      kwargs: { keys: { status: 'complete', totalCount: 0, values: [], incompleteReasons: [] }, maxNewTokens: { status: 'omitted' }, temperature: { status: 'undefined' }, topP: { status: 'omitted' }, doSample: { status: 'omitted' }, returnDictInGenerate: { status: 'omitted' } },
    } });
    const exported = await createProductionProviderNativeEvidence({ maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES, native: collectionFixture({ capture }), provider });
    const readBinary = async ({ reference }: { reference: { path: string } }) => new Uint8Array(await exported.binaries.find(binary => binary.path === reference.path)!.blob.arrayBuffer());
    const document = JSON.parse(exported.json);
    const budget = document.epochs[0].collection.result.capture.events.at(-1).value.budget;
    expect(budget.maxNewTokens).toEqual({ captureValue: 'undefined' });
    expect(Object.hasOwn(budget, 'contextLimit')).toBe(false);
    await expect(verifyProductionProviderNativeEvidence({ json: exported.json, provider, readBinary })).resolves.toBeDefined();
    budget.maxNewTokens = { captureValue: 'private' };
    await expect(verifyProductionProviderNativeEvidence({ json: JSON.stringify(document), provider, readBinary })).rejects.toThrow(/^Invalid native capture evidence$/u);
    const missing = JSON.parse(exported.json);
    delete missing.epochs[0].lifetime.value.loadRequests[0].requestedRevision;
    await expect(verifyProductionProviderNativeEvidence({ json: JSON.stringify(missing), provider, readBinary })).rejects.toThrow(/^Invalid native capture evidence$/u);
  });

  it('applies the authoritative native stream schema without discarding unknown details', async () => {
    const provider = providerFixture();
    const exported = await createProductionProviderNativeEvidence({ maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES, native: collectionFixture({ capture: nativeFixture() }), provider });
    const readBinary = async ({ reference }: { reference: { path: string } }) => new Uint8Array(await exported.binaries.find(binary => binary.path === reference.path)!.blob.arrayBuffer());
    const extra = JSON.parse(exported.json);
    extra.epochs[0].collection.result.capture.events[2].detail.privateValue = 'must not survive';
    await expect(verifyProductionProviderNativeEvidence({ json: JSON.stringify(extra), provider, readBinary })).rejects.toThrow(/^Invalid native capture evidence$/u);
    const invalidToken = JSON.parse(exported.json);
    invalidToken.epochs[0].collection.result.capture.events[2].detail.groups[0][0] = 'not-an-integer';
    await expect(verifyProductionProviderNativeEvidence({ json: JSON.stringify(invalidToken), provider, readBinary })).rejects.toThrow(/^Invalid native capture evidence$/u);
  });

  it('does not invent correlation for a capture that was not started', async () => {
    const provider = providerFixture();
    const original = collectionFixture({ capture: nativeFixture() });
    const exported = await createProductionProviderNativeEvidence({ maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES, native: { ...original, epochs: [{ ...original.epochs[0]!, collection: { status: 'returned', result: { status: 'not-started' } } }] }, provider });
    const readBinary = vi.fn(async () => new Uint8Array(0));
    await expect(verifyProductionProviderNativeEvidence({ json: exported.json, provider, readBinary })).resolves.toEqual({ referencedPaths: [], summary: exported.summary });
    const forged = JSON.parse(exported.json);
    forged.epochs[0].correlation = [{ context, observation: 'issued-not-observed' }];
    await expect(verifyProductionProviderNativeEvidence({ json: JSON.stringify(forged), provider, readBinary })).rejects.toThrow(/^Invalid native capture evidence$/u);
    expect(readBinary).not.toHaveBeenCalled();
  });

  it('preserves the requested hf.co spelling while validating the normalized successful model', async () => {
    const provider = { ...providerFixture(), modelId: 'hf.co/fixture/model' };
    const capture = nativeFixture();
    capture.calls[0]!.loadIdentity = { status: 'ready', workerLoadOrdinal: 1, requestedModelId: provider.modelId, cleanModelId: 'fixture/model', requestedRevision: { status: 'omitted' }, autoClass: 'AutoModelForCausalLM', processor: 'tokenizer', selectedCandidate: { device: 'webgpu', dtype: 'q4f16' }, resolvedRevision: { status: 'not-observed' }, sessionExecutionProvider: { status: 'not-observed' } };
    const native = collectionFixture({ capture });
    const lifetime = native.epochs[0]!.lifetime;
    if (lifetime.status !== 'observed') throw new Error('Expected test lifetime');
    const exported = await createProductionProviderNativeEvidence({ maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES, native: { ...native, epochs: [{ ...native.epochs[0]!, lifetime: { ...lifetime, value: { ...lifetime.value, loadRequests: [{ requestedModelId: provider.modelId, requestedRevision: undefined }] } } }] }, provider });
    const readBinary = async ({ reference }: { reference: { path: string } }) => new Uint8Array(await exported.binaries.find(binary => binary.path === reference.path)!.blob.arrayBuffer());
    await expect(verifyProductionProviderNativeEvidence({ json: exported.json, provider, readBinary })).resolves.toEqual({ referencedPaths: exported.binaries.map(binary => binary.path), summary: exported.summary });
    const document = JSON.parse(exported.json);
    expect(document.epochs[0].lifetime.value.loadRequests[0].requestedModelId).toBe(provider.modelId);
    expect(document.epochs[0].collection.result.capture.calls[0].loadIdentity.cleanModelId).toBe('fixture/model');
  });

  it('rejects nonsequential or repeated binary paths before reading any binary', async () => {
    const provider = providerFixture();
    const exported = await createProductionProviderNativeEvidence({ maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES, native: collectionFixture({ capture: nativeFixture() }), provider });
    const readBinary = vi.fn(async () => Uint8Array.of(5, 6));
    await expect(verifyProductionProviderNativeEvidence({ json: exported.json.replace('000002.bin', '000001.bin'), provider, readBinary })).rejects.toThrow(/^Invalid native capture evidence$/u);
    await expect(verifyProductionProviderNativeEvidence({ json: exported.json.replace('000001.bin', '000003.bin'), provider, readBinary })).rejects.toThrow(/^Invalid native capture evidence$/u);
    expect(readBinary).not.toHaveBeenCalled();
  });

  it('rejects foreign run, forged correlation and extra native fields instead of dropping them', async () => {
    const provider = providerFixture();
    const exported = await createProductionProviderNativeEvidence({ maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES, native: collectionFixture({ capture: nativeFixture() }), provider });
    const readBinary = vi.fn(async ({ reference }: { reference: { path: string } }) => new Uint8Array(await exported.binaries.find(binary => binary.path === reference.path)!.blob.arrayBuffer()));
    await expect(verifyProductionProviderNativeEvidence({ json: exported.json.replaceAll('native-export', 'foreign-export'), provider, readBinary })).rejects.toThrow(/^Invalid native capture evidence$/u);
    const correlation = JSON.parse(exported.json);
    correlation.epochs[0].correlation[0].observation = 'issued-not-observed';
    await expect(verifyProductionProviderNativeEvidence({ json: JSON.stringify(correlation), provider, readBinary })).rejects.toThrow(/^Invalid native capture evidence$/u);
    const unknown = JSON.parse(exported.json);
    unknown.epochs[0].collection.result.capture.events[0].privatePath = '/private';
    await expect(verifyProductionProviderNativeEvidence({ json: JSON.stringify(unknown), provider, readBinary })).rejects.toThrow(/^Invalid native capture evidence$/u);
  });

  it('verifies safe refusal without fabricating a captured payload or reading binary data', async () => {
    const provider = providerFixture();
    const capture = nativeFixture();
    capture.events.push({ kind: 'inputs', identity, phase: 'pre-budget', values: [{ name: 'unknown-private-key', snapshot: { status: 'not-recorded', reason: 'excluded-field' } }] });
    const exported = await createProductionProviderNativeEvidence({ maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES, native: collectionFixture({ capture }), provider });
    const readBinary = vi.fn(async () => new Uint8Array(0));
    await expect(verifyProductionProviderNativeEvidence({ json: exported.json, provider, readBinary })).resolves.toEqual({ referencedPaths: [], summary: exported.summary });
    const forged = JSON.parse(exported.json);
    forged.epochs[0].collection.result = { status: 'captured' };
    await expect(verifyProductionProviderNativeEvidence({ json: JSON.stringify(forged), provider, readBinary })).rejects.toThrow(/^Invalid native capture evidence$/u);
    expect(readBinary).not.toHaveBeenCalled();
  });

  it('rejects a reference exceeding byte limits and a reader returning the wrong byte window', async () => {
    const provider = providerFixture();
    const exported = await createProductionProviderNativeEvidence({ maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES, native: collectionFixture({ capture: nativeFixture() }), provider });
    const readBinary = vi.fn(async () => Uint8Array.of(1));
    const excessive = JSON.parse(exported.json);
    excessive.epochs[0].collection.result.capture.events[1].values[0].snapshot.bytes.byteLength = 67108865;
    await expect(verifyProductionProviderNativeEvidence({ json: JSON.stringify(excessive), provider, readBinary })).rejects.toThrow(/^Invalid native capture evidence$/u);
    expect(readBinary).not.toHaveBeenCalled();
    await expect(verifyProductionProviderNativeEvidence({ json: exported.json, provider, readBinary })).rejects.toThrow(/^Invalid native capture evidence$/u);
  });

  it('emits exact binary windows and empty tensors with identity, stream grouping and explicit limitations', async () => {
    const capture = nativeFixture();
    const input = capture.events[1];
    if (input?.kind !== 'inputs' || input.values[0]?.snapshot.status !== 'captured') throw new Error('Expected test tensor');
    input.values[0].snapshot.bytes = Uint8Array.of(99, 5, 6, 88).subarray(1, 3);
    const result = await createProductionProviderNativeEvidence({ maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES, native: collectionFixture({ capture }), provider: providerFixture() });
    const document = JSON.parse(result.json);
    expect(document.format).toBe('production-provider-native-evidence-v1');
    expect(document.limitations.replayEligibility).toBe('not-established');
    expect(await Promise.all(result.binaries.map(async binary => Array.from(new Uint8Array(await binary.blob.arrayBuffer()))))).toEqual([[5, 6], []]);
    const exported = document.epochs[0].collection.result.capture;
    expect(exported.events[2]).toEqual(capture.events[2]);
    expect(exported.calls).toEqual(capture.calls);
    expect(exported.byteOrder).toBe('little-endian');
    for (const [index, binary] of result.binaries.entries()) {
      expect(binary.path).toBe(`generation-native/tensors/${String(index + 1).padStart(6, '0')}.bin`);
      expect(binary.sha256).toBe(Buffer.from(await webcrypto.subtle.digest('SHA-256', await binary.blob.arrayBuffer())).toString('hex'));
    }
    expect(exported.events[1].values[0].snapshot.bytes).toEqual({ path: result.binaries[0]!.path, byteLength: 2, sha256: result.binaries[0]!.sha256 });
    expect(document.epochs[0].lifetime.value.loadRequests[0].requestedRevision).toEqual({ captureValue: 'undefined' });
  });

  it('copies bytes before hash awaits and never invokes opaque byte-array properties', async () => {
    const capture = nativeFixture();
    const input = capture.events[1];
    if (input?.kind !== 'inputs' || input.values[0]?.snapshot.status !== 'captured') throw new Error('Expected test tensor');
    const source = input.values[0].snapshot.bytes;
    const getter = vi.fn(() => {
      throw new Error('Secret getter must not run');
    });
    Object.defineProperty(source, 'privateSecret', { get: getter });
    Object.defineProperty(source, Symbol.iterator, { get: getter });
    Object.defineProperty(source, 'slice', { get: getter });
    const exporting = createProductionProviderNativeEvidence({ maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES, native: collectionFixture({ capture }), provider: providerFixture() });
    source.fill(44);
    const result = await exporting;
    expect(Array.from(new Uint8Array(await result.binaries[0]!.blob.arrayBuffer()))).toEqual([5, 6]);
    expect(result.json).not.toContain('privateSecret');
    expect(getter).not.toHaveBeenCalled();
  });

  it('retains Provider evidence eligibility while refusing an epoch containing unknown private native key names', async () => {
    const capture = nativeFixture();
    capture.events.push({ kind: 'inputs', identity, phase: 'pre-budget', values: [{ name: 'private-local-path', snapshot: { status: 'not-recorded', reason: 'excluded-field' } }] });
    const provider = providerFixture();
    const result = await createProductionProviderNativeEvidence({ maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES, native: collectionFixture({ capture }), provider });
    expect(JSON.parse(result.json).epochs[0].collection).toEqual({ status: 'export-refused', reason: 'unsupported-native-key' });
    expect(result.binaries).toEqual([]);
    expect(result.json).not.toContain('private-local-path');
    expect(provider.run.status).toBe('completed');
  });

  it('retains issued-but-unobserved calls without equating Provider rejection and native fulfillment', async () => {
    const capture = nativeFixture();
    const original = collectionFixture({ capture });
    const epoch = original.epochs[0]!;
    if (epoch.lifetime.status !== 'observed') throw new Error('Expected host lifetime');
    epoch.lifetime.value.issuedCalls.push({ ...context, generationCallId: 2 });
    const provider = providerFixture();
    const request = provider.requests[0]!;
    const rejected: ProductionProviderCaptureSnapshot = { ...provider, run: { status: 'stopped', reason: 'provider-rejected' }, requests: [{ ...request, trace: { ...request.trace, settled: { ...request.trace.settled!, outcome: { status: 'rejected', errorName: 'unknown' } } } }] };
    const result = await createProductionProviderNativeEvidence({ maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES, native: original, provider: rejected });
    expect(JSON.parse(result.json).epochs[0].correlation.map((item: { observation: string }) => item.observation)).toEqual(['observed', 'issued-not-observed']);
    expect(JSON.parse(result.json).epochs[0].collection.result.capture.calls[0].outcome).toBe('fulfilled');
  });

  it('preserves one-shot outcomes, failed collection and lost epochs instead of synthesizing empty success', async () => {
    const original = collectionFixture({ capture: nativeFixture() });
    const collections: ProductionProviderNativeCollectionSnapshot['epochs'][number]['collection'][] = [
      { status: 'returned', result: { status: 'not-started' } }, { status: 'returned', result: { status: 'already-taken' } },
      { status: 'returned', result: { status: 'busy' } }, { status: 'failed', reason: 'take-failed' },
      { status: 'unavailable', reason: 'session-inactive' }, { status: 'not-requested' }, { status: 'pending' },
    ];
    for (const collection of collections) {
      const phase: ProductionProviderNativeCollectionSnapshot['phase'] = collection.status === 'pending' ? 'collecting' : collection.status === 'not-requested' ? 'not-requested' : 'finished';
      const native = { ...original, phase, epochs: [{ ...original.epochs[0]!, collection }] };
      const result = await createProductionProviderNativeEvidence({ maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES, native, provider: providerFixture() });
      expect(JSON.parse(result.json).epochs[0].collection).toEqual(collection);
      expect(result.binaries).toEqual([]);
    }
  });

  it('rejects foreign context and unissued native calls with a constant error', async () => {
    const capture = nativeFixture();
    capture.calls[0]!.context = { ...context, requestId: 'foreign-private-request' };
    await expect(createProductionProviderNativeEvidence({ maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES, native: collectionFixture({ capture }), provider: providerFixture() })).rejects.toThrow(/^Invalid native capture evidence$/u);
    const another = nativeFixture();
    another.workerEpoch = 2;
    await expect(createProductionProviderNativeEvidence({ maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES, native: collectionFixture({ capture: another }), provider: providerFixture() })).rejects.toThrow(/^Invalid native capture evidence$/u);
  });

  it('rejects unknown records and accessors before reading them', async () => {
    const original = collectionFixture({ capture: nativeFixture() });
    const getter = vi.fn(() => {
      throw new Error('Private accessor');
    });
    const forged = Object.defineProperty({ ...original }, 'runId', { get: getter });
    await expect(createProductionProviderNativeEvidence({ maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES, native: forged, provider: providerFixture() })).rejects.toThrow(/^Invalid native capture evidence$/u);
    const extra = { ...original, secretPath: '/private' };
    await expect(createProductionProviderNativeEvidence({ maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES, native: extra, provider: providerFixture() })).rejects.toThrow(/^Invalid native capture evidence$/u);
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects shared backing and dishonest dimensions without hashing invalid bytes', async () => {
    const capture = nativeFixture();
    const input = capture.events[1];
    if (input?.kind !== 'inputs' || input.values[0]?.snapshot.status !== 'captured') throw new Error('Expected test tensor');
    Reflect.set(input.values[0].snapshot, 'bytes', new Uint8Array(new SharedArrayBuffer(2)));
    await expect(createProductionProviderNativeEvidence({ maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES, native: collectionFixture({ capture }), provider: providerFixture() })).rejects.toThrow(/^Invalid native capture evidence$/u);
    input.values[0].snapshot.bytes = Uint8Array.of(5, 6);
    input.values[0].snapshot.dims = [3];
    await expect(createProductionProviderNativeEvidence({ maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES, native: collectionFixture({ capture }), provider: providerFixture() })).rejects.toThrow(/^Invalid native capture evidence$/u);
  });

  it('refuses expanded tensor volume before copying or parsing repeated small backing buffers', async () => {
    const capture = nativeFixture();
    const bytes = new Uint8Array(2049);
    const names = ['input_ids', 'attention_mask', 'decoder_input_ids', 'decoder_attention_mask', 'pixel_values', 'image_position_ids', 'image_grid_thw', 'video_grid_thw'];
    const repeated: Native['events'][number] = { kind: 'inputs', identity, phase: 'native-kwargs', values: names.map(name => ({ name, snapshot: { status: 'captured', dtype: 'uint8', dims: [2049], byteLength: 2049, bytes } })) };
    // Only 2 KiB of backing bytes and one shared event are allocated here.
    // Expanding every occurrence would exceed the whole-export 64 MiB budget.
    capture.events = Array.from({ length: 4096 }, () => repeated);
    const digest = vi.spyOn(webcrypto.subtle, 'digest');
    const result = await createProductionProviderNativeEvidence({ maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES, native: collectionFixture({ capture }), provider: providerFixture() });
    expect(JSON.parse(result.json).epochs[0].collection).toEqual({ status: 'export-refused', reason: 'native-export-budget' });
    expect(result.binaries).toEqual([]);
    expect(digest).not.toHaveBeenCalled();
  });

  it('refuses repeated token rows without parsing or serializing unvisited payloads', async () => {
    const capture = nativeFixture();
    const repeated: Native['events'][number] = { kind: 'native-stream', identity, operation: 'put', phase: 'entering', streamCallOrdinal: 1, detail: { kind: 'tokens', tokenType: 'bigint', groups: [Array.from({ length: 65536 }, () => '1')] } };
    const getter = vi.fn(() => {
      throw new Error('Unvisited payload must not be parsed or serialized');
    });
    const unvisited = Object.defineProperty({}, 'kind', { get: getter });
    capture.events = [repeated, repeated, repeated, repeated, repeated];
    Reflect.set(capture.events, '5', unvisited);
    const result = await createProductionProviderNativeEvidence({ maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES, native: collectionFixture({ capture }), provider: providerFixture() });
    expect(JSON.parse(result.json).epochs[0].collection.status).toBe('export-refused');
    expect(result.json).not.toContain('groups');
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects impossible collection phases instead of treating pending retrieval as finished', async () => {
    const original = collectionFixture({ capture: nativeFixture() });
    const pending: ProductionProviderNativeCollectionSnapshot = { ...original, epochs: [{ ...original.epochs[0]!, collection: { status: 'pending' } }] };
    await expect(createProductionProviderNativeEvidence({ maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES, native: pending, provider: providerFixture() })).rejects.toThrow(/^Invalid native capture evidence$/u);
    await expect(createProductionProviderNativeEvidence({ maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES, native: { ...original, phase: 'not-requested' }, provider: providerFixture() })).rejects.toThrow(/^Invalid native capture evidence$/u);
  });

  it('keeps requested Load options distinct from unresolved backend/revision facts and rejects another model', async () => {
    const capture = nativeFixture();
    capture.calls[0]!.loadIdentity = { status: 'ready', workerLoadOrdinal: 1, requestedModelId: 'hf.co/fixture/model', cleanModelId: 'fixture/model', requestedRevision: { status: 'omitted' }, autoClass: 'AutoModelForCausalLM', processor: 'tokenizer', selectedCandidate: { device: 'webgpu', dtype: 'q4f16' }, resolvedRevision: { status: 'not-observed' }, sessionExecutionProvider: { status: 'not-observed' } };
    const result = await createProductionProviderNativeEvidence({ maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES, native: collectionFixture({ capture }), provider: providerFixture() });
    expect(JSON.parse(result.json).epochs[0].collection.result.capture.calls[0].loadIdentity).toEqual(capture.calls[0]!.loadIdentity);
    capture.calls[0]!.loadIdentity = { ...capture.calls[0]!.loadIdentity, requestedModelId: 'foreign/model', cleanModelId: 'foreign/model' };
    await expect(createProductionProviderNativeEvidence({ maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES, native: collectionFixture({ capture }), provider: providerFixture() })).rejects.toThrow(/^Invalid native capture evidence$/u);
  });
});
