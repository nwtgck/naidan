// @vitest-environment node
import JSZip from "jszip";
import { webcrypto } from 'node:crypto';
import { completeInvestigationCheckpoint, createInitialInvestigationCheckpoint } from './investigation-recovery';
import { createProductionProviderCaptureOwner } from './production-provider-capture-owner';
import { verifyGeneratedEvidenceArchive } from './verify-evidence-archive';
import * as archiveVerifier from './verify-evidence-archive';
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductionProviderCaptureSnapshot } from './production-provider-capture-owner';
import type { ProductionProviderNativeCollectionSnapshot } from './production-provider-generation-capture-owner';
import * as nativeEvidence from './production-provider-native-evidence';
import * as evidenceArchive from './evidence-archive';
import type {
  ModelSupportInvestigationEvidencePackageAssessment,
  ModelSupportInvestigationRun,
  ModelSupportInvestigationRuntimeAssetIdentity,
} from "@/features/transformers-js/model-support-investigation/types";
import {
  createBatchModelSupportEvidence,
  createPartialModelSupportEvidence,
} from "./create-partial-evidence";

// These serialization tests require real Web Blob/streams, not a DOM. JSZip
// remains an independent test-only reader for the produced ZIP transport.

function runtimeAssetIdentity(): ModelSupportInvestigationRuntimeAssetIdentity {
  return {
    manifestBuildId: "runtime-build-fixture",
    manifestUrl: "https://naidan.example/transformers/runtime-assets-runtime-build-fixture.json",
    observedManifestBuildId: "runtime-build-fixture",
    versions: {
      transformers: "4.2.0",
      onnxRuntimeWeb: "1.26.0-dev.20260416-b7804b056c",
      onnxRuntimeCommon: "1.24.3",
      onnxRuntimeWebBundledCommon: "1.24.0-dev.20251116-b39e144322",
    },
    mjs: {
      url: "https://naidan.example/transformers/ort-fixture.mjs",
      expectedByteLength: 11,
      observedByteLength: 11,
      expectedSha256: "m".repeat(64),
      observedSha256: "m".repeat(64),
    },
    wasm: {
      logicalUrl: "https://naidan.example/transformers/ort-fixture.wasm",
      physicalUrl: "https://naidan.example/transformers/ort-fixture.wasm.gz",
      expectedByteLength: 12,
      observedByteLength: 12,
      expectedSha256: "w".repeat(64),
      observedSha256: "w".repeat(64),
      expectedPhysicalByteLength: 8,
      observedPhysicalByteLength: 8,
      expectedPhysicalSha256: "g".repeat(64),
      observedPhysicalSha256: "g".repeat(64),
    },
  };
}

// Fixed DTOs exercise ZIP serialization only, not a new generation or capture.
function nativeRecords({ runId, modelId }: { runId: string; modelId: string }) {
  const checkpoint = createInitialInvestigationCheckpoint({ modelId, runId, now: () => '2026-09-09T00:00:00.000Z' });
  const context = { runId, workerEpoch: 1, requestId: `${runId}-first-turn`, generationCallId: 1 };
  const provider: ProductionProviderCaptureSnapshot = {
    format: 'production-provider-capture-v2', runId, modelId, plan: 'first-only', run: { status: 'completed' },
    lifetime: 'open', abortReason: undefined, disposal: 'not-requested', observation: 'open', events: [],
    requests: [{ runId, requestId: context.requestId, scenario: 'first-turn', status: 'settled', notStartedReason: undefined, input: {
      messages: [{ role: 'user', content: 'Template probe user message.' }], tools: [],
      parameters: { temperature: 0, topP: 1, maxCompletionTokens: 16, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
    }, trace: {
      format: 'production-provider-trace-v2', requestId: context.requestId,
      limits: { maximumEvents: 20, maximumCharacters: 1024, maximumFieldCharacters: 16384 },
      completeness: 'complete', failure: undefined, events: [], lateEvents: [], retainedCharacters: 0,
      settled: { sequence: 0, outcome: { status: 'fulfilled' }, events: [], completeness: 'complete', failure: undefined },
    } }],
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
  return { ...checkpoint, native };
}

async function savedNativeEvidence({ run, native }: { run: ModelSupportInvestigationRun; native: ProductionProviderNativeCollectionSnapshot }) {
  if (run.productionProviderCapture === undefined) throw new Error('Expected test Provider capture');
  return nativeEvidence.createProductionProviderNativeEvidence({ native, provider: run.productionProviderCapture, maximumBinaryBytes: nativeEvidence.PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES });
}

describe('native sidecars in generated Evidence ZIPs', () => {
  it('preserves each saved image-size matrix and native call in multi-model batch re-export', async () => {
    const records = [nativeRecords({ runId: 'size-one', modelId: 'org/one' }), nativeRecords({ runId: 'size-two', modelId: 'org/two' })];
    const items = await Promise.all(records.map(async (item, index) => {
      const collection = item.native.epochs[0]!.collection;
      if (collection.status !== 'returned' || collection.result.status !== 'captured') throw new Error('Expected native fixture');
      const capture = collection.result.capture;
      capture.events.push({ kind: 'inputs', identity: { ...capture.calls[0]!.context, nativeInvocationOrdinal: 1 }, phase: 'native-kwargs', values: [
        { name: 'original_sizes', snapshot: { status: 'image-sizes', values: [[index + 1, index + 2]] } },
        { name: 'reshaped_input_sizes', snapshot: { status: 'image-sizes', values: [[256, 512]] } },
      ] });
      return { target: item.run.modelId, status: 'passed' as const, run: item.run, recovery: item.recovery, nativeEvidence: await savedNativeEvidence({ run: item.run, native: item.native }), error: undefined };
    }));
    const verifyInner = vi.spyOn(archiveVerifier, 'verifyGeneratedEvidenceFiles');
    const first = await createBatchModelSupportEvidence({ batchId: 'image-sizes-batch', items });
    const second = await createBatchModelSupportEvidence({ batchId: 'image-sizes-batch', items: structuredClone(items) });
    const firstZip = await JSZip.loadAsync(await first.blob.arrayBuffer());
    const secondZip = await JSZip.loadAsync(await second.blob.arrayBuffer());
    for (const [index, prefix] of ['models/001-org-one/', 'models/002-org-two/'].entries()) {
      const path = `${prefix}generation-native/capture.json`;
      expect(await firstZip.file(path)!.async('text')).toBe(items[index]!.nativeEvidence.json);
      expect(await secondZip.file(path)!.async('text')).toBe(items[index]!.nativeEvidence.json);
      const envelope = JSON.parse(await secondZip.file(path)!.async('text'));
      expect(envelope.epochs[0].collection.result.capture.calls).toHaveLength(1);
      expect(envelope.epochs[0].collection.result.capture.events[1].values[0].snapshot).toEqual({ status: 'image-sizes', values: [[index + 1, index + 2]] });
    }
    // Batch creation validates each inner dossier before namespacing. Its
    // outer manifest is a batch, not a single-run verifier input.
    expect(verifyInner).toHaveBeenCalledTimes(4);
  });
  beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('fetch', vi.fn(() => {
      throw new Error('Export must not access the network');
    }));
    vi.stubGlobal('Worker', vi.fn(() => {
      throw new Error('Export must not create a Worker or call Load/RPC');
    }));
    vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn(() => {
      throw new Error('Export must not access OPFS');
    }) } });
  });
  afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(globalThis.Worker).not.toHaveBeenCalled();
    expect(navigator.storage.getDirectory).not.toHaveBeenCalled();
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  it('compresses the outer batch once after assembling uncompressed model file sets', async () => {
    const one = nativeRecords({ runId: 'archive-one', modelId: 'org/one' });
    const two = nativeRecords({ runId: 'archive-two', modelId: 'org/two' });
    const compression = vi.spyOn(evidenceArchive, 'createEvidenceArchive');
    const result = await createBatchModelSupportEvidence({ batchId: 'one-archive', items: [one, two].map(item => ({ target: item.run.modelId, status: 'passed' as const, run: item.run, recovery: item.recovery, error: undefined })) });
    expect(compression).toHaveBeenCalledTimes(1);
    const inputs = compression.mock.calls[0]![0].files;
    expect(inputs.get('models/001-org-one/run.json')).toBeInstanceOf(Blob);
    expect(inputs.get('models/002-org-two/run.json')).toBeInstanceOf(Blob);
    const oracle = await JSZip.loadAsync(await result.blob.arrayBuffer());
    expect(oracle.file('models/001-org-one/manifest.json')).not.toBeNull();
    expect(oracle.file('models/002-org-two/manifest.json')).not.toBeNull();
  });

  it('closes the final batch reader when semantic verification throws', async () => {
    const item = nativeRecords({ runId: 'reader-close', modelId: 'org/one' });
    const open = evidenceArchive.openEvidenceArchive;
    const close = vi.fn<() => Promise<void>>();
    const failure = new Error('Injected final archive read failure');
    vi.spyOn(evidenceArchive, 'openEvidenceArchive').mockImplementation(async input => {
      const opened = await open(input);
      close.mockImplementation(opened.close);
      return { reader: { paths: opened.reader.paths, async read() {
        throw failure;
      } }, close };
    });
    await expect(createBatchModelSupportEvidence({ batchId: 'reader-close', items: [{ target: item.run.modelId, status: 'passed', run: item.run, recovery: item.recovery, error: undefined }] })).rejects.toBe(failure);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('writes native bytes exactly once with a run reference and stable re-export from saved snapshots', async () => {
    const { run, recovery, native } = nativeRecords({ runId: 'native-single', modelId: 'org/one' });
    const sourceProvider = JSON.stringify(run.productionProviderCapture);
    const sidecar = await savedNativeEvidence({ run, native });
    const encode = vi.spyOn(nativeEvidence, 'createProductionProviderNativeEvidence');
    const first = await createPartialModelSupportEvidence({ run, recovery, nativeEvidence: sidecar });
    const second = await createPartialModelSupportEvidence({ run, recovery, nativeEvidence: structuredClone(sidecar) });
    expect(encode).not.toHaveBeenCalled();
    const firstZip = await JSZip.loadAsync(await first.blob.arrayBuffer());
    const secondZip = await JSZip.loadAsync(await second.blob.arrayBuffer());
    const savedRun = JSON.parse(await firstZip.file('run.json')!.async('string'));
    expect(savedRun.productionProviderNativeCapture).toEqual({ format: 'production-provider-native-reference-v1', path: 'generation-native/capture.json' });
    expect(Object.hasOwn(run, 'productionProviderNativeCapture')).toBe(false);
    expect(JSON.stringify(run.productionProviderCapture)).toBe(sourceProvider);
    expect(savedRun.status).toBe(run.status);
    const paths = Object.keys(firstZip.files).filter(path => !firstZip.files[path]!.dir && path.startsWith('generation-native/'));
    expect(paths.sort()).toEqual(['generation-native/capture.json', 'generation-native/tensors/000001.bin']);
    expect(await firstZip.file('generation-native/tensors/000001.bin')!.async('uint8array')).toEqual(Uint8Array.of(5, 6));
    for (const path of ['run.json', 'production-provider/capture.json', 'generation-native/capture.json', 'generation-native/tensors/000001.bin', 'manifest.json']) {
      expect(await secondZip.file(path)!.async('uint8array')).toEqual(await firstZip.file(path)!.async('uint8array'));
    }
    const manifest = JSON.parse(await firstZip.file('manifest.json')!.async('string'));
    expect(manifest.files).toContainEqual(expect.objectContaining({ path: 'generation-native/tensors/000001.bin', byteLength: 2, sha256: 'c42522128b49193de8cd45d8f7589cd7e085e65f138640d57d4482e5f7189623' }));
    await expect(verifyGeneratedEvidenceArchive({ blob: first.blob })).resolves.toMatchObject({ runId: run.runId });
    expect(await firstZip.file('SUMMARY.md')!.async('string')).toContain('does not certify Load success or complete replay');
  });

  it('rejects foreign native run identity and native capture without a Provider snapshot', async () => {
    const { run, recovery, native } = nativeRecords({ runId: 'native-identity', modelId: 'org/one' });
    const sidecar = await savedNativeEvidence({ run, native });
    await expect(createPartialModelSupportEvidence({ run, recovery, nativeEvidence: { ...sidecar, json: sidecar.json.replaceAll('native-identity', 'foreign') } })).rejects.toThrow();
    const { productionProviderCapture: _provider, ...withoutProvider } = run;
    await expect(createPartialModelSupportEvidence({ run: withoutProvider, recovery, nativeEvidence: sidecar })).rejects.toThrow();
  });

  it('keeps refusal and unavailable collection distinct from an absent sidecar', async () => {
    const { run, recovery, native } = nativeRecords({ runId: 'native-partial', modelId: 'org/one' });
    const epoch = native.epochs[0]!;
    if (epoch.collection.status !== 'returned' || epoch.collection.result.status !== 'captured') throw new Error('Expected test capture');
    const capture = epoch.collection.result.capture;
    capture.events.push({ kind: 'inputs', identity: { ...capture.calls[0]!.context, nativeInvocationOrdinal: 1 }, phase: 'pre-budget', values: [{ name: 'private-key-not-exportable', snapshot: { status: 'not-recorded', reason: 'excluded-field' } }] });
    const refused = await createPartialModelSupportEvidence({ run, recovery, nativeEvidence: await savedNativeEvidence({ run, native }) });
    const refusedZip = await JSZip.loadAsync(await refused.blob.arrayBuffer());
    const refusedIndex = await refusedZip.file('generation-native/capture.json')!.async('string');
    expect(JSON.parse(refusedIndex).epochs[0].collection).toEqual({ status: 'export-refused', reason: 'unsupported-native-key' });
    expect(refusedIndex).not.toContain('private-key-not-exportable');
    expect(Object.keys(refusedZip.files).some(path => path.endsWith('.bin'))).toBe(false);
    const unavailable = await createPartialModelSupportEvidence({ run, recovery, nativeEvidence: await savedNativeEvidence({ run, native: { ...native, epochs: [{ ...epoch, collection: { status: 'unavailable', reason: 'session-inactive' } }] } }) });
    const unavailableZip = await JSZip.loadAsync(await unavailable.blob.arrayBuffer());
    expect(JSON.parse(await unavailableZip.file('generation-native/capture.json')!.async('string')).epochs[0].collection.status).toBe('unavailable');
    const absent = await createPartialModelSupportEvidence({ run, recovery });
    const absentZip = await JSZip.loadAsync(await absent.blob.arrayBuffer());
    expect(absentZip.file('generation-native/capture.json')).toBeNull();
    expect(Object.hasOwn(JSON.parse(await absentZip.file('run.json')!.async('string')), 'productionProviderNativeCapture')).toBe(false);
  });

  it('keeps each batch model ordinal local and passes a decreasing shared tensor budget to the real verifier', async () => {
    const one = nativeRecords({ runId: 'batch-one', modelId: 'org/one' });
    const two = nativeRecords({ runId: 'batch-two', modelId: 'org/two' });
    const items = await Promise.all([one, two].map(async item => ({ target: item.run.modelId, status: 'passed' as const, run: item.run, recovery: item.recovery, nativeEvidence: await savedNativeEvidence({ run: item.run, native: item.native }), error: undefined })));
    const encoder = vi.spyOn(nativeEvidence, 'createProductionProviderNativeEvidence');
    const verifier = vi.spyOn(nativeEvidence, 'verifyProductionProviderNativeEvidenceSidecar');
    const result = await createBatchModelSupportEvidence({ batchId: 'native-batch', items });
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
    expect(verifier.mock.calls.map(([input]) => input.maximumBinaryBytes)).toEqual([256 * 1024 * 1024, 256 * 1024 * 1024 - 2]);
    expect(encoder).not.toHaveBeenCalled();
    for (const [prefix, expectedRun] of [['models/001-org-one/', 'batch-one'], ['models/002-org-two/', 'batch-two']]) {
      const index = JSON.parse(await zip.file(`${prefix}generation-native/capture.json`)!.async('string'));
      expect(index.runId).toBe(expectedRun);
      expect(index.epochs[0].collection.result.capture.events[0].snapshot.bytes.path).toBe('generation-native/tensors/000001.bin');
      expect(await zip.file(`${prefix}generation-native/tensors/000001.bin`)!.async('uint8array')).toEqual(Uint8Array.of(5, 6));
    }
  });

  it('rejects an orphan batch sidecar instead of dropping it with a missing run', async () => {
    const { run, native } = nativeRecords({ runId: 'orphan-native', modelId: 'org/one' });
    const sidecar = await savedNativeEvidence({ run, native });
    await expect(createBatchModelSupportEvidence({ batchId: 'orphan-batch', items: [{ target: 'org/one', status: 'interrupted', run: undefined, recovery: undefined, nativeEvidence: sidecar, error: undefined }] })).rejects.toThrow(/^Native capture Evidence requires its investigation run$/u);
  });

  it('propagates a real enclosing-byte refusal without exporting only the earlier batch models', async () => {
    const one = nativeRecords({ runId: 'budget-one', modelId: 'org/one' });
    const two = nativeRecords({ runId: 'budget-two', modelId: 'org/two' });
    const items = await Promise.all([one, two].map(async item => ({ target: item.run.modelId, status: 'passed' as const, run: item.run, recovery: item.recovery, nativeEvidence: await savedNativeEvidence({ run: item.run, native: item.native }), error: undefined })));
    const original = nativeEvidence.verifyProductionProviderNativeEvidenceSidecar;
    // Exercise the real bounded verifier with a tiny remaining allowance. The
    // preceding test independently fixes the production batch allowance wiring.
    const verifier = vi.spyOn(nativeEvidence, 'verifyProductionProviderNativeEvidenceSidecar')
      .mockImplementationOnce(input => original(input))
      .mockImplementationOnce(input => original({ ...input, maximumBinaryBytes: 1 }));
    await expect(createBatchModelSupportEvidence({ batchId: 'budget-batch', items })).rejects.toThrow(/^Invalid native capture evidence$/u);
    expect(verifier).toHaveBeenCalledTimes(2);
  });

  it('checks aggregate native JSON admission before any Blob body read or digest', async () => {
    const { run, recovery, native } = nativeRecords({ runId: 'json-budget', modelId: 'org/one' });
    const sidecar = await savedNativeEvidence({ run, native });
    const measure = nativeEvidence.measureProductionProviderNativeEvidenceSidecar;
    // The real measurement is tested with real strings in the helper suite.
    // Substitute only its scalar count to test batch arithmetic without a huge string.
    vi.spyOn(nativeEvidence, 'measureProductionProviderNativeEvidenceSidecar').mockImplementation(input => ({ ...measure(input), jsonCharacters: 32 * 1024 * 1024 + 1 }));
    const read = vi.spyOn(Blob.prototype, 'arrayBuffer');
    const digest = vi.spyOn(crypto.subtle, 'digest');
    const item = { target: run.modelId, status: 'passed' as const, run, recovery, nativeEvidence: sidecar, error: undefined };
    await expect(createBatchModelSupportEvidence({ batchId: 'json-budget', items: [item, item] })).rejects.toThrow(/^Native capture batch Evidence exceeds its retained data budget$/u);
    expect(read).not.toHaveBeenCalled();
    expect(digest).not.toHaveBeenCalled();
  });

  it('checks aggregate native binary admission before any Blob body read or digest', async () => {
    const { run, recovery, native } = nativeRecords({ runId: 'binary-budget', modelId: 'org/one' });
    const sidecar = await savedNativeEvidence({ run, native });
    const measure = nativeEvidence.measureProductionProviderNativeEvidenceSidecar;
    // Admission arithmetic uses scalar measurements, not fabricated large Blobs.
    vi.spyOn(nativeEvidence, 'measureProductionProviderNativeEvidenceSidecar').mockImplementation(input => ({ ...measure(input), binaryBytes: 64 * 1024 * 1024 }));
    const read = vi.spyOn(Blob.prototype, 'arrayBuffer');
    const digest = vi.spyOn(crypto.subtle, 'digest');
    const item = { target: run.modelId, status: 'passed' as const, run, recovery, nativeEvidence: sidecar, error: undefined };
    await expect(createBatchModelSupportEvidence({ batchId: 'binary-budget', items: [item, item, item, item, item] })).rejects.toThrow(/^Native capture batch Evidence exceeds its retained data budget$/u);
    expect(read).not.toHaveBeenCalled();
    expect(digest).not.toHaveBeenCalled();
  });

  it('rechecks a replaced later sidecar after an earlier model await', async () => {
    const one = nativeRecords({ runId: 'replace-one', modelId: 'org/one' });
    const two = nativeRecords({ runId: 'replace-two', modelId: 'org/two' });
    const first = await savedNativeEvidence({ run: one.run, native: one.native });
    const second = await savedNativeEvidence({ run: two.run, native: two.native });
    const replacement = { ...second, json: second.json + ' ' };
    const items = [
      { target: one.run.modelId, status: 'passed' as const, run: one.run, recovery: one.recovery, nativeEvidence: first, error: undefined },
      { target: two.run.modelId, status: 'passed' as const, run: two.run, recovery: two.recovery, nativeEvidence: second, error: undefined },
    ];
    const measure = nativeEvidence.measureProductionProviderNativeEvidenceSidecar;
    vi.spyOn(nativeEvidence, 'measureProductionProviderNativeEvidenceSidecar').mockImplementation(input => ({ ...measure(input),
      // Model the capacity of the replacement without allocating a huge JSON document.
      ...(input.evidence === replacement ? { jsonCharacters: 64 * 1024 * 1024 } : {}),
    }));
    const verify = nativeEvidence.verifyProductionProviderNativeEvidenceSidecar;
    const verification = vi.spyOn(nativeEvidence, 'verifyProductionProviderNativeEvidenceSidecar').mockImplementationOnce(async input => {
      const result = await verify(input);
      items[1]!.nativeEvidence = replacement;
      return result;
    });
    await expect(createBatchModelSupportEvidence({ batchId: 'replacement', items })).rejects.toThrow(/^Native capture batch Evidence exceeds its retained data budget$/u);
    expect(verification).toHaveBeenCalledTimes(1);
  });
});

describe("createPartialModelSupportEvidence", () => {
  it('exports an internally unclosed owner as failed evidence without inventing a user stop', async () => {
    const now = () => '2026-09-10T00:00:00.000Z';
    const initial = createInitialInvestigationCheckpoint({ modelId: 'org/model', runId: 'terminal-invariant-zip', now });
    initial.run.error = 'Earlier measured failure';
    initial.run.steps = initial.run.steps.map(step => step.id === 'download-evidence' ? { ...step, status: 'passed', detail: 'Bounded probes completed' } : step);
    const checkpoint = completeInvestigationCheckpoint({ checkpoint: initial, run: initial.run, now });
    const { blob } = await createPartialModelSupportEvidence({ run: checkpoint.run, recovery: checkpoint.recovery });
    await expect(verifyGeneratedEvidenceArchive({ blob })).resolves.toMatchObject({ runId: initial.run.runId });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const run = JSON.parse(await zip.file('run.json')!.async('text'));
    const recovery = JSON.parse(await zip.file('recovery/checkpoint.json')!.async('text'));
    expect(run.status).toBe('failed');
    expect(run.error).toContain('Earlier measured failure');
    expect(run.error).not.toContain('stopped by the user');
    expect(run.steps).toContainEqual({ id: 'download-evidence', status: 'passed', detail: 'Bounded probes completed' });
    expect(recovery.interruption.error).toMatchObject({ name: 'InvestigationTerminalInvariantError', message: 'Investigation completion retained running steps: runtime-assets' });
  });

  it('exports Provider capture once with a typed run reference and verified archive manifest', async () => {
    const checkpoint = createInitialInvestigationCheckpoint({ modelId: 'org/provider', runId: 'zip-provider', now: () => '2026-09-09T00:00:00.000Z' });
    const owner = createProductionProviderCaptureOwner({ runId: checkpoint.run.runId, modelId: checkpoint.run.modelId, plan: 'first-only',
      createWorkerClient: () => {
        throw new Error('Not-started export must not create a Worker');
      }, traceLimits: { maximumEvents: 10, maximumCharacters: 100 },
    });
    try {
      checkpoint.run.productionProviderCapture = owner.snapshot();
      const { blob } = await createPartialModelSupportEvidence({ run: checkpoint.run, recovery: checkpoint.recovery });
      const archive = await JSZip.loadAsync(await blob.arrayBuffer());
      const capture = JSON.parse(await archive.file('production-provider/capture.json')!.async('string'));
      expect(capture.snapshot.run.status).toBe('not-started');
      expect(capture.snapshot.requests[0].input).toEqual({ captureValue: 'undefined' });
      expect(capture.limitations.replayEligibility).toBe('not-established');
      const run = JSON.parse(await archive.file('run.json')!.async('string'));
      expect(run.productionProviderCapture).toEqual({ format: 'production-provider-capture-reference-v1', path: 'production-provider/capture.json' });
      expect(run.status).toBe(checkpoint.run.status);
      const manifest = JSON.parse(await archive.file('manifest.json')!.async('string'));
      expect(manifest.files).toContainEqual(expect.objectContaining({ path: 'production-provider/capture.json', byteLength: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }));
      await expect(verifyGeneratedEvidenceArchive({ blob })).resolves.toMatchObject({ runId: checkpoint.run.runId });
      expect(await archive.file('SUMMARY.md')!.async('string')).toContain('does not establish replay eligibility');
      archive.file('production-provider/capture.json', '{}');
      const corrupted = await archive.generateAsync({ type: 'blob' });
      await expect(verifyGeneratedEvidenceArchive({ blob: corrupted })).rejects.toThrow('mismatch');
    } finally {
      await owner.dispose();
    }
  });

  it('rejects a raw capture carrying extra private fields instead of copying it into run.json', async () => {
    const checkpoint = createInitialInvestigationCheckpoint({ modelId: 'org/provider', runId: 'zip-private', now: () => '2026-09-09T00:00:00.000Z' });
    const owner = createProductionProviderCaptureOwner({ runId: checkpoint.run.runId, modelId: checkpoint.run.modelId, plan: 'first-only',
      createWorkerClient: () => {
        throw new Error('Export must not create a Worker');
      }, traceLimits: { maximumEvents: 10, maximumCharacters: 100 },
    });
    try {
      const capture = { ...owner.snapshot(), privatePath: '/private/not-for-export' };
      checkpoint.run.productionProviderCapture = capture;
      await expect(createPartialModelSupportEvidence({ run: checkpoint.run, recovery: checkpoint.recovery })).rejects.toThrow(/^Invalid Production Provider capture evidence$/u);
    } finally {
      await owner.dispose();
    }
  });

  it('summarizes nested failures and selected blocked work independently of a passed collection boundary', async () => {
    const checkpoint = createInitialInvestigationCheckpoint({ modelId: 'org/nested', runId: 'nested', now: () => '2026-09-09T00:00:00.000Z' });
    checkpoint.run.status = 'passed';
    checkpoint.run.productionLane = { status: 'passed', observation: undefined, error: undefined, partialObservation: {
      modelId: 'org/nested', resolvedRevision: 'a'.repeat(40), candidate: undefined, route: undefined, isEncoderDecoder: undefined,
      firstTurn: { status: 'failed', error: { name: 'GenerationError', message: 'first turn failed' } },
      continuity: { status: 'not-run', reason: 'First turn did not generate' },
      toolResultContinuation: undefined, reasoning: undefined, multimodal: undefined,
    } };
    const { blob } = await createPartialModelSupportEvidence({ run: checkpoint.run, recovery: { ...checkpoint.recovery, status: 'completed' } });
    const archive = await JSZip.loadAsync(await blob.arrayBuffer());
    const summary = await archive.file('SUMMARY.md')!.async('string');
    expect(summary).toContain('production-first-turn: failed');
    expect(summary).toContain('GenerationError: first turn failed');
    expect(summary).toContain('production-continuity: not-run');
    expect(summary).toContain('First turn did not generate');
    expect(summary).toContain('does not certify');
    expect(JSON.parse(await archive.file('run.json')!.async('string')).status).toBe('passed');
  });

  it('exports a failed preparation stage separately from successful HTTP responses', async () => {
    const checkpoint = createInitialInvestigationCheckpoint({ modelId: 'org/model', runId: 'preparation-failure', now: () => '2026-09-09T00:00:00.000Z' });
    const run: ModelSupportInvestigationRun = { ...checkpoint.run, freshMetadata: {
      schemaVersion: 1, modelId: 'org/model', revision: 'a'.repeat(40), source: 'fresh-network-memory',
      status: 'failed', maximumBytes: 1024, receivedBytes: 2,
      preparationStage: 'configuration', failureCategory: 'syntax-error',
      requests: [{ consumer: 'runtime-preparation', path: 'config.json', request: 'full', httpStatus: 200, status: 'complete', receivedBytes: 2 }],
    } };
    const { blob } = await createPartialModelSupportEvidence({ run, recovery: checkpoint.recovery });
    const archive = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(JSON.parse(await archive.file('download-lane/fresh-metadata.json')!.async('string'))).toEqual(run.freshMetadata);
    const summary = await archive.file('SUMMARY.md')!.async('string');
    expect(summary).toContain('Fresh metadata preparation: failed');
    expect(summary).toContain('Fresh metadata preparation stage: configuration');
    expect(summary).toContain('Fresh metadata failure category: syntax-error');
  });

  it('exports fresh HTTP preparation separately without certifying full Download or Load', async () => {
    const checkpoint = createInitialInvestigationCheckpoint({ modelId: 'org/model', runId: 'fresh-metadata-export', now: () => '2026-09-09T00:00:00.000Z' });
    const run: ModelSupportInvestigationRun = { ...checkpoint.run, freshMetadata: {
      schemaVersion: 1, modelId: 'org/model', revision: 'a'.repeat(40), source: 'fresh-network-memory',
      status: 'prepared', maximumBytes: 1024, receivedBytes: 1,
      preparation: { processor: 'tokenizer', resourcePlansByCandidate: { 'webgpu/q4f16': { status: 'ready', paths: ['onnx/model_q4f16.onnx'] } } },
      requests: [{ consumer: 'runtime-preparation', path: 'config.json', request: 'size-probe', httpStatus: 206, contentRange: 'bytes 0-0/100', status: 'cancelled', receivedBytes: 1 }],
    } };
    const { blob } = await createPartialModelSupportEvidence({ run, recovery: checkpoint.recovery });
    const archive = await JSZip.loadAsync(await blob.arrayBuffer());
    const preparation = archive.file('download-lane/fresh-metadata.json');
    expect(preparation).not.toBeNull();
    expect(JSON.parse(await preparation!.async('string'))).toEqual(run.freshMetadata);
    const summary = await archive.file('SUMMARY.md')!.async('string');
    expect(summary).toContain('Fresh metadata preparation: prepared');
    expect(summary).toContain('does not certify a full model download or successful Load');
    expect(archive.file('production-lane/observation.json')).toBeNull();
  });

  it("exports factual partial evidence and preserves not-run stages", async () => {
    const run: ModelSupportInvestigationRun = {
      schemaVersion: 1,
      runId: "run-1",
      modelId: "hf.co/org/model",
      requestedConfiguration: {
        externalNetworkPolicy: "allow",
        scope: {
          "repository-download": "selected",
          "model-load": "not-selected",
          generation: "selected",
          continuity: "not-selected",
          "capability-probes": "not-selected",
        },
      },
      executionPlan: {
        repositoryDownload: true,
        modelLoad: true,
        generation: true,
        continuity: false,
        capabilityProbes: false,
      },
      scope: "partial-runtime-repository-cache-declarations-template-model-files",
      startedAt: "2026-08-06T00:00:00.000Z",
      completedAt: "2026-08-06T00:00:01.000Z",
      status: "passed",
      currentOperation: "verified",
      steps: [
        { id: "runtime-assets", status: "passed", detail: "verified" },
        { id: "repository-information", status: "not-run", detail: undefined },
        { id: "existing-model-data", status: "not-run", detail: undefined },
        { id: "model-declarations", status: "passed", detail: "declarations collected" },
        { id: "template-behavior", status: "passed", detail: "template evidence collected" },
        { id: "model-file-plan", status: "passed", detail: "model file plans collected" },
        { id: "loading-investigation", status: "not-run", detail: undefined },
        { id: "evidence-export", status: "not-run", detail: undefined },
      ],
      runtimeAssets: {
        variant: "asyncify",
        assetIdentity: runtimeAssetIdentity(),
        baseUrl: "https://naidan.example/transformers/",
        mjsUrl: "https://naidan.example/transformers/ort.mjs",
        wasmUrl: "https://naidan.example/transformers/ort.wasm",
        wasmByteLength: 4,
        mjsOrigin: "https://naidan.example",
        wasmOrigin: "https://naidan.example",
        applicationOrigin: "https://naidan.example",
        environment: {
          userAgent: "Browser/1",
          vendor: "Vendor",
          hardwareConcurrency: 8,
          deviceMemoryGiB: 16,
          crossOriginIsolated: true,
          webGpu: {
            availability: "available",
            adapterInfo: { vendor: "GPU Vendor" },
            features: ["shader-f16"],
            limits: { maxBufferSize: 1024 },
            error: undefined,
          },
        },
        control: {
          fixtureId: "identity-float32-v1",
          fixtureSha256: "19be871867d45a5bb90b850518b38262a67d14cfccc147f6566f15308c273443",
          executionProvider: "wasm",
          status: "passed",
          inputName: "x",
          outputName: "y",
          inputValue: 7,
          outputValue: 7,
          error: undefined,
        },
        webGpuControl: {
          fixtureId: "identity-float32-v1",
          fixtureSha256: "19be871867d45a5bb90b850518b38262a67d14cfccc147f6566f15308c273443",
          executionProvider: "webgpu",
          status: "passed",
          inputName: "x",
          outputName: "y",
          inputValue: 7,
          outputValue: 7,
          error: undefined,
        },
      },
      repository: {
        requestedModelId: "hf.co/org/model",
        normalizedModelId: "org/model",
        requestedRevision: "main",
        resolvedRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        apiUrl: "https://huggingface.co/api/models/org/model/revision/main?blobs=true",
        responseUrl: "https://huggingface.co/api/models/org/model/revision/main?blobs=true",
        fileCount: 0,
        files: [],
        pipelineTag: undefined,
        libraryName: undefined,
        metadata: {},
      },
      runtimeTarget: {
        normalizedModelId: "org/model",
        evidenceRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        loaderRevisionOption: null,
        source: "repository",
        revisionIdentity: "exact-resolved-revision",
        pipelineTag: undefined,
      },
      downloadEvidence: {
        schemaVersion: 1,
        runId: "run-1",
        mode: "probe-only",
        run: {
          modelId: "hf.co/org/model",
          normalizedModelId: "org/model",
          requestedRevision: "main",
          resolvedRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          repositoryFileCount: 2,
          repositoryFiles: [
            { path: "onnx/model_q4.onnx", size: 100, blobId: undefined, lfsOid: undefined, lfsSha256: undefined, lfsSize: undefined },
            { path: "onnx/model_q4.onnx_data", size: 200, blobId: undefined, lfsOid: undefined, lfsSha256: undefined, lfsSize: undefined },
          ],
          transportObservations: [{
            path: "onnx/model_q4.onnx_data",
            method: "HEAD",
            status: 200,
            redirected: false,
            finalUrl: "https://huggingface.co/org/model/resolve/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/onnx/model_q4.onnx_data",
            finalOrigin: "https://huggingface.co",
            contentLength: 200,
            contentRange: undefined,
            acceptRanges: "bytes",
            contentType: "application/octet-stream",
            etag: undefined,
            rangeHonored: undefined,
            bytesConsumed: 0,
            abortedByByteBudget: false,
            error: undefined,
          }],
          skippedModelArtifactCount: 0,
          bytesConsumed: 0,
          maximumBytes: 2 * 1024 * 1024,
          startedAt: "2026-08-06T00:00:00.100Z",
          finishedAt: "2026-08-06T00:00:00.200Z",
        },
        modelArtifactObservations: [{
          modelId: "org/model",
          revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          autoClass: "AutoModelForCausalLM",
          candidate: { device: "webgpu", dtype: "q4" },
          status: "observed",
          observationMethod: "held-model-artifact-fetch-quiescence",
          quiescenceMs: 100,
          timeoutMs: 1000,
          paths: ["onnx/model_q4.onnx", "onnx/model_q4.onnx_data"],
          requests: [
            { path: "onnx/model_q4.onnx", url: "https://huggingface.co/org/model/resolve/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/onnx/model_q4.onnx" },
            { path: "onnx/model_q4.onnx_data", url: "https://huggingface.co/org/model/resolve/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/onnx/model_q4.onnx_data" },
          ],
          error: undefined,
        }],
        modelArtifactObservationError: undefined,
        cacheBefore: undefined,
        cacheInspectionError: undefined,
      },
      cache: {
        normalizedModelId: "org/model",
        rootPath: "models/huggingface.co/org/model",
        exists: false,
        revisionProvenance: "unknown",
        revisionProvenanceReason: "The cache path records a requested revision segment, but completion markers do not independently verify file bytes against the resolved Hugging Face commit SHA",
        totalBytes: 0,
        fileCount: 0,
        completionMarkerCount: 0,
        incompleteFileCount: 0,
        orphanCompletionMarkerCount: 0,
        orphanCompletionMarkerPaths: [],
        zeroByteFileCount: 0,
        weightFileCount: 0,
        allFilesHaveCompletionMarkers: false,
        files: [],
        provenance: {
          schemaVersion: 1,
          method: "bounded-range-sha256-v1",
          resolvedRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          rangeBytes: 32 * 1024,
          maximumFileCount: 3,
          status: "not-observed",
          confidence: "none",
          files: [],
          reason: "No exact-revision cache file was eligible for bounded sampling",
        },
      },
      declarations: {
        normalizedModelId: "org/model",
        resolvedRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        files: [],
        fileFailures: [],
        config: { model_type: "new_chat_model" },
        modelType: "new_chat_model",
        architectures: ["NewChatForCausalLM"],
        autoMap: undefined,
        transformersJsConfig: undefined,
        classCapabilities: [{
          autoClass: "AutoModelForCausalLM",
          supports: true,
          notEvaluatedReason: undefined,
        }],
      },
      templateBehavior: {
        normalizedModelId: "org/model",
        resolvedRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        tokenizerClass: "ProbeTokenizer",
        declaredChatTemplate: "{{ messages }}",
        cases: [],
      },
      modelFilePlan: {
        normalizedModelId: "org/model",
        resolvedRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        modelType: "new_chat_model",
        registrySource: "ModelRegistry.get_model_files",
        cacheRevisionProvenance: "unknown",
        cacheRevisionProvenanceReason: "The cache path records a requested revision segment, but completion markers do not independently verify file bytes against the resolved Hugging Face commit SHA",
        candidates: [],
      },
      loadAttempts: [],
      productionLane: { status: "not-run", observation: undefined, partialObservation: undefined, error: undefined },
      laneComparison: undefined,
      persistenceRoundTrip: {
        status: 'observed',
        fixtureId: 'tool-call-history-v1',
        method: 'chat-content-dto-json-roundtrip-v1',
        serializedByteLength: 128,
        serializedSha256: 'b'.repeat(64),
        originalMessages: [{ role: 'user', content: 'fixture', tool_calls: undefined, tool_call_id: undefined }],
        restoredMessages: [{ role: 'user', content: 'fixture', tool_calls: undefined, tool_call_id: undefined }],
        exactModelVisibleMatch: true,
        firstMismatchIndex: undefined,
      },
      error: undefined,
    };

    const { blob, fileName } = await createPartialModelSupportEvidence({ run, recovery: undefined });
    const archive = await JSZip.loadAsync(await blob.arrayBuffer());
    const parsed = JSON.parse(await archive.file("run.json")!.async("text"));

    expect(fileName).toContain("hf.co-org-model");
    expect(archive.file("SUMMARY.md")).not.toBeNull();
    expect(archive.file("READINESS.md")).not.toBeNull();
    expect(archive.file("PACKAGE.md")).not.toBeNull();
    expect(archive.file("package-assessment.json")).not.toBeNull();
    expect(archive.file("readiness.json")).not.toBeNull();
    expect(archive.file("questions.json")).not.toBeNull();
    expect(archive.file("manifest.json")).not.toBeNull();
    expect(archive.file("errors.json")).not.toBeNull();
    expect(archive.file("events.jsonl")).not.toBeNull();
    expect(archive.file("support-boundaries.json")).not.toBeNull();
    expect(archive.file("runtime-assets/preflight.json")).not.toBeNull();
    expect(archive.file("runtime-assets/asset-identity.json")).not.toBeNull();
    expect(archive.file("runtime-assets/environment.json")).not.toBeNull();
    expect(archive.file("runtime-assets/backend-controls.json")).not.toBeNull();
    expect(archive.file("repository/repository.json")).not.toBeNull();
    expect(archive.file("execution-policy/policy.json")).not.toBeNull();
    expect(JSON.parse(await archive.file("execution-policy/policy.json")!.async("text"))).toEqual({
      requestedConfiguration: run.requestedConfiguration,
      effectiveExecutionPlan: run.executionPlan,
    });
    expect(archive.file("runtime-target/target.json")).not.toBeNull();
    expect(JSON.parse(await archive.file("runtime-target/target.json")!.async("text"))).toMatchObject({
      source: "repository",
      evidenceRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      revisionIdentity: "exact-resolved-revision",
    });
    expect(archive.file("download-lane/repository.json")).not.toBeNull();
    expect(archive.file("download-lane/artifact-requests.json")).not.toBeNull();
    expect(archive.file("download-lane/transport.json")).not.toBeNull();
    expect(archive.file("download-lane/candidates.json")).not.toBeNull();
    expect(archive.file("download-lane/test-readiness.json")).not.toBeNull();
    expect(archive.file("cache/inventory.json")).not.toBeNull();
    expect(archive.file("cache/provenance.json")).not.toBeNull();
    expect(archive.file("model/declarations.json")).not.toBeNull();
    expect(archive.file("runtime-assets/class-capabilities.json")).not.toBeNull();
    expect(archive.file("template-behavior/matrix.json")).not.toBeNull();
    expect(archive.file("model-files/plans.json")).not.toBeNull();
    expect(archive.file("continuity/persistence-roundtrip.json")).not.toBeNull();
    expect(JSON.parse(await archive.file("continuity/persistence-roundtrip.json")!.async("text"))).toMatchObject({
      status: 'observed', exactModelVisibleMatch: true,
    });
    expect(parsed.steps[1].status).toBe("not-run");
    expect(archive.file("load-attempts/index.json")).toBeNull();
    expect(archive.file("protocol-probes/tool.json")).toBeNull();
    const packageAssessment = JSON.parse(
      await archive.file("package-assessment.json")!.async("text"),
    ) as ModelSupportInvestigationEvidencePackageAssessment;
    expect(packageAssessment.status).not.toBe("invalid");
    expect(packageAssessment.missingRequiredCoreFiles).toEqual([]);
    expect(packageAssessment.missingReferencedEvidencePaths).toEqual([]);
    expect(await archive.file("SUMMARY.md")!.async("text")).toContain(`Package self-assessment: ${packageAssessment.status}`);
    const manifest = JSON.parse(await archive.file("manifest.json")!.async("text"));
    expect(manifest.files).toContainEqual(expect.objectContaining({
      path: "run.json",
      byteLength: expect.any(Number),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    }));
    const runText = await archive.file("run.json")!.async("text");
    const runDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(runText));
    const expectedRunSha256 = [...new Uint8Array(runDigest)]
      .map(value => value.toString(16).padStart(2, "0"))
      .join("");
    expect(manifest.files.find((item: { path: string }) => item.path === "run.json").sha256).toBe(expectedRunSha256);
    expect(manifest.files.some((item: { path: string }) => item.path === "manifest.json")).toBe(false);
    const archivePaths = Object.entries(archive.files)
      .filter(([path, file]) => path !== "manifest.json" && !file.dir)
      .map(([path]) => path)
      .sort();
    expect(manifest.files.map((item: { path: string }) => item.path).sort()).toEqual(archivePaths);
    for (const item of manifest.files as Array<{ path: string, byteLength: number, sha256: string }>) {
      const file = archive.file(item.path);
      expect(file, `manifest path ${item.path}`).not.toBeNull();
      const bytes = await file!.async("uint8array");
      expect(bytes.byteLength, item.path).toBe(item.byteLength);
      const digestInput = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(digestInput).set(bytes);
      const digest = await crypto.subtle.digest("SHA-256", digestInput);
      const sha256 = [...new Uint8Array(digest)]
        .map(value => value.toString(16).padStart(2, "0"))
        .join("");
      expect(sha256, item.path).toBe(item.sha256);
    }
    const questions = JSON.parse(await archive.file("questions.json")!.async("text"));
    expect(questions).toContainEqual(expect.objectContaining({ domainId: "runtime-assets" }));
    const readiness = JSON.parse(await archive.file("readiness.json")!.async("text"));
    expect(readiness.domains).toContainEqual(expect.objectContaining({
      domainId: "download",
      questions: expect.arrayContaining([expect.objectContaining({
        answer: expect.stringContaining("revision=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        evidencePaths: expect.arrayContaining([
          "download-lane/repository.json",
          "download-lane/artifact-requests.json",
          "download-lane/test-readiness.json",
        ]),
      })]),
    }));
    const supportBoundaries = JSON.parse(await archive.file("support-boundaries.json")!.async("text"));
    const referencedPaths = [
      ...questions.flatMap((question: { evidencePaths: string[] }) => question.evidencePaths),
      ...supportBoundaries.flatMap((assessment: { evidencePaths: string[], contradictoryEvidencePaths: string[] }) => [
        ...assessment.evidencePaths,
        ...assessment.contradictoryEvidencePaths,
      ]),
    ];
    for (const path of referencedPaths) expect(archive.file(path), path).not.toBeNull();

    const secondRun = structuredClone(run);
    secondRun.runId = "run-2";
    secondRun.modelId = "org/second";
    const batchEvidence = await createBatchModelSupportEvidence({
      batchId: "batch-1",
      items: [
        {
          target: run.modelId,
          status: "passed",
          run,
          recovery: undefined,
          error: undefined,
        },
        {
          target: secondRun.modelId,
          status: "passed",
          run: secondRun,
          recovery: undefined,
          error: undefined,
        },
        {
          target: "org/pending",
          status: "pending",
          run: undefined,
          recovery: undefined,
          error: undefined,
        },
      ],
    });
    const batchArchive = await JSZip.loadAsync(await batchEvidence.blob.arrayBuffer());
    const batchIndex = JSON.parse(await batchArchive.file("batch.json")!.async("text")) as {
      targetCount: number,
      packagedModelCount: number,
      targets: Array<{ target: string, evidencePath?: string }>,
    };
    expect(batchEvidence.fileName).toBe("model-support-investigation-batch-batch-1.zip");
    expect(batchIndex.targetCount).toBe(3);
    expect(batchIndex.packagedModelCount).toBe(2);
    expect(batchIndex.targets.map(target => target.target)).toEqual([
      run.modelId,
      secondRun.modelId,
      "org/pending",
    ]);
    for (const target of batchIndex.targets.slice(0, 2)) {
      expect(target.evidencePath).toEqual(expect.any(String));
      expect(batchArchive.file(`${target.evidencePath}run.json`)).not.toBeNull();
      expect(batchArchive.file(`${target.evidencePath}manifest.json`)).not.toBeNull();
      expect(batchArchive.file(`${target.evidencePath}PACKAGE.md`)).not.toBeNull();
    }
    expect(batchIndex.targets[2]?.evidencePath).toBeUndefined();
    expect(batchArchive.file("manifest.json")).not.toBeNull();

    const failedWasmRun = structuredClone(run);
    failedWasmRun.status = "failed";
    failedWasmRun.error = "Wasm session failed";
    failedWasmRun.steps = failedWasmRun.steps.map(step => step.id === "runtime-assets"
      ? { ...step, status: "failed", detail: "Wasm session failed" }
      : step);
    if (failedWasmRun.runtimeAssets === undefined) throw new Error("Expected runtime fixture");
    failedWasmRun.runtimeAssets.control = {
      ...failedWasmRun.runtimeAssets.control,
      status: "failed",
      outputValue: undefined,
      error: "Wasm session failed",
    };
    const failedWasmEvidence = await createPartialModelSupportEvidence({ run: failedWasmRun, recovery: undefined });
    const failedWasmArchive = await JSZip.loadAsync(await failedWasmEvidence.blob.arrayBuffer());
    const backendControls = JSON.parse(await failedWasmArchive.file("runtime-assets/backend-controls.json")!.async("text"));
    expect(backendControls.wasm).toMatchObject({ status: "failed", error: "Wasm session failed" });
    expect(backendControls.webgpu).toMatchObject({ status: "passed", outputValue: 7 });
    const failedWasmAssessment = JSON.parse(await failedWasmArchive.file("package-assessment.json")!.async("text"));
    expect(failedWasmAssessment.status).not.toBe("invalid");
    const failedWasmReadiness = JSON.parse(await failedWasmArchive.file("readiness.json")!.async("text"));
    expect(failedWasmReadiness.domains).toContainEqual(expect.objectContaining({
      domainId: "runtime-assets",
      status: "insufficient",
    }));
    const failedWasmBoundaries = JSON.parse(await failedWasmArchive.file("support-boundaries.json")!.async("text"));
    expect(failedWasmBoundaries).toContainEqual(expect.objectContaining({
      assessmentId: "runtime-integrity-failed",
      boundary: "environment-runtime",
    }));
  });

  it("exports each real-model load attempt and updates the factual summary", async () => {
    const run: ModelSupportInvestigationRun = {
      schemaVersion: 1,
      runId: "run-load",
      modelId: "org/model",
      scope: "partial-runtime-repository-cache-declarations-template-model-files-load",
      startedAt: "2026-08-06T00:00:00.000Z",
      completedAt: "2026-08-06T00:01:00.000Z",
      status: "passed",
      currentOperation: "Minimum real-model generation evidence collected",
      steps: [],
      runtimeAssets: undefined,
      repository: undefined,
      runtimeTarget: undefined,
      downloadEvidence: undefined,
      cache: undefined,
      declarations: undefined,
      templateBehavior: undefined,
      modelFilePlan: undefined,
      loadAttempts: [{
        attemptId: "attempt/1",
        candidateId: "webgpu-q4",
        device: "webgpu",
        dtype: "q4",
        autoClass: "AutoModelForCausalLM",
        resolvedRevision: "a".repeat(40),
        loaderRevisionOption: null,
        startedAt: "2026-08-06T00:00:10.000Z",
        completedAt: "2026-08-06T00:00:20.000Z",
        status: "failed",
        failureStage: "model-load",
        events: [{
          stage: "model-load",
          status: "failed",
          detail: "model load failed",
          at: "2026-08-06T00:00:15.000Z",
        }],
        inputStrategyAttempts: [],
        selectedInputStrategy: undefined,
        inputTokenCount: 2,
        inputTokenIds: [1, 2],
        inputTensors: [],
        loadedModel: undefined,
        generatedTokenIds: [42],
        generatedText: "answer",
        naturalGeneration: undefined,
        toolProtocolProbe: undefined,
        postAttemptCache: {
          status: "observed",
          inventory: {
            normalizedModelId: "org/model",
            rootPath: "models/huggingface.co/org/model",
            exists: true,
            revisionProvenance: "unknown",
            revisionProvenanceReason: "The cache path records a requested revision segment, but completion markers do not independently verify file bytes against the resolved Hugging Face commit SHA",
            totalBytes: 64,
            fileCount: 1,
            completionMarkerCount: 1,
            incompleteFileCount: 0,
            orphanCompletionMarkerCount: 0,
            orphanCompletionMarkerPaths: [],
            zeroByteFileCount: 0,
            weightFileCount: 1,
            allFilesHaveCompletionMarkers: true,
            files: [{
              path: "onnx/model_q4.onnx",
              repositoryPath: "onnx/model_q4.onnx",
              size: 64,
              lastModified: 1,
              hasCompletionMarker: true,
              isWeightFile: true,
            }],
          },
          requiredFileCoverage: {
            expectedPaths: ["onnx/model_q4.onnx"],
            completePaths: ["onnx/model_q4.onnx"],
            sizeMismatchPaths: [],
            incompletePaths: [],
            missingPaths: [],
            revisionProvenance: "unknown",
          },
        },
        modelType: "llama",
        error: {
          name: "Error",
          message: "model load failed",
          stack: "stack",
        },
      }],
      productionLane: { status: "not-run", observation: undefined, partialObservation: undefined, error: undefined },
      laneComparison: undefined,
      persistenceRoundTrip: {
        status: "observed", fixtureId: "tool-call-history-v1", method: "chat-content-dto-json-roundtrip-v1",
        serializedByteLength: 128, serializedSha256: "b".repeat(64),
        originalMessages: [{ role: "user", content: "fixture", tool_calls: undefined, tool_call_id: undefined }],
        restoredMessages: [{ role: "user", content: "fixture", tool_calls: undefined, tool_call_id: undefined }],
        exactModelVisibleMatch: true, firstMismatchIndex: undefined,
      },
      error: undefined,
    };

    const { blob } = await createPartialModelSupportEvidence({ run, recovery: undefined });
    const archive = await JSZip.loadAsync(await blob.arrayBuffer());
    const summary = await archive.file("SUMMARY.md")!.async("text");

    expect(archive.file("load-attempts/index.json")).not.toBeNull();
    expect(archive.file("load-attempts/attempt-1.json")).not.toBeNull();
    expect(summary).toContain("1 real-model load attempt was recorded");
    expect(summary).not.toContain("Model loading, generation, and continuity stages marked not-run");
    const errors = JSON.parse(await archive.file("errors.json")!.async("text"));
    expect(errors.loadAttemptErrors).toContainEqual(expect.objectContaining({
      attemptId: "attempt/1",
      failureStage: "model-load",
    }));
    expect(await archive.file("events.jsonl")!.async("text")).toContain('"attemptId":"attempt/1"');
    const attempt = JSON.parse(await archive.file("load-attempts/attempt-1.json")!.async("text"));
    expect(attempt).toMatchObject({
      resolvedRevision: "a".repeat(40),
      loaderRevisionOption: null,
    });
    expect(attempt.postAttemptCache).toEqual(expect.objectContaining({
      status: "observed",
      inventory: expect.objectContaining({ fileCount: 1, completionMarkerCount: 1 }),
      requiredFileCoverage: {
        expectedPaths: ["onnx/model_q4.onnx"],
        completePaths: ["onnx/model_q4.onnx"],
        sizeMismatchPaths: [],
        incompletePaths: [],
        missingPaths: [],
        revisionProvenance: "unknown",
      },
    }));
    const readiness = JSON.parse(await archive.file("readiness.json")!.async("text"));
    expect(readiness.domains).toContainEqual(expect.objectContaining({
      domainId: "cache",
      status: "partial",
    }));

    const [sourceAttempt] = run.loadAttempts;
    if (sourceAttempt === undefined) throw new Error("Expected a load attempt fixture");
    const failedCacheRun: ModelSupportInvestigationRun = {
      ...run,
      runId: "run-load-cache-inspection-failed",
      loadAttempts: [{
        ...sourceAttempt,
        postAttemptCache: {
          status: "failed",
          error: { name: "CacheInspectionError", message: "post-load cache inspection failed", stack: undefined },
        },
      }],
    };
    const { blob: failedCacheBlob } = await createPartialModelSupportEvidence({ run: failedCacheRun, recovery: undefined });
    const failedCacheArchive = await JSZip.loadAsync(await failedCacheBlob.arrayBuffer());
    const failedCacheErrors = JSON.parse(await failedCacheArchive.file("errors.json")!.async("text"));
    expect(failedCacheErrors.postAttemptCacheErrors).toContainEqual(expect.objectContaining({
      attemptId: "attempt/1",
      candidateId: "webgpu-q4",
      error: expect.objectContaining({ name: "CacheInspectionError" }),
    }));

    const activeRun: ModelSupportInvestigationRun = {
      ...run,
      runId: "run-active-load-checkpoint",
      status: "failed",
      currentOperation: "webgpu-q4: first-generation running",
      loadAttempts: [],
      activeLoadAttempt: {
        attemptId: "active/1",
        candidateId: "webgpu-q4",
        device: "webgpu",
        dtype: "q4",
        autoClass: "AutoModelForCausalLM",
        resolvedRevision: "a".repeat(40),
        startedAt: "2026-08-06T00:00:10.000Z",
        checkpointedAt: "2026-08-06T00:00:15.000Z",
        status: "running",
        currentStage: "first-generation",
        events: [{
          stage: "model-load",
          status: "passed",
          detail: "webgpu-q4: model loaded",
          at: "2026-08-06T00:00:14.000Z",
        }],
        inputStrategyAttempts: [{
          strategy: "chat-template-tensor-dict",
          status: "failed",
          failureStage: "first-generation",
          inputTokenIds: [1, 2],
          inputTensors: [{ name: "input_ids", dtype: "int64", dims: [1, 2], location: "cpu" }],
          error: { name: "TypeError", message: "first input strategy failed", stack: undefined },
        }],
        activeInputStrategy: "observed-token-ids-transformers-tensor",
        selectedInputStrategy: undefined,
        inputTokenCount: 2,
        inputTokenIds: [1, 2],
        inputTensors: [{ name: "input_ids", dtype: "int64", dims: [1, 2], location: "cpu" }],
        loadedModel: {
          modelType: "llama",
          isEncoderDecoder: false,
          sessions: [{ name: "model", inputNames: ["input_ids"], outputNames: ["logits"] }],
          sessionFileCorrelations: [{
            sessionName: "model",
            status: "exact",
            matchBasis: "exact-session-name-to-core-onnx-basename",
            coreFilePaths: ["onnx/model_q4.onnx"],
            externalDataPaths: ["onnx/model_q4.onnx_data"],
          }],
          effectiveMinimumGenerationConfig: {
            maxNewTokens: 1,
            doSample: false,
            bosTokenId: 1,
            eosTokenId: 2,
            padTokenId: 0,
            decoderStartTokenId: undefined,
          },
        },
        generatedTokenIds: [],
        generatedText: undefined,
        naturalGeneration: undefined,
        toolProtocolProbe: undefined,
        modelType: "llama",
        error: undefined,
      },
      error: "Candidate is still running at the exported checkpoint",
    };
    const { blob: activeBlob } = await createPartialModelSupportEvidence({ run: activeRun, recovery: undefined });
    const activeArchive = await JSZip.loadAsync(await activeBlob.arrayBuffer());
    expect(activeArchive.file("load-attempts/index.json")).toBeNull();
    expect(activeArchive.file("load-attempts/active.json")).not.toBeNull();
    const activeAttempt = JSON.parse(await activeArchive.file("load-attempts/active.json")!.async("text"));
    expect(activeAttempt).toMatchObject({
      attemptId: "active/1",
      status: "running",
      currentStage: "first-generation",
      activeInputStrategy: "observed-token-ids-transformers-tensor",
      loadedModel: {
        sessions: [{ name: "model", inputNames: ["input_ids"], outputNames: ["logits"] }],
        sessionFileCorrelations: [{
          status: "exact",
          coreFilePaths: ["onnx/model_q4.onnx"],
          externalDataPaths: ["onnx/model_q4.onnx_data"],
        }],
      },
    });
    const activeSummary = await activeArchive.file("SUMMARY.md")!.async("text");
    expect(activeSummary).toContain("webgpu-q4 is checkpointed while first-generation is still running");
    expect(activeSummary).not.toContain("Model loading and generation stages marked not-run");
    const activeEvents = await activeArchive.file("events.jsonl")!.async("text");
    expect(activeEvents).toContain('"attemptId":"active/1"');
    expect(activeEvents).toContain('"stage":"model-load"');
    const activeErrors = JSON.parse(await activeArchive.file("errors.json")!.async("text"));
    expect(activeErrors.inputStrategyErrors).toContainEqual(expect.objectContaining({
      attemptId: "active/1",
      strategy: "chat-template-tensor-dict",
      failureStage: "first-generation",
      error: expect.objectContaining({ message: "first input strategy failed" }),
    }));
    const activeReadiness = JSON.parse(await activeArchive.file("readiness.json")!.async("text"));
    expect(activeReadiness.domains).toContainEqual(expect.objectContaining({
      domainId: "runtime-load",
      status: "implementation-ready",
      questions: [expect.objectContaining({
        evidencePaths: ["load-attempts/active.json"],
      })],
    }));
    const activeAssessment = JSON.parse(await activeArchive.file("package-assessment.json")!.async("text"));
    expect(activeAssessment.status).not.toBe("invalid");
  });

  it("exports Production Lane observations and Reference token comparison as separate primary evidence", async () => {
    const base: ModelSupportInvestigationRun = {
      schemaVersion: 1,
      runId: "run-lanes",
      modelId: "org/model",
      scope: "partial-runtime-repository-cache-declarations-template-model-files-load-lanes",
      startedAt: "2026-08-06T00:00:00.000Z",
      completedAt: "2026-08-06T00:01:00.000Z",
      status: "passed",
      currentOperation: "Lane comparison evidence collected",
      steps: [],
      runtimeAssets: undefined,
      repository: undefined,
      runtimeTarget: undefined,
      downloadEvidence: undefined,
      cache: undefined,
      declarations: undefined,
      templateBehavior: undefined,
      modelFilePlan: undefined,
      loadAttempts: [{
        attemptId: "reference-attempt",
        candidateId: "webgpu-q4",
        device: "webgpu",
        dtype: "q4",
        autoClass: "AutoModelForCausalLM",
        resolvedRevision: "a".repeat(40),
        startedAt: "2026-08-06T00:00:10.000Z",
        completedAt: "2026-08-06T00:00:20.000Z",
        status: "passed",
        failureStage: undefined,
        events: [],
        inputStrategyAttempts: [],
        selectedInputStrategy: undefined,
        inputTokenCount: 2,
        inputTokenIds: [1, 2],
        inputTensors: [],
        loadedModel: undefined,
        generatedTokenIds: [3],
        generatedText: "reference",
        naturalGeneration: undefined,
        toolProtocolProbe: {
          status: "observed",
          forced: true,
          source: "chat-template-render",
          generationCaseId: "tools-generation",
          assistantToolCallCaseId: "assistant-tool-call-history",
          toolResultContinuationCaseId: "tool-result-continuation",
          inputTokenIds: [1, 2],
          forcedTokenIds: [3, 4],
          generatedTokenIds: [3, 4],
          generatedText: "tool call",
          exactMatch: true,
          firstMismatchIndex: undefined,
          termination: "complete-forced-sequence",
          parserObservation: {
            status: "observed",
            strategy: "standard",
            parserKind: "standard-tool-call-stream-parser",
            inputMode: "production-text-streamer-reconstruction",
            inputChunks: ["<tool_call>{\"name\":\"lookup_weather\",\"arguments\":{}}</tool_call>"],
            visibleText: "",
            callBoundaryCount: undefined,
            toolCalls: [{ name: "lookup_weather", arguments: "{}" }],
            recognized: true,
          },
        },
        modelType: "model",
        error: undefined,
      }],
      productionLane: {
        status: "passed",
        observation: {
          modelId: "org/model",
          resolvedRevision: "a".repeat(40),
          loaderRevisionOption: null,
          candidate: { device: "webgpu", dtype: "q4" },
          loadAttempts: [
            { candidate: { device: "webgpu", dtype: "q4f16" }, status: "failed", error: { name: "Error", message: "q4f16 load failed", stack: "stack-q4f16" } },
            { candidate: { device: "webgpu", dtype: "q4" }, status: "passed", error: undefined },
          ],
          route: { autoClass: "AutoModelForCausalLM", processor: "tokenizer", strategy: "standard", modelType: "model" },
          isEncoderDecoder: false,
          firstTurn: {
            status: "passed",
            turn: {
              messages: [{ role: "user", content: "hello" }],
              inputKeys: ["input_ids"],
              inputTensors: [],
              inputTokenIds: [1, 2],
              fullConversationInput: { status: "unavailable", reason: "test fixture does not observe reconstructed full conversation input" },
              cacheDecision: { status: "unavailable", reason: "test fixture does not observe cache decision" },
              pastKeyValuesProvided: false,
              inputPastKeyValuesSummary: { kind: "nullish", valueType: "undefined", constructorName: undefined, ownKeyCount: 0, ownKeys: [], arrayLength: undefined, truncated: false },
              outputPastKeyValuesSummary: { kind: "object", valueType: "object", constructorName: "Object", ownKeyCount: 1, ownKeys: ["layer_0"], arrayLength: undefined, truncated: false },
              generatedSequenceTokenIds: [1, 2, 4],
              generatedTokenIds: [4],
              generatedText: "production",
              streamChunks: ["production"],
              toolCalls: [],
              effectiveGenerationConfig: { maxNewTokens: 16, temperature: 0, topP: 1, doSample: false },
            },
          },
          continuity: {
            status: "passed",
            assistantMessage: { role: "assistant", content: "production" },
            followUpMessage: { role: "user", content: "Continue with one short sentence." },
            secondTurn: {
              messages: [
                { role: "user", content: "hello" },
                { role: "assistant", content: "production" },
                { role: "user", content: "Continue with one short sentence." },
              ],
              inputKeys: ["input_ids"],
              inputTensors: [],
              inputTokenIds: [3, 4],
              fullConversationInput: { status: "observed", inputTokenIds: [1, 9, 10] },
              cacheDecision: { status: "reused", reason: "qwen3_5-no-tool-continuation" },
              pastKeyValuesProvided: true,
              inputPastKeyValuesSummary: { kind: "object", valueType: "object", constructorName: "Object", ownKeyCount: 1, ownKeys: ["layer_0"], arrayLength: undefined, truncated: false },
              outputPastKeyValuesSummary: { kind: "object", valueType: "object", constructorName: "Object", ownKeyCount: 1, ownKeys: ["layer_0"], arrayLength: undefined, truncated: false },
              generatedSequenceTokenIds: [3, 4, 5],
              generatedTokenIds: [5],
              generatedText: "continued",
              streamChunks: ["continued"],
              toolCalls: [],
              effectiveGenerationConfig: { maxNewTokens: 16, temperature: 0, topP: 1, doSample: false },
            },
            prefixComparison: {
              mode: "full-input-prefix",
              expectedPrefixTokenIds: [1, 2, 4],
              secondInputTokenIds: [3, 4],
              reconstructedFullInputTokenIds: [1, 9, 10],
              comparisonInputSource: "reconstructed-full-conversation",
              exactPrefixMatch: false,
              firstMismatchIndex: 1,
              firstMismatchContext: {
                startIndex: 0,
                expectedTokenIds: [1, 2, 4],
                actualTokenIds: [1, 9, 10],
                expectedText: "expected prefix",
                actualText: "actual reconstructed prefix",
              },
            },
          },
          toolResultContinuation: {
            status: "passed",
            source: "reference-parser-roundtrip",
            strategy: "standard",
            messages: [],
            expectedInputTokenIds: [50, 51, 52],
            comparisonInputSource: "actual-model-input",
            inputTokenExactMatch: true,
            firstInputMismatchIndex: undefined,
            turn: {
              messages: [],
              inputKeys: ["input_ids"],
              inputTensors: [],
              inputTokenIds: [50, 51, 52],
              fullConversationInput: { status: "unavailable", reason: "test fixture does not observe reconstructed full conversation input" },
              cacheDecision: { status: "unavailable", reason: "test fixture does not observe cache decision" },
              pastKeyValuesProvided: false,
              inputPastKeyValuesSummary: { kind: "nullish", valueType: "undefined", constructorName: undefined, ownKeyCount: 0, ownKeys: [], arrayLength: undefined, truncated: false },
              outputPastKeyValuesSummary: { kind: "object", valueType: "object", constructorName: "Object", ownKeyCount: 1, ownKeys: ["layer_0"], arrayLength: undefined, truncated: false },
              generatedSequenceTokenIds: [50, 51, 52, 60],
              generatedTokenIds: [60],
              generatedText: "continued",
              streamChunks: ["continued"],
              toolCalls: [],
              effectiveGenerationConfig: { maxNewTokens: 16, temperature: 0, topP: 1, doSample: false },
            },
          },
          reasoning: {
            status: "observed",
            source: "existing-production-strategy",
            strategy: "qwen3_5",
            disabledEffort: "none",
            enabledEffort: "high",
            disabledTurn: {
              messages: [], inputKeys: ["input_ids"], inputTensors: [], inputTokenIds: [70, 0], fullConversationInput: { status: "unavailable", reason: "test fixture does not observe reconstructed full conversation input" }, cacheDecision: { status: "unavailable", reason: "test fixture does not observe cache decision" }, pastKeyValuesProvided: false,
              inputPastKeyValuesSummary: { kind: "nullish", valueType: "undefined", constructorName: undefined, ownKeyCount: 0, ownKeys: [], arrayLength: undefined, truncated: false },
              outputPastKeyValuesSummary: { kind: "nullish", valueType: "undefined", constructorName: undefined, ownKeyCount: 0, ownKeys: [], arrayLength: undefined, truncated: false },
              generatedSequenceTokenIds: [70, 0, 80], generatedTokenIds: [80], generatedText: "none", streamChunks: ["none"], toolCalls: [],
              effectiveGenerationConfig: { maxNewTokens: 16, temperature: 0, topP: 1, doSample: false },
            },
            enabledTurn: {
              messages: [], inputKeys: ["input_ids"], inputTensors: [], inputTokenIds: [70, 1], fullConversationInput: { status: "unavailable", reason: "test fixture does not observe reconstructed full conversation input" }, cacheDecision: { status: "unavailable", reason: "test fixture does not observe cache decision" }, pastKeyValuesProvided: false,
              inputPastKeyValuesSummary: { kind: "nullish", valueType: "undefined", constructorName: undefined, ownKeyCount: 0, ownKeys: [], arrayLength: undefined, truncated: false },
              outputPastKeyValuesSummary: { kind: "nullish", valueType: "undefined", constructorName: undefined, ownKeyCount: 0, ownKeys: [], arrayLength: undefined, truncated: false },
              generatedSequenceTokenIds: [70, 1, 81], generatedTokenIds: [81], generatedText: "high", streamChunks: ["high"], toolCalls: [],
              effectiveGenerationConfig: { maxNewTokens: 16, temperature: 0, topP: 1, doSample: false },
            },
            inputTokenExactMatch: false,
            firstInputMismatchIndex: 1,
          },
          multimodal: {
            status: "observed",
            source: "fixed-synthetic-fixture-and-existing-production-strategy",
            strategy: "gemma4",
            fixture: {
              fixtureId: "single-transparent-pixel-png-v1",
              sha256: "431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460",
              mimeType: "image/png",
              width: 1,
              height: 1,
              byteLength: 68,
              generationMethod: "embedded-fixed-png-bytes",
              prompt: "Describe the single synthetic image in one short phrase.",
              maxNewTokens: 1,
            },
            turn: {
              messages: [],
              inputKeys: ["input_ids", "pixel_values"],
              inputTensors: [
                { name: "input_ids", dtype: "int64", dims: [1, 2], location: "cpu" },
                { name: "pixel_values", dtype: "float32", dims: [1, 3, 1, 1], location: "gpu-buffer" },
              ],
              inputTokenIds: [7, 8],
              fullConversationInput: { status: "unavailable", reason: "test fixture does not observe reconstructed full conversation input" },
              cacheDecision: { status: "unavailable", reason: "test fixture does not observe cache decision" },
              pastKeyValuesProvided: false,
              inputPastKeyValuesSummary: { kind: "nullish", valueType: "undefined", constructorName: undefined, ownKeyCount: 0, ownKeys: [], arrayLength: undefined, truncated: false },
              outputPastKeyValuesSummary: { kind: "object", valueType: "object", constructorName: "Object", ownKeyCount: 0, ownKeys: [], arrayLength: undefined, truncated: false },
              generatedSequenceTokenIds: [7, 8, 99],
              generatedTokenIds: [99],
              generatedText: "image",
              streamChunks: ["image"],
              toolCalls: [],
              effectiveGenerationConfig: { maxNewTokens: 1, temperature: 0, topP: 1, doSample: false },
            },
          },
        },
        error: undefined,
      },
      laneComparison: {
        scenarioCaseId: "user-generation",
        referenceAttemptId: "reference-attempt",
        exactInputMatch: true,
        firstInputMismatchIndex: undefined,
        referenceInputTokenIds: [1, 2],
        productionInputTokenIds: [1, 2],
        referenceGeneratedTokenIds: [3],
        productionGeneratedTokenIds: [4],
        productionRoute: { autoClass: "AutoModelForCausalLM", processor: "tokenizer", strategy: "standard", modelType: "model" },
      },
      error: undefined,
    } satisfies ModelSupportInvestigationRun;

    const { blob } = await createPartialModelSupportEvidence({ run: base, recovery: undefined });
    const archive = await JSZip.loadAsync(await blob.arrayBuffer());

    expect(archive.file("production-lane/observation.json")).not.toBeNull();
    expect(JSON.parse(await archive.file("production-lane/observation.json")!.async("text"))).toMatchObject({
      resolvedRevision: "a".repeat(40),
      loaderRevisionOption: null,
    });
    expect(archive.file("production-lane/load-attempts.json")).not.toBeNull();
    expect(JSON.parse(await archive.file("production-lane/load-attempts.json")!.async("text"))).toEqual([
      { candidate: { device: "webgpu", dtype: "q4f16" }, status: "failed", error: { name: "Error", message: "q4f16 load failed", stack: "stack-q4f16" } },
      { candidate: { device: "webgpu", dtype: "q4" }, status: "passed" },
    ]);
    expect(archive.file("production-lane/first-turn.json")).not.toBeNull();
    const continuity = JSON.parse(await archive.file("production-lane/continuity.json")!.async("text"));
    expect(continuity).toMatchObject({
      status: "passed",
      secondTurn: {
        fullConversationInput: { status: "observed", inputTokenIds: [1, 9, 10] },
        cacheDecision: { status: "reused", reason: "qwen3_5-no-tool-continuation" },
        pastKeyValuesProvided: true,
      },
      prefixComparison: {
        mode: "full-input-prefix",
        comparisonInputSource: "reconstructed-full-conversation",
        exactPrefixMatch: false,
        firstMismatchIndex: 1,
        firstMismatchContext: {
          expectedText: "expected prefix",
          actualText: "actual reconstructed prefix",
        },
      },
    });
    expect(archive.file("production-lane/tool-result-continuation.json")).not.toBeNull();
    expect(archive.file("production-lane/reasoning.json")).not.toBeNull();
    expect(archive.file("production-lane/multimodal.json")).not.toBeNull();
    expect(archive.file("production-lane/error.json")).toBeNull();
    expect(archive.file("lane-comparison/comparison.json")).not.toBeNull();
    expect(archive.file("protocol-probes/tool.json")).not.toBeNull();
    const toolProbes = JSON.parse(await archive.file("protocol-probes/tool.json")!.async("text"));
    expect(toolProbes).toContainEqual(expect.objectContaining({
      attemptId: "reference-attempt",
      probe: expect.objectContaining({
        status: "observed",
        assistantToolCallCaseId: "assistant-tool-call-history",
        forcedTokenIds: [3, 4],
        exactMatch: true,
      }),
    }));
    expect(await archive.file("SUMMARY.md")!.async("text")).toContain("Production Lane generated successfully with standard strategy");
    const readiness = JSON.parse(await archive.file("readiness.json")!.async("text"));
    expect(readiness.domains).toContainEqual(expect.objectContaining({
      domainId: "production-routing",
      status: "implementation-ready",
    }));
    expect(readiness.domains).toContainEqual(expect.objectContaining({
      domainId: "multimodal",
      status: "partial",
    }));

    const channelHistoryMismatchRun = structuredClone(base);
    const channelHistoryObservation = channelHistoryMismatchRun.productionLane.observation;
    if (channelHistoryObservation === undefined) throw new Error("Production observation fixture is unavailable");
    channelHistoryObservation.continuity = {
      status: "failed",
      assistantMessage: {
        role: "assistant",
        content: "<|channel|>analysis<|message|>The user asked a question.",
      },
      followUpMessage: { role: "user", content: "Continue." },
      error: {
        name: "Error",
        message: "You have passed a message containing <|channel|> tags in the content field. Pass analysis messages in the thinking field and final messages in the content field.",
      },
    };
    channelHistoryMismatchRun.laneComparison = undefined;
    const { blob: channelHistoryMismatchBlob } = await createPartialModelSupportEvidence({
      run: channelHistoryMismatchRun,
      recovery: undefined,
    });
    const channelHistoryMismatchArchive = await JSZip.loadAsync(await channelHistoryMismatchBlob.arrayBuffer());
    const channelHistoryMismatchBoundaries = JSON.parse(
      await channelHistoryMismatchArchive.file("support-boundaries.json")!.async("text"),
    );
    expect(channelHistoryMismatchBoundaries).toContainEqual(expect.objectContaining({
      assessmentId: "production-history-channel-content-contract-mismatch",
      boundary: "naidan-production-adapter",
      basis: "exact-observation",
      evidencePaths: ["production-lane/continuity.json", "errors.json"],
    }));

    const checkpointRun = structuredClone(base);
    const checkpointSource = checkpointRun.productionLane.observation;
    if (checkpointSource === undefined) throw new Error("Production observation fixture is unavailable");
    checkpointRun.productionLane = {
      status: "failed",
      observation: undefined,
      partialObservation: {
        modelId: checkpointSource.modelId,
        resolvedRevision: checkpointSource.resolvedRevision,
        candidate: checkpointSource.candidate,
        loadAttempts: checkpointSource.loadAttempts,
        route: checkpointSource.route,
        isEncoderDecoder: checkpointSource.isEncoderDecoder,
        firstTurn: checkpointSource.firstTurn,
        continuity: checkpointSource.continuity,
        toolResultContinuation: checkpointSource.toolResultContinuation,
        reasoning: undefined,
        multimodal: undefined,
      },
      error: {
        name: "ProductionLaneTimeoutError",
        message: "Production Lane timed out during reasoning probe",
        stack: undefined,
      },
    };
    checkpointRun.laneComparison = undefined;
    const { blob: checkpointBlob } = await createPartialModelSupportEvidence({ run: checkpointRun, recovery: undefined });
    const checkpointArchive = await JSZip.loadAsync(await checkpointBlob.arrayBuffer());
    expect(checkpointArchive.file("production-lane/observation.json")).toBeNull();
    expect(checkpointArchive.file("production-lane/partial-observation.json")).not.toBeNull();
    expect(checkpointArchive.file("production-lane/load-attempts.json")).not.toBeNull();
    expect(checkpointArchive.file("production-lane/first-turn.json")).not.toBeNull();
    expect(checkpointArchive.file("production-lane/continuity.json")).not.toBeNull();
    expect(checkpointArchive.file("production-lane/tool-result-continuation.json")).not.toBeNull();
    expect(checkpointArchive.file("production-lane/reasoning.json")).toBeNull();
    expect(checkpointArchive.file("production-lane/multimodal.json")).toBeNull();
    expect(checkpointArchive.file("production-lane/error.json")).not.toBeNull();
    expect(checkpointArchive.file("lane-comparison/comparison.json")).toBeNull();
    const checkpointReadiness = JSON.parse(await checkpointArchive.file("readiness.json")!.async("text"));
    expect(checkpointReadiness.domains).toContainEqual(expect.objectContaining({
      domainId: "production-routing",
      status: "partial",
      questions: [expect.objectContaining({
        evidencePaths: ["production-lane/partial-observation.json", "production-lane/error.json", "production-lane/load-attempts.json"],
      })],
    }));
    expect(checkpointReadiness.domains).toContainEqual(expect.objectContaining({
      domainId: "plain-text",
      status: "partial",
      questions: [expect.objectContaining({
        evidencePaths: ["production-lane/partial-observation.json"],
      })],
    }));
    const checkpointErrors = JSON.parse(await checkpointArchive.file("errors.json")!.async("text"));
    expect(checkpointErrors.productionLaneError).toEqual(expect.objectContaining({
      name: "ProductionLaneTimeoutError",
      message: "Production Lane timed out during reasoning probe",
    }));

    const interruptedLoadRun = structuredClone(base);
    interruptedLoadRun.productionLane = {
      status: "running",
      observation: undefined,
      partialObservation: {
        modelId: "org/model",
        resolvedRevision: "a".repeat(40),
        loaderRevisionOption: null,
        runtimeLoadDurationMs: undefined,
        candidate: undefined,
        loadAttempts: [{
          candidate: { device: "webgpu", dtype: "q4f16" },
          status: "failed",
          modelLoadDurationMs: 1_200,
          error: { name: "Error", message: "q4f16 load failed", stack: "stack-q4f16" },
        }],
        activeLoadAttempt: {
          candidate: { device: "webgpu", dtype: "q4" },
          status: "running",
          modelLoadDurationMs: 6_000,
          modelLoadProgress: {
            kind: "model-load",
            artifactSource: "downloaded-model-cache",
            candidateId: "production-webgpu-q4",
            sourceStatus: "progress",
            currentFile: "onnx/model_q4.onnx_data",
            fileLoaded: 64 * 1024 * 1024,
            fileTotal: 256 * 1024 * 1024,
            fileProgress: 25,
            aggregateLoaded: 64 * 1024 * 1024,
            aggregateTotal: 256 * 1024 * 1024,
            aggregateProgress: 25,
            eventCount: 100_000,
            progressEventCount: 100_000,
            progressTotalEventCount: 100_000,
            forwardProgressCount: 100_000,
            repeatedWithoutForwardProgressCount: 0,
            publishedSampleCount: 2,
            cacheMatchRequestCount: 12,
            cacheHitCount: 12,
            cacheMissCount: 0,
            cacheAliasHitCount: 0,
            cacheMatchedBytes: 1_582_178_925,
            remoteFetchAttemptCount: 0,
            firstActivityAt: "2026-08-06T00:00:02.000Z",
            lastActivityAt: "2026-08-06T00:00:08.000Z",
            lastForwardProgressAt: "2026-08-06T00:00:08.000Z",
          },
        },
        route: undefined,
        isEncoderDecoder: undefined,
        firstTurn: undefined,
        continuity: undefined,
        toolResultContinuation: undefined,
        reasoning: undefined,
        multimodal: undefined,
      },
      error: undefined,
    };
    interruptedLoadRun.laneComparison = undefined;
    interruptedLoadRun.status = "failed";
    const { blob: interruptedLoadBlob } = await createPartialModelSupportEvidence({
      run: interruptedLoadRun,
      recovery: undefined,
    });
    const interruptedLoadArchive = await JSZip.loadAsync(await interruptedLoadBlob.arrayBuffer());
    expect(interruptedLoadArchive.file("production-lane/active-load-attempt.json")).not.toBeNull();
    expect(JSON.parse(await interruptedLoadArchive.file("production-lane/active-load-attempt.json")!.async("text"))).toMatchObject({
      candidate: { device: "webgpu", dtype: "q4" },
      status: "running",
      modelLoadDurationMs: 6_000,
      modelLoadProgress: { eventCount: 100_000, publishedSampleCount: 2 },
    });
    expect(await interruptedLoadArchive.file("SUMMARY.md")!.async("text")).toContain(
      "webgpu-q4 (duration=6000ms; raw-events=100000, published-samples=2; opfs-matches=12, hits=12, misses=0, alias-hits=0, matched-bytes=1582178925, remote-fetch-attempts=0) [running]",
    );
    expect(await interruptedLoadArchive.file("SUMMARY.md")!.async("text")).toContain(
      "Transformers.js download/progress callbacks measure Response body reads and do not prove network transfer",
    );
    const interruptedLoadReadiness = JSON.parse(await interruptedLoadArchive.file("readiness.json")!.async("text"));
    expect(interruptedLoadReadiness.domains).toContainEqual(expect.objectContaining({
      domainId: "production-routing",
      status: "partial",
      questions: [expect.objectContaining({
        evidencePaths: expect.arrayContaining([
          "production-lane/partial-observation.json",
          "production-lane/load-attempts.json",
          "production-lane/active-load-attempt.json",
        ]),
      })],
    }));

    const failedFirstTurnObservation = base.productionLane.observation;
    if (failedFirstTurnObservation === undefined) throw new Error("Production observation fixture is unavailable");
    failedFirstTurnObservation.firstTurn = {
      status: "failed",
      error: {
        name: "FixtureFirstTurnError",
        message: "first turn failed",
        stack: "fixture-first-turn-stack",
        thrownType: "Error",
        serializedOriginalThrownValue: '{"message":"first turn failed"}',
        cause: {
          name: "FixtureCauseError",
          message: "first turn cause",
          stack: "fixture-cause-stack",
        },
      },
    };
    failedFirstTurnObservation.continuity = {
      status: "not-run",
      reason: "First Production turn failed",
    };
    base.laneComparison = undefined;
    const { blob: failedFirstTurnBlob } = await createPartialModelSupportEvidence({ run: base, recovery: undefined });
    const failedFirstTurnArchive = await JSZip.loadAsync(await failedFirstTurnBlob.arrayBuffer());
    expect(JSON.parse(await failedFirstTurnArchive.file("production-lane/first-turn.json")!.async("text"))).toMatchObject({
      status: "failed",
      error: { name: "FixtureFirstTurnError", message: "first turn failed" },
    });
    expect(failedFirstTurnArchive.file("production-lane/tool-result-continuation.json")).not.toBeNull();
    expect(failedFirstTurnArchive.file("production-lane/reasoning.json")).not.toBeNull();
    expect(failedFirstTurnArchive.file("production-lane/multimodal.json")).not.toBeNull();
    expect(failedFirstTurnArchive.file("lane-comparison/comparison.json")).toBeNull();
    const failedFirstTurnErrors = JSON.parse(await failedFirstTurnArchive.file("errors.json")!.async("text"));
    expect(failedFirstTurnErrors.productionFirstTurnError).toEqual({
      name: "FixtureFirstTurnError",
      message: "first turn failed",
      stack: "fixture-first-turn-stack",
      thrownType: "Error",
      serializedOriginalThrownValue: '{"message":"first turn failed"}',
      cause: {
        name: "FixtureCauseError",
        message: "first turn cause",
        stack: "fixture-cause-stack",
      },
    });
    expect(await failedFirstTurnArchive.file("SUMMARY.md")!.async("text"))
      .toContain("continued independent probes with standard strategy after first-turn generation failed");
  });

  it("exports structured prerequisite step errors through readiness and support-boundary evidence", async () => {
    const run: ModelSupportInvestigationRun = {
      schemaVersion: 1,
      runId: "step-error-run",
      modelId: "org/model",
      scope: "partial-runtime-repository-cache-declarations-template-model-files",
      startedAt: "2026-08-07T00:00:00.000Z",
      completedAt: "2026-08-07T00:00:02.000Z",
      status: "failed",
      currentOperation: "Partial evidence collected with investigation failures",
      steps: [
        { id: "runtime-assets", status: "not-run", detail: undefined },
        { id: "repository-information", status: "failed", detail: "Unexpected token '<' while parsing repository metadata" },
        { id: "existing-model-data", status: "not-run", detail: undefined },
        { id: "model-declarations", status: "blocked", detail: "repository unavailable" },
        { id: "template-behavior", status: "blocked", detail: "repository unavailable" },
        { id: "model-file-plan", status: "blocked", detail: "repository unavailable" },
        { id: "loading-investigation", status: "not-run", detail: undefined },
        { id: "lane-comparison", status: "not-run", detail: undefined },
        { id: "evidence-export", status: "not-run", detail: undefined },
      ],
      runtimeAssets: undefined,
      repository: undefined,
      runtimeTarget: undefined,
      downloadEvidence: undefined,
      cache: undefined,
      declarations: undefined,
      templateBehavior: undefined,
      modelFilePlan: undefined,
      loadAttempts: [],
      productionLane: { status: "not-run", observation: undefined, partialObservation: undefined, error: undefined },
      laneComparison: undefined,
      stepErrors: {
        "repository-information": [{
          name: "SyntaxError",
          message: "Unexpected token '<' while parsing repository metadata",
          stack: `\
SyntaxError: Unexpected token '<'
    at parseRepository`,
          thrownType: "SyntaxError",
          serializedOriginalThrownValue: '{"source":"<!doctype html>"}',
          cause: {
            name: "Error",
            message: "repository response was not JSON",
            stack: "Error: repository response was not JSON",
            thrownType: "Error",
          },
        }],
      },
      error: "Unexpected token '<' while parsing repository metadata",
    };

    const { blob } = await createPartialModelSupportEvidence({ run, recovery: undefined });
    const archive = await JSZip.loadAsync(await blob.arrayBuffer());
    const errors = JSON.parse(await archive.file("errors.json")!.async("text"));
    const readiness = JSON.parse(await archive.file("readiness.json")!.async("text"));
    const boundaries = JSON.parse(await archive.file("support-boundaries.json")!.async("text"));

    expect(errors.stepErrors["repository-information"][0]).toMatchObject({
      name: "SyntaxError",
      message: "Unexpected token '<' while parsing repository metadata",
      cause: { name: "Error", message: "repository response was not JSON" },
    });
    expect(readiness.domains.find((domain: { domainId: string }) => domain.domainId === "repository")).toMatchObject({
      status: "insufficient",
      questions: [expect.objectContaining({ evidencePaths: ["errors.json"] })],
    });
    expect(boundaries).toContainEqual(expect.objectContaining({
      assessmentId: "investigation-prerequisite-step-failed",
      boundary: "unresolved",
      evidencePaths: ["errors.json"],
    }));
  });

  it("exports parent checkpoint recovery events and interruption evidence", async () => {
    const run: ModelSupportInvestigationRun = {
      schemaVersion: 1,
      runId: "interrupted-run",
      modelId: "org/model",
      scope: "partial-runtime-preflight",
      startedAt: "2026-08-07T00:00:00.000Z",
      completedAt: "2026-08-07T00:00:02.000Z",
      status: "failed",
      currentOperation: "Investigation interrupted after runtime-assets: Importing runtime",
      steps: [
        { id: "runtime-assets", status: "failed", detail: "Interrupted: Worker exited unexpectedly" },
        { id: "repository-information", status: "not-run", detail: undefined },
        { id: "existing-model-data", status: "not-run", detail: undefined },
        { id: "model-declarations", status: "not-run", detail: undefined },
        { id: "template-behavior", status: "not-run", detail: undefined },
        { id: "model-file-plan", status: "not-run", detail: undefined },
        { id: "loading-investigation", status: "not-run", detail: undefined },
        { id: "lane-comparison", status: "not-run", detail: undefined },
        { id: "evidence-export", status: "not-run", detail: undefined },
      ],
      runtimeAssets: undefined,
      repository: undefined,
      runtimeTarget: undefined,
      downloadEvidence: undefined,
      cache: undefined,
      declarations: undefined,
      templateBehavior: undefined,
      modelFilePlan: undefined,
      loadAttempts: [],
      productionLane: { status: "not-run", observation: undefined, partialObservation: undefined, error: undefined },
      laneComparison: undefined,
      error: "Investigation interrupted: Worker exited unexpectedly",
    };
    const recovery = {
      schemaVersion: 1 as const,
      status: "interrupted" as const,
      checkpointSequence: 2,
      checkpointedAt: "2026-08-07T00:00:02.000Z",
      totalEventCount: 7,
      droppedEventCount: 6,
      lastEvent: {
        sequence: 1,
        at: "2026-08-07T00:00:01.000Z",
        stepId: "runtime-assets" as const,
        status: "running" as const,
        detail: "Importing runtime",
      },
      events: [{
        sequence: 1,
        at: "2026-08-07T00:00:01.000Z",
        stepId: "runtime-assets" as const,
        status: "running" as const,
        detail: "Importing runtime",
      }],
      interruption: {
        at: "2026-08-07T00:00:02.000Z",
        lastEventSequence: 1,
        error: {
          name: "Error",
          message: "Worker exited unexpectedly",
          stack: undefined,
        },
      },
    };

    const { blob } = await createPartialModelSupportEvidence({ run, recovery });
    const archive = await JSZip.loadAsync(await blob.arrayBuffer());
    const checkpoint = JSON.parse(await archive.file("recovery/checkpoint.json")!.async("text"));
    const errors = JSON.parse(await archive.file("errors.json")!.async("text"));
    const events = await archive.file("events.jsonl")!.async("text");
    const summary = await archive.file("SUMMARY.md")!.async("text");

    expect(checkpoint.status).toBe("interrupted");
    expect(errors.interruptionError).toMatchObject({ name: "Error", message: "Worker exited unexpectedly" });
    expect(events).toContain('"eventKind":"investigation-event"');
    expect(events).toContain('"detail":"Importing runtime"');
    expect(summary).toContain("Recovery status: interrupted");
    expect(summary).toContain("Recovery journal: retained 1 of 7 events; 6 dropped by bounded telemetry policy");
  });


  it("exports partial runtime preflight observations without claiming a complete runtime", async () => {
    const run: ModelSupportInvestigationRun = {
      schemaVersion: 1,
      runId: "run-runtime-partial",
      modelId: "org/model",
      scope: "partial-runtime-preflight",
      startedAt: "2026-08-06T00:00:00.000Z",
      completedAt: "2026-08-06T00:00:01.000Z",
      status: "failed",
      currentOperation: "runtime module import failed",
      steps: [{ id: "runtime-assets", status: "failed", detail: "runtime module import failed" }],
      runtimeAssets: undefined,
      runtimeAssetsPartial: {
        variant: "asyncify",
        assetIdentity: runtimeAssetIdentity(),
        baseUrl: "https://naidan.example/transformers/",
        mjsUrl: "https://naidan.example/transformers/ort.mjs",
        wasmUrl: "https://naidan.example/transformers/ort.wasm",
        physicalWasmUrl: "https://naidan.example/transformers/ort.wasm.gz",
        applicationOrigin: "https://naidan.example",
        mjsOrigin: "https://naidan.example",
        wasmOrigin: "https://naidan.example",
        physicalWasmOrigin: "https://naidan.example",
        environment: {
          userAgent: "Browser/1",
          vendor: "Vendor",
          hardwareConcurrency: 8,
          deviceMemoryGiB: 16,
          crossOriginIsolated: true,
          webGpu: { availability: "available", adapterInfo: {}, features: [], limits: {}, error: undefined },
        },
        wasmByteLength: 5,
        control: {
          fixtureId: "identity-float32-v1",
          fixtureSha256: "sha",
          executionProvider: "wasm",
          status: "passed",
          inputName: "x",
          outputName: "y",
          inputValue: 7,
          outputValue: 7,
          error: undefined,
        },
        webGpuControl: {
          fixtureId: "identity-float32-v1",
          fixtureSha256: "sha",
          executionProvider: "webgpu",
          status: "passed",
          inputName: "x",
          outputName: "y",
          inputValue: 7,
          outputValue: 7,
          error: undefined,
        },
        currentStage: undefined,
        stageObservations: [
          { stage: "origin-validation", status: "passed", detail: "same-origin" },
          { stage: "environment", status: "passed", detail: "environment observed" },
          { stage: "module-import", status: "failed", detail: "runtime module import failed", error: "runtime module import failed" },
          { stage: "wasm-fetch", status: "passed", detail: "WASM fetched" },
          { stage: "wasm-validation", status: "passed", detail: "WASM valid" },
          { stage: "wasm-control", status: "passed", detail: "Wasm control passed" },
          { stage: "webgpu-control", status: "passed", detail: "WebGPU control passed" },
        ],
      },
      repository: undefined,
      runtimeTarget: undefined,
      downloadEvidence: undefined,
      cache: undefined,
      declarations: undefined,
      templateBehavior: undefined,
      modelFilePlan: undefined,
      loadAttempts: [],
      productionLane: { status: "not-run", observation: undefined, partialObservation: undefined, error: undefined },
      laneComparison: undefined,
      error: "runtime module import failed",
    };

    const evidence = await createPartialModelSupportEvidence({ run, recovery: undefined });
    const archive = await JSZip.loadAsync(await evidence.blob.arrayBuffer());
    const partial = JSON.parse(await archive.file("runtime-assets/preflight-partial.json")!.async("text"));
    expect(partial).toMatchObject({
      environment: { hardwareConcurrency: 8 },
      control: { status: "passed" },
      webGpuControl: { status: "passed" },
    });
    expect(archive.file("runtime-assets/preflight.json")).toBeNull();
    expect(archive.file("runtime-assets/asset-identity.json")).not.toBeNull();
    expect(archive.file("runtime-assets/environment.json")).not.toBeNull();
    expect(archive.file("runtime-assets/backend-controls.json")).not.toBeNull();

    const readiness = JSON.parse(await archive.file("readiness.json")!.async("text"));
    expect(readiness.domains).toContainEqual(expect.objectContaining({
      domainId: "runtime-assets",
      status: "insufficient",
      questions: [expect.objectContaining({
        evidencePaths: [
          "runtime-assets/preflight-partial.json",
          "runtime-assets/asset-identity.json",
        ],
      })],
    }));
    const boundaries = JSON.parse(await archive.file("support-boundaries.json")!.async("text"));
    expect(boundaries).toContainEqual(expect.objectContaining({
      assessmentId: "runtime-integrity-failed",
      evidencePaths: expect.arrayContaining(["runtime-assets/preflight-partial.json"]),
    }));
    const assessment = JSON.parse(await archive.file("package-assessment.json")!.async("text"));
    expect(assessment.status).not.toBe("invalid");
  });

  it("preserves a user-skipped target in the batch index", async () => {
    const evidence = await createBatchModelSupportEvidence({
      batchId: "batch-skipped-target",
      items: [{
        target: "onnx-community/gpt-oss-20b-ONNX",
        status: "skipped",
        run: undefined,
        recovery: undefined,
        error: "Model Support Investigation was stopped by the user",
      }],
    });

    const archive = await JSZip.loadAsync(await evidence.blob.arrayBuffer());
    const batchIndex = JSON.parse(await archive.file("batch.json")!.async("text")) as {
      targets: Array<{ target: string, status: string, error?: string }>,
    };
    expect(batchIndex.targets).toEqual([{
      index: 1,
      target: "onnx-community/gpt-oss-20b-ONNX",
      status: "skipped",
      error: "Model Support Investigation was stopped by the user",
    }]);
  });

  it("exports the complete requested model index even when no target produced a run", async () => {
    const targets = [
      "HuggingFaceTB/SmolLM2-1.7B-Instruct",
      "HuggingFaceTB/SmolLM2-135M-Instruct",
      "LiquidAI/LFM2.5-2.6B-ONNX",
      "LiquidAI/LFM2.5-230M-ONNX",
      "LiquidAI/LFM2.5-350M-ONNX",
      "onnx-community/gemma-4-E2B-it-ONNX",
      "onnx-community/gpt-oss-20b-ONNX",
      "onnx-community/Qwen3.5-2B-ONNX",
      "onnx-community/Qwen3.5-4B-ONNX",
    ];
    const evidence = await createBatchModelSupportEvidence({
      batchId: "batch-no-runs",
      items: targets.map(target => ({
        target,
        status: "pending" as const,
        run: undefined,
        recovery: undefined,
        error: undefined,
      })),
    });

    const archive = await JSZip.loadAsync(await evidence.blob.arrayBuffer());
    const batchIndex = JSON.parse(await archive.file("batch.json")!.async("text")) as {
      targetCount: number,
      packagedModelCount: number,
      targets: Array<{ target: string, status: string, evidencePath?: string }>,
    };
    expect(batchIndex.targetCount).toBe(9);
    expect(batchIndex.packagedModelCount).toBe(0);
    expect(batchIndex.targets.map(target => target.target)).toEqual(targets);
    expect(batchIndex.targets.every(target => target.status === "pending")).toBe(true);
    expect(batchIndex.targets.every(target => target.evidencePath === undefined)).toBe(true);
    expect(archive.file("manifest.json")).not.toBeNull();
  });

});
