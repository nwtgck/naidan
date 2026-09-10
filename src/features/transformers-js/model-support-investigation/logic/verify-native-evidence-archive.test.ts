// @vitest-environment node
import { createHash, webcrypto } from 'node:crypto';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ProductionProviderCaptureSnapshot } from './production-provider-capture-owner';
import type { ProductionProviderNativeCollectionSnapshot } from './production-provider-generation-capture-owner';
import { createProductionProviderCaptureEvidence } from './production-provider-capture-evidence';
import { createProductionProviderNativeEvidence, PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES } from './production-provider-native-evidence';
import { verifyGeneratedEvidenceArchive } from './verify-evidence-archive';

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('Native archive verification cannot access the network');
  }));
});

afterEach(() => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

// Synthetic DTOs isolate archive referential integrity. These are neither
// browser observations nor model-output fixtures. The exporter validates them;
// each negative test then changes only one relation and rebuilds the outer
// manifest, so a manifest hash failure cannot mask the missing semantic check.
function records() {
  const context = { runId: 'native-archive', workerEpoch: 1, requestId: 'native-archive-first-turn', generationCallId: 1 };
  const provider: ProductionProviderCaptureSnapshot = {
    format: 'production-provider-capture-v2', runId: context.runId, modelId: 'fixture/model', plan: 'first-only',
    run: { status: 'completed' }, lifetime: 'open', abortReason: undefined, disposal: 'not-requested', observation: 'open',
    events: [{ sequence: 0, kind: 'run-started', activeRequestId: undefined }],
    requests: [{
      runId: context.runId, requestId: context.requestId, scenario: 'first-turn', status: 'settled', notStartedReason: undefined,
      input: {
        messages: [{ role: 'user', content: 'Template probe user message.' }],
        parameters: { temperature: 0, topP: 1, maxCompletionTokens: 16, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
        tools: [],
      },
      trace: {
        format: 'production-provider-trace-v2', requestId: context.requestId, completeness: 'complete', failure: undefined,
        limits: { maximumEvents: 20, maximumCharacters: 1024, maximumFieldCharacters: 16384 },
        events: [], lateEvents: [], retainedCharacters: 0,
        settled: { sequence: 0, outcome: { status: 'fulfilled' }, events: [], completeness: 'complete', failure: undefined },
      },
    }],
    capabilities: { providerCallbacks: 'bounded-projection', nativeInvocations: 'not-collected-by-this-owner', tools: 'not-selected', images: 'not-selected' },
  };
  const native: ProductionProviderNativeCollectionSnapshot = {
    format: 'production-provider-native-collection-v1', runId: context.runId, maximumWorkerEpochs: 8,
    phase: 'finished', unrecordedWorkerCreations: 0, incompleteReasons: [],
    epochs: [{
      workerEpoch: 1,
      lifetime: { status: 'observed', value: {
        runId: context.runId, workerEpoch: 1, session: 'active', issuedCalls: [context],
        loadRequests: [{ requestedModelId: 'fixture/model', requestedRevision: undefined }], incompleteReasons: [],
      } },
      collection: { status: 'returned', result: { status: 'captured', capture: {
        schemaVersion: 1, runId: context.runId, workerEpoch: 1, byteOrder: 'little-endian',
        limits: { maxCalls: 1, maxInvocationsPerCall: 1, maxEvents: 4, maxTextBytes: 256, maxTensorBytes: 16, maxTotalTensorBytes: 16, maxTokensPerStreamEvent: 4, maxTotalStreamTokens: 8, maxTotalStreamTokenBytes: 64 },
        calls: [{ context, loadIdentity: { status: 'not-observed', reason: 'no-completed-load' }, outcome: 'fulfilled', invocations: [{ nativeInvocationOrdinal: 1, stream: { status: 'not-attempted' } }] }],
        events: [{ kind: 'sequence', identity: { ...context, nativeInvocationOrdinal: 1 }, resultShape: 'tensor', snapshot: { status: 'captured', dtype: 'uint8', dims: [2], byteLength: 2, bytes: Uint8Array.of(5, 6) } }],
        incompleteReasons: [], unobserved: ['native-stop-cause', 'native-forward-input', 'kv-bytes'],
      } } },
    }],
  };
  return { provider, native };
}

async function archive({ changeIndex, extraBinary }: {
  changeIndex: (({ json, path, sha256 }: { json: string; path: string; sha256: string }) => string) | undefined;
  extraBinary: 'none' | 'unreferenced';
}) {
  const { provider, native } = records();
  const exported = await createProductionProviderNativeEvidence({ provider, native, maximumBinaryBytes: PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES });
  expect(exported.binaries).toHaveLength(1);
  const binary = exported.binaries[0]!;
  const providerEvidence = createProductionProviderCaptureEvidence({ capture: provider, runId: provider.runId, modelId: provider.modelId });
  const zip = new JSZip();
  zip.file('run.json', JSON.stringify({ runId: provider.runId, modelId: provider.modelId, productionProviderCapture: providerEvidence.reference, productionProviderNativeCapture: exported.reference }));
  zip.file('production-provider/capture.json', providerEvidence.json);
  zip.file(exported.path, changeIndex === undefined ? exported.json : changeIndex({ json: exported.json, path: binary.path, sha256: binary.sha256 }));
  zip.file(binary.path, await binary.blob.arrayBuffer());
  switch (extraBinary) {
  case 'none': break;
  case 'unreferenced': zip.file('generation-native/tensors/000002.bin', Uint8Array.of(7)); break;
  default: {
    const exhaustive: never = extraBinary;
    throw new Error(String(exhaustive));
  }
  }
  zip.file('package-assessment.json', JSON.stringify({ schemaVersion: 1, status: 'valid-partial' }));
  return finalizeArchive({ zip });
}

async function finalizeArchive({ zip }: { zip: JSZip }): Promise<Blob> {
  const files = await Promise.all(Object.entries(zip.files).filter(([path, file]) => !file.dir && path !== 'manifest.json').map(async ([path, file]) => {
    const bytes = await file.async('uint8array');
    return { path, byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
  zip.file('manifest.json', JSON.stringify({ schemaVersion: 1, runId: 'native-archive', generatedAt: '2026-09-09T00:00:00.000Z', files }));
  return zip.generateAsync({ type: 'blob' });
}

describe('Native evidence references beyond the outer archive manifest', () => {
  it.each([1, 0])('validates image metadata after a consistent outer manifest is rebuilt: height %s', async height => {
    const blob = await archive({ extraBinary: 'none', changeIndex: ({ json }) => {
      const envelope = JSON.parse(json);
      const capture = envelope.epochs[0].collection.result.capture;
      capture.events.push({ kind: 'inputs', identity: capture.events[0].identity, phase: 'native-kwargs', values: [
        { name: 'original_sizes', snapshot: { status: 'image-sizes', values: [[height, 2]] } },
      ] });
      return JSON.stringify(envelope);
    } });
    if (height === 0) await expect(verifyGeneratedEvidenceArchive({ blob })).rejects.toThrow('Invalid native capture evidence');
    else await expect(verifyGeneratedEvidenceArchive({ blob })).resolves.toMatchObject({ runId: 'native-archive' });
  });
  it('accepts an exporter-produced native index with exactly its referenced tensor bytes', async () => {
    await expect(verifyGeneratedEvidenceArchive({ blob: await archive({ changeIndex: undefined, extraBinary: 'none' }) })).resolves.toEqual({
      runId: 'native-archive', fileCount: 5, packageStatus: 'valid-partial',
    });
  });

  it('rejects a wrong native tensor digest even when every outer manifest digest matches', async () => {
    const blob = await archive({ extraBinary: 'none', changeIndex: ({ json, sha256 }) => {
      expect(json.split(sha256)).toHaveLength(2);
      return json.replace(sha256, '0'.repeat(64));
    } });
    await expect(verifyGeneratedEvidenceArchive({ blob })).rejects.toThrow('Invalid native capture evidence');
  });

  it('rejects a dangling native tensor reference even when every archived file is accounted for', async () => {
    const blob = await archive({ extraBinary: 'none', changeIndex: ({ json, path }) => {
      expect(json.split(path)).toHaveLength(2);
      return json.replace(path, 'generation-native/tensors/000002.bin');
    } });
    await expect(verifyGeneratedEvidenceArchive({ blob })).rejects.toThrow('Invalid native capture evidence');
  });

  it('rejects an unreferenced native binary even when it has a valid outer manifest entry', async () => {
    await expect(verifyGeneratedEvidenceArchive({ blob: await archive({ changeIndex: undefined, extraBinary: 'unreferenced' }) })).rejects.toThrow('Evidence archive contains unreferenced native entries');
  });

  it('rejects a native index belonging to another run despite a consistent native index and outer file hashes', async () => {
    const blob = await archive({ extraBinary: 'none', changeIndex: ({ json }) => json.replaceAll('native-archive', 'another-archive') });
    await expect(verifyGeneratedEvidenceArchive({ blob })).rejects.toThrow('Invalid native capture evidence');
  });

  it('rejects native evidence without the Provider document that owns its requests', async () => {
    const zip = await JSZip.loadAsync(await (await archive({ changeIndex: undefined, extraBinary: 'none' })).arrayBuffer());
    zip.remove('production-provider/capture.json');
    await expect(verifyGeneratedEvidenceArchive({ blob: await finalizeArchive({ zip }) })).rejects.toThrow('Evidence archive is missing its Production capture owner');
  });

  it('rejects native binaries without their index even when the manifest is complete', async () => {
    const zip = await JSZip.loadAsync(await (await archive({ changeIndex: undefined, extraBinary: 'none' })).arrayBuffer());
    zip.remove('generation-native/capture.json');
    await expect(verifyGeneratedEvidenceArchive({ blob: await finalizeArchive({ zip }) })).rejects.toThrow('Evidence archive is missing its native capture index or run reference');
  });

  it('compares the Provider model against run.json instead of trusting self-consistent capture IDs', async () => {
    const zip = await JSZip.loadAsync(await (await archive({ changeIndex: undefined, extraBinary: 'none' })).arrayBuffer());
    const original = await zip.file('run.json')!.async('text');
    expect(original.split('fixture/model')).toHaveLength(2);
    zip.file('run.json', original.replace('fixture/model', 'fixture/another-model'));
    await expect(verifyGeneratedEvidenceArchive({ blob: await finalizeArchive({ zip }) })).rejects.toThrow('Invalid Production Provider capture evidence');
  });

  it('validates the Provider document even when no native collection was exported', async () => {
    const zip = await JSZip.loadAsync(await (await archive({ changeIndex: undefined, extraBinary: 'none' })).arrayBuffer());
    zip.remove('generation-native');
    const run = z.record(z.string(), z.unknown()).parse(JSON.parse(await zip.file('run.json')!.async('text')) as unknown);
    delete run.productionProviderNativeCapture;
    zip.file('run.json', JSON.stringify(run));
    const original = await zip.file('production-provider/capture.json')!.async('text');
    expect(original.split('"scope": "per-request"')).toHaveLength(2);
    zip.file('production-provider/capture.json', original.replace('"scope": "per-request"', '"scope": "unbounded"'));
    await expect(verifyGeneratedEvidenceArchive({ blob: await finalizeArchive({ zip }) })).rejects.toThrow('Invalid Production Provider capture evidence');
  });

  it('rejects a dangling native run reference even when all native files were removed together', async () => {
    const zip = await JSZip.loadAsync(await (await archive({ changeIndex: undefined, extraBinary: 'none' })).arrayBuffer());
    zip.remove('generation-native');
    await expect(verifyGeneratedEvidenceArchive({ blob: await finalizeArchive({ zip }) })).rejects.toThrow('Evidence archive is missing its native capture index or run reference');
  });

  it('rejects an unowned native index even when the Provider and every binary are present', async () => {
    const zip = await JSZip.loadAsync(await (await archive({ changeIndex: undefined, extraBinary: 'none' })).arrayBuffer());
    const run = z.record(z.string(), z.unknown()).parse(JSON.parse(await zip.file('run.json')!.async('text')) as unknown);
    delete run.productionProviderNativeCapture;
    zip.file('run.json', JSON.stringify(run));
    await expect(verifyGeneratedEvidenceArchive({ blob: await finalizeArchive({ zip }) })).rejects.toThrow('Evidence archive is missing its native capture index or run reference');
  });

  it('rejects dangling owner references even when both capture directories were removed', async () => {
    const zip = await JSZip.loadAsync(await (await archive({ changeIndex: undefined, extraBinary: 'none' })).arrayBuffer());
    zip.remove('generation-native');
    zip.remove('production-provider');
    await expect(verifyGeneratedEvidenceArchive({ blob: await finalizeArchive({ zip }) })).rejects.toThrow('Evidence archive is missing its Production capture owner');
  });
});
