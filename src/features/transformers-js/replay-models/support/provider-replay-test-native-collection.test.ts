// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { createProviderReplayTestRuntime } from './provider-replay-test-runtime';
import { createProviderReplayTestImagePlatform } from './provider-replay-test-image-platform';
import { createSyntheticModelBody } from './download-synthetic-session-oracle';
import { MODEL_SUPPORT_INVESTIGATION_MULTIMODAL_FIXTURE as image } from '@/features/transformers-js/model-support-investigation/fixtures/synthetic-multimodal-image';
import type { GenerationCaptureClient } from '@/features/transformers-js/worker/generation-capture-protocol';
import { loadDiagnosticsSchema } from '@/features/transformers-js/worker/load-diagnostics';

// This is a collection/transport control, not captured model inference. Only
// native generate and browser platforms are substituted; the real Provider,
// service, Comlink, Worker strategy, tokenizer, streamer and parser still run.
// Allocation controls additionally refuse a tiny readResponse allocation;
// they exercise failure transport without claiming device memory capacity.
describe('Production native collection through actual Comlink', () => {
  it.each(['available', 'session-inactive', 'take-failed', 'fatal-auto-retirement'] as const)('retains actual readResponse allocation failure in host-owned diagnostics through %s collection and ZIP re-export', async collectionMode => {
    const modelId = 'HuggingFaceTB/SmolLM2-135M-Instruct';
    const revision = '12fd25f77366fa6b3b4b768ec3050bf629380bac';
    const path = 'onnx/model_q4f16.onnx';
    const requestedBytes = 257;
    const harness = await createProviderReplayTestRuntime({
      modelId, expectedRevision: revision, cacheRevision: revision, metadataCache: 'all-fixture',
      artifacts: [{ path, bytes: new Uint8Array(requestedBytes) }], imagePlatform: undefined,
      generate: async () => {
        throw new Error('Allocation control must stop before native generation');
      },
    });
    const { createProductionProviderGenerationCaptureOwner } = await import('@/features/transformers-js/model-support-investigation/logic/production-provider-generation-capture-owner');
    const { createTransformersJsGenerationCaptureClient } = await import('@/features/transformers-js/worker/client-hosted');
    const clients: GenerationCaptureClient[] = [];
    const creationSnapshots: Array<ReturnType<GenerationCaptureClient['getCaptureLifetime']>> = [];
    const takeCalls: number[] = [];
    const replacementEpochs: number[] = [];
    const replacementOperations: string[] = [];
    const owner = createProductionProviderGenerationCaptureOwner({
      runId: `synthetic-allocation-${collectionMode}`, modelId, plan: 'first-continuity-independent',
      traceLimits: { maximumEvents: 64, maximumCharacters: 4096 }, maximumWorkerEpochs: 8,
      createCaptureClient: ({ runId, workerEpoch, getActiveRequest }) => {
        if (workerEpoch > 1) {
          // The first Worker and its fatal-error retirement are real. A new
          // platform boundary stops here: never reuse the old Node Realm or
          // present this unavailable replacement as a successful next Load.
          replacementEpochs.push(workerEpoch);
          const unavailable = async ({ operation }: { operation: string }): Promise<never> => {
            replacementOperations.push(operation);
            throw new Error('Explicit unavailable replacement platform boundary');
          };
          return {
            client: {
              loadDownloadedModel: () => unavailable({ operation: 'load' }),
              unloadModel: () => unavailable({ operation: 'unload' }),
              interrupt: () => unavailable({ operation: 'interrupt' }),
              resetCache: () => unavailable({ operation: 'reset-cache' }),
              generateText: () => unavailable({ operation: 'generate' }),
              async dispose() {
                replacementOperations.push('dispose');
              },
            },
            takeGenerationCapture: () => unavailable({ operation: 'take' }),
            getCaptureLifetime: () => ({ runId, workerEpoch, session: 'inactive', issuedCalls: [], loadRequests: [], incompleteReasons: [] }),
          };
        }
        const capture = createTransformersJsGenerationCaptureClient({
          runId, workerEpoch, getActiveRequest,
          limits: { maxCalls: 8, maxInvocationsPerCall: 4, maxEvents: 256, maxTextBytes: 8192,
            maxTensorBytes: 8192, maxTotalTensorBytes: 65536,
            maxTokensPerStreamEvent: 4096, maxTotalStreamTokens: 16384, maxTotalStreamTokenBytes: 262144 },
        });
        clients.push(capture);
        creationSnapshots.push(capture.getCaptureLifetime());
        return { ...capture, async takeGenerationCapture() {
          takeCalls.push(workerEpoch);
          const result = await capture.takeGenerationCapture();
          if (collectionMode === 'take-failed') throw new Error('Synthetic capture reply discarded after the actual take');
          return result;
        } };
      },
      createUnrecordedWorkerClient: () => {
        throw new Error('Unexpected replacement Worker');
      },
    });
    const originalUint8Array = globalThis.Uint8Array;
    const rejectedAllocations: Array<{ bytes: number; stack: string }> = [];
    // Reject one explicitly tiny allocation in the hash-verified Vite artifact.
    // No observer is called by the test, and ordinary metadata allocations run.
    globalThis.Uint8Array = new Proxy(originalUint8Array, {
      construct(target, argumentsList, newTarget) {
        if (argumentsList[0] === requestedBytes) {
          const stack = new Error().stack ?? '';
          if (stack.includes('readResponse') && stack.includes('transformers-js-fixes.mjs')) {
            rejectedAllocations.push({ bytes: requestedBytes, stack });
            throw new RangeError(collectionMode === 'fatal-auto-retirement' ? 'Array buffer allocation failed' : 'Synthetic readResponse allocation refusal');
          }
        }
        return Reflect.construct(target, argumentsList, newTarget);
      },
    });
    try {
      const provider = await owner.run();
      globalThis.Uint8Array = originalUint8Array;
      expect(rejectedAllocations).toHaveLength(1);
      expect(rejectedAllocations[0]?.bytes).toBe(requestedBytes);
      expect(provider.run).toEqual({ status: 'stopped', reason: 'provider-rejected' });
      expect(provider.requests[0]?.trace.settled?.outcome).toEqual({ status: 'rejected', errorName: 'RangeError' });
      expect(harness.observations.inferenceCalls).toEqual([]);
      expect(harness.observations.ortCalls).toEqual([]);
      expect(clients).toHaveLength(1);
      expect(replacementEpochs).toEqual(collectionMode === 'fatal-auto-retirement' ? [2] : []);
      expect(replacementOperations).toEqual([]);
      if (collectionMode === 'session-inactive') await clients[0]!.client.dispose();
      await owner.collectNative();
      const snapshot = owner.snapshot();
      if (snapshot.native.status !== 'retained') throw new Error('Expected retained allocation diagnostics');
      expect(snapshot.native.capture.epochs).toHaveLength(collectionMode === 'fatal-auto-retirement' ? 2 : 1);
      if (collectionMode === 'fatal-auto-retirement') {
        expect(snapshot.native.capture.epochs[1]).toEqual({
          workerEpoch: 2,
          lifetime: { status: 'observed', value: { runId: provider.runId, workerEpoch: 2, session: 'inactive', issuedCalls: [], loadRequests: [], incompleteReasons: [] } },
          collection: { status: 'unavailable', reason: 'session-inactive' },
        });
      }
      const epoch = snapshot.native.capture.epochs[0]!;
      if (epoch.lifetime.status !== 'observed') throw new Error('Expected host-owned lifetime');
      const diagnostics = loadDiagnosticsSchema.parse(epoch.lifetime.value.loadDiagnostics);
      expect(diagnostics.owner).toEqual({ runId: provider.runId, workerEpoch: 1 });
      expect(creationSnapshots).toHaveLength(1);
      // Actual later Worker callbacks must not mutate a previously owned view.
      expect(creationSnapshots[0]?.loadDiagnostics?.events).toEqual([]);
      expect(diagnostics.byteAccounting).toBe('successful-allocation-request-sum-not-live-memory-or-gc');
      expect(diagnostics.incompleteReasons).toEqual([]);
      const allocation = diagnostics.events.filter(event => event.kind === 'allocation-failed');
      expect(allocation, JSON.stringify(diagnostics)).toHaveLength(1);
      expect(allocation[0]).toMatchObject({
        loadOrdinal: 1, candidateOrdinal: 1, resource: path, requestedBytes,
        errorName: 'RangeError', candidateScopeAllocatedBytes: 0, returnedReadBufferBytes: 0,
        activeReadCount: 0, scope: 'active',
      });
      expect(diagnostics.events[0]).toMatchObject({ kind: 'load-start', priorRuntime: 'absent' });
      expect(diagnostics.events.find(event => event.kind === 'candidate-start')).toMatchObject({
        candidateOrdinal: 1, device: 'webgpu', dtype: 'q4f16', revision,
      });
      expect(diagnostics.events.filter(event => event.kind === 'allocation-attempt')).toEqual([
        expect.objectContaining({ resource: path, requestedBytes, readOrdinal: allocation[0]!.readOrdinal }),
      ]);
      expect(diagnostics.events.some(event => event.kind === 'load-failed')).toBe(true);
      expect(diagnostics.events.filter(event => event.kind === 'session-entering' || event.kind === 'allocation-succeeded')).toEqual([]);
      switch (collectionMode) {
      case 'available': expect(epoch.collection.status).toBe('returned'); expect(takeCalls).toEqual([1]); break;
      case 'session-inactive': case 'fatal-auto-retirement':
        expect(epoch.collection).toEqual({ status: 'unavailable', reason: 'session-inactive' });
        expect(epoch.lifetime.value.session).toBe('inactive'); expect(takeCalls).toEqual([]); break;
      case 'take-failed': expect(epoch.collection).toEqual({ status: 'failed', reason: 'take-failed' }); expect(takeCalls).toEqual([1]); break;
      default: { const exhaustive: never = collectionMode; throw new Error(String(exhaustive)); }
      }
      const { createProductionProviderNativeEvidence, verifyProductionProviderNativeEvidenceSidecar } = await import('@/features/transformers-js/model-support-investigation/logic/production-provider-native-evidence');
      const sidecar = await createProductionProviderNativeEvidence({ native: snapshot.native.capture, provider: snapshot.provider, maximumBinaryBytes: 65536 });
      expect(sidecar.summary).toMatchObject({ refusedEpochCount: 0, capturedCallCount: 0, enteredNativeInvocationCount: 0 });
      expect(sidecar.binaries).toEqual([]);
      expect(sidecar.json).not.toContain('Synthetic readResponse allocation refusal');
      expect(sidecar.json).not.toContain('transformers-js-fixes.mjs');
      await verifyProductionProviderNativeEvidenceSidecar({ evidence: structuredClone(sidecar), provider: snapshot.provider, maximumBinaryBytes: 65536 });
      const { createInitialInvestigationCheckpoint } = await import('@/features/transformers-js/model-support-investigation/logic/investigation-recovery');
      const { createPartialModelSupportEvidence } = await import('@/features/transformers-js/model-support-investigation/logic/create-partial-evidence');
      const { run, recovery } = createInitialInvestigationCheckpoint({ runId: provider.runId, modelId, now: () => '2026-09-13T00:00:00.000Z' });
      run.productionProviderCapture = snapshot.provider;
      const first = await createPartialModelSupportEvidence({ run, recovery, nativeEvidence: sidecar });
      await owner.dispose();
      expect(replacementOperations).toEqual(collectionMode === 'fatal-auto-retirement' ? ['dispose'] : []);
      const second = await createPartialModelSupportEvidence({ run, recovery, nativeEvidence: structuredClone(sidecar) });
      const firstZip = await JSZip.loadAsync(await first.blob.arrayBuffer());
      const secondZip = await JSZip.loadAsync(await second.blob.arrayBuffer());
      expect(await firstZip.file(sidecar.path)!.async('text')).toBe(sidecar.json);
      const exported: unknown = JSON.parse(await firstZip.file(sidecar.path)!.async('text'));
      expect(exported).toMatchObject({ epochs: expect.arrayContaining([
        expect.objectContaining({ workerEpoch: 1, lifetime: { status: 'observed', value: expect.objectContaining({ loadDiagnostics: diagnostics }) } }),
      ]) });
      const paths = Object.keys(firstZip.files).filter(path => !firstZip.files[path]!.dir).sort();
      expect(Object.keys(secondZip.files).filter(path => !secondZip.files[path]!.dir).sort()).toEqual(paths);
      for (const entry of paths) expect(await secondZip.file(entry)!.async('uint8array')).toEqual(await firstZip.file(entry)!.async('uint8array'));
      expect(takeCalls).toEqual(collectionMode === 'session-inactive' || collectionMode === 'fatal-auto-retirement' ? [] : [1]);
      expect(harness.observations.workers).toHaveLength(1);
      expect(harness.observations.workers[0]!.terminated).toBe(true);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      globalThis.Uint8Array = originalUint8Array;
      try {
        await owner.dispose();
      } finally {
        await harness.close();
      }
    }
  }, 30_000);

  it.each([
    { modelId: 'onnx-community/Qwen3.5-2B-ONNX', revision: 'b1fc7ca3afafcb8e4b13d29715a6b9ea5af1d1cb', extraShards: [] },
    { modelId: 'onnx-community/Qwen3.5-4B-ONNX', revision: '74d8caba2117fd5f41d655e9cc27eda1338662b3', extraShards: ['onnx/decoder_model_merged_q4f16.onnx_data_1'] },
  ])('retains $modelId actual image metadata and every preceding Full call through ZIP re-export', async ({ modelId, revision, extraShards }) => {
    const imageInputs: Array<{ original_sizes: unknown; reshaped_input_sizes: unknown }> = [];
    const boundary = 'Synthetic image input inspection only: no vision output evidence';
    const harness = await createProviderReplayTestRuntime({
      modelId, expectedRevision: revision, cacheRevision: revision, metadataCache: "all-fixture",
      imagePlatform: { platform: createProviderReplayTestImagePlatform(), allowedDataUrls: [image.dataUrl] },
      artifacts: [
        'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data',
        'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data',
        'onnx/vision_encoder_q4f16.onnx', 'onnx/vision_encoder_q4f16.onnx_data',
        ...extraShards,
      ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId, revision, path }) })),
      generate: async ({ options, tokenizer, runtime }) => {
        const input = options.input_ids;
        if (!(input instanceof runtime.Tensor) || !options.streamer) throw new Error('Expected native inputs and streamer');
        if (Object.hasOwn(options, 'original_sizes')) {
          imageInputs.push({ original_sizes: Reflect.get(options, 'original_sizes'), reshaped_input_sizes: Reflect.get(options, 'reshaped_input_sizes') });
          throw new Error(boundary);
        }
        // Preceding text calls exercise collection only, not model inference.
        const output = tokenizer.encode('Synthetic reply.', { add_special_tokens: false }).map(BigInt);
        options.streamer.put(input.tolist());
        options.streamer.put([output]);
        options.streamer.end();
        const sequence = [...input.data].map(BigInt).concat(output);
        return { sequences: new runtime.Tensor('int64', sequence, [1, sequence.length]) };
      },
    });
    const { createProductionProviderGenerationCaptureOwner } = await import('@/features/transformers-js/model-support-investigation/logic/production-provider-generation-capture-owner');
    const { createTransformersJsGenerationCaptureClient } = await import('@/features/transformers-js/worker/client-hosted');
    const owner = createProductionProviderGenerationCaptureOwner({
      runId: 'synthetic-qwen-image-metadata', modelId, plan: 'full-v2',
      traceLimits: { maximumEvents: 128, maximumCharacters: 8192 }, maximumWorkerEpochs: 8,
      createCaptureClient: ({ runId, workerEpoch, getActiveRequest }) => createTransformersJsGenerationCaptureClient({
        runId, workerEpoch, getActiveRequest,
        limits: { maxCalls: 32, maxInvocationsPerCall: 4, maxEvents: 2048, maxTextBytes: 131072,
          maxTensorBytes: 4 * 1024 * 1024, maxTotalTensorBytes: 16 * 1024 * 1024,
          maxTokensPerStreamEvent: 4096, maxTotalStreamTokens: 16384, maxTotalStreamTokenBytes: 262144 },
      }),
      createUnrecordedWorkerClient: () => {
        throw new Error('Unexpected replacement Worker');
      },
    });
    try {
      const provider = await owner.run();
      expect(provider.requests).toHaveLength(13);
      expect(provider.requests.slice(0, -1).map(request => request.trace.settled?.outcome)).toEqual(Array(12).fill({ status: 'fulfilled' }));
      expect(provider.requests.at(-1)?.trace.settled?.outcome).toMatchObject({ status: 'rejected' });
      expect(imageInputs).toEqual([{ original_sizes: [[1, 1]], reshaped_input_sizes: [[256, 256]] }]);
      await owner.collectNative();
      const snapshot = owner.snapshot();
      if (snapshot.native.status !== 'retained') throw new Error('Expected retained native collection');
      const collection = snapshot.native.capture.epochs[0]?.collection;
      if (collection?.status !== 'returned' || collection.result.status !== 'captured') throw new Error('Expected captured epoch');
      const capture = collection.result.capture;
      expect(capture.calls.map(call => call.context.requestId)).toEqual(provider.requests.map(request => request.requestId));
      expect(capture.incompleteReasons).toEqual([]);
      const imageEvents = capture.events.filter(event => event.kind === 'inputs' && event.identity.requestId === provider.requests.at(-1)!.requestId);
      expect(imageEvents).toHaveLength(2);
      for (const event of imageEvents) {
        if (event.kind !== 'inputs') throw new Error('Expected image inputs');
        expect(event.values.filter(value => value.name === 'original_sizes' || value.name === 'reshaped_input_sizes')).toEqual([
          { name: 'original_sizes', snapshot: { status: 'image-sizes', values: imageInputs[0]!.original_sizes } },
          { name: 'reshaped_input_sizes', snapshot: { status: 'image-sizes', values: imageInputs[0]!.reshaped_input_sizes } },
        ]);
      }
      const { createProductionProviderNativeEvidence, verifyProductionProviderNativeEvidenceSidecar } = await import('@/features/transformers-js/model-support-investigation/logic/production-provider-native-evidence');
      const sidecar = await createProductionProviderNativeEvidence({ native: snapshot.native.capture, provider: snapshot.provider, maximumBinaryBytes: 64 * 1024 * 1024 });
      expect(sidecar.summary).toMatchObject({ refusedEpochCount: 0, capturedCallCount: 13, enteredNativeInvocationCount: 13, unrecordedValueCount: 0 });
      await verifyProductionProviderNativeEvidenceSidecar({ evidence: structuredClone(sidecar), provider: snapshot.provider, maximumBinaryBytes: 64 * 1024 * 1024 });
      const { createInitialInvestigationCheckpoint } = await import('@/features/transformers-js/model-support-investigation/logic/investigation-recovery');
      const { createPartialModelSupportEvidence } = await import('@/features/transformers-js/model-support-investigation/logic/create-partial-evidence');
      const { run, recovery } = createInitialInvestigationCheckpoint({ runId: provider.runId, modelId, now: () => '2026-09-10T00:00:00.000Z' });
      run.productionProviderCapture = snapshot.provider;
      const first = await createPartialModelSupportEvidence({ run, recovery, nativeEvidence: sidecar });
      const second = await createPartialModelSupportEvidence({ run, recovery, nativeEvidence: structuredClone(sidecar) });
      const firstZip = await JSZip.loadAsync(await first.blob.arrayBuffer());
      const secondZip = await JSZip.loadAsync(await second.blob.arrayBuffer());
      expect(await firstZip.file(sidecar.path)!.async('text')).toBe(sidecar.json);
      const paths = Object.keys(firstZip.files).filter(path => !firstZip.files[path]!.dir).sort();
      expect(Object.keys(secondZip.files).filter(path => !secondZip.files[path]!.dir).sort()).toEqual(paths);
      for (const path of paths) {
        expect(await secondZip.file(path)!.async('uint8array')).toEqual(await firstZip.file(path)!.async('uint8array'));
      }
      expect(harness.observations.workers).toHaveLength(1);
      expect(harness.observations.forbiddenTransport).toEqual([]);
    } finally {
      try {
        await owner.dispose();
      } finally {
        await harness.close();
      }
    }
  }, 30_000);
  it('terminates the real session during an unresolved native call without collecting or inventing settlement at cutoff', async () => {
    let entered!: () => void;
    const nativeEntered = new Promise<void>(resolve => {
      entered = resolve;
    });
    let release!: () => void;
    const releaseNative = new Promise<void>(resolve => {
      release = resolve;
    });
    const harness = await createProviderReplayTestRuntime({
      modelId: 'HuggingFaceTB/SmolLM2-135M-Instruct',
      expectedRevision: '12fd25f77366fa6b3b4b768ec3050bf629380bac', cacheRevision: '12fd25f77366fa6b3b4b768ec3050bf629380bac', metadataCache: "all-fixture",
      artifacts: [{ path: 'onnx/model_q4f16.onnx', bytes: Uint8Array.of(1, 2, 3) }],
      imagePlatform: undefined,
      generate: async () => {
        entered();
        await releaseNative;
        // The Node fixture cannot kill its own Realm. Let its substituted
        // inference unwind only after the host's actual session has terminated.
        throw new Error('Synthetic inference released after physical session termination');
      },
    });
    const { createProductionProviderGenerationCaptureOwner } = await import('@/features/transformers-js/model-support-investigation/logic/production-provider-generation-capture-owner');
    const { createTransformersJsGenerationCaptureClient } = await import('@/features/transformers-js/worker/client-hosted');
    const takes: Array<ReturnType<typeof vi.fn<() => Promise<unknown>>>> = [];
    const unrecorded = vi.fn(() => {
      throw new Error('Stop must not create a replacement Worker');
    });
    const owner = createProductionProviderGenerationCaptureOwner({
      runId: 'synthetic-native-stop', modelId: 'HuggingFaceTB/SmolLM2-135M-Instruct',
      plan: 'first-continuity-independent', traceLimits: { maximumEvents: 64, maximumCharacters: 4096 },
      maximumWorkerEpochs: 8,
      createCaptureClient: ({ runId, workerEpoch, getActiveRequest }) => {
        const capture = createTransformersJsGenerationCaptureClient({
          runId, workerEpoch, getActiveRequest,
          limits: {
            maxCalls: 8, maxInvocationsPerCall: 4, maxEvents: 256, maxTextBytes: 8192,
            maxTensorBytes: 8192, maxTotalTensorBytes: 65536,
            maxTokensPerStreamEvent: 4096, maxTotalStreamTokens: 16384, maxTotalStreamTokenBytes: 262144,
          },
        });
        const take = vi.fn(capture.takeGenerationCapture);
        takes.push(take);
        return { ...capture, takeGenerationCapture: take };
      },
      createUnrecordedWorkerClient: unrecorded,
    });
    const running = owner.run();
    try {
      await nativeEntered;
      expect(owner.getProgress()).toMatchObject({ run: { status: 'running' }, settledRequests: 0, loadStatus: 'ready' });
      const worker = harness.observations.workers[0]!;
      const terminate = vi.spyOn(worker, 'terminate');
      owner.abort({ reason: 'user-requested' });
      const disposing = owner.dispose();
      // No timer, callback drain, native completion or collection await here.
      expect(worker.terminated).toBe(true);
      expect(terminate).toHaveBeenCalledOnce();
      const detached = owner.detachNativeCollection({ reason: 'user-requested' });
      if (detached.status !== 'detached') throw new Error('Expected one native ownership transfer');
      expect(detached.capture.phase).toBe('not-requested');
      expect(detached.cutoff.epochs.map(epoch => epoch.collectionStatus)).toEqual(['not-requested']);
      const cutoffProvider = owner.snapshot().provider;
      expect(cutoffProvider.run).toEqual({ status: 'running' });
      expect(cutoffProvider.requests[0]?.status).toBe('awaiting-settlement');
      expect(cutoffProvider.requests[0]?.trace.settled).toBeUndefined();
      await disposing;
      await expect(running).resolves.toMatchObject({ run: { status: 'stopped', reason: 'disposed' } });
      expect(owner.snapshot().native).toEqual({ status: 'released', cutoff: detached.cutoff });
      expect(cutoffProvider.requests[0]?.trace.settled).toBeUndefined();
      expect(takes).toHaveLength(1);
      expect(takes[0]).not.toHaveBeenCalled();
      expect(terminate).toHaveBeenCalledOnce();
      expect(unrecorded).not.toHaveBeenCalled();
      expect(harness.observations.ortCalls).toHaveLength(1);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      release();
      try {
        await owner.dispose();
        await running;
      } finally {
        await harness.close();
      }
    }
  }, 30_000);

  it('collects all immediate requests once with exact native stream grouping and no settlement repair', async () => {
    const nativeInputs: string[][] = [];
    const nativeOutputs: string[][] = [];
    const budgets: unknown[] = [];
    const harness = await createProviderReplayTestRuntime({
      modelId: 'HuggingFaceTB/SmolLM2-135M-Instruct',
      expectedRevision: '12fd25f77366fa6b3b4b768ec3050bf629380bac', cacheRevision: '12fd25f77366fa6b3b4b768ec3050bf629380bac', metadataCache: "all-fixture",
      artifacts: [{ path: 'onnx/model_q4f16.onnx', bytes: Uint8Array.of(1, 2, 3) }],
      imagePlatform: undefined,
      generate: async ({ options, tokenizer, runtime }) => {
        const input = options.input_ids;
        if (!(input instanceof runtime.Tensor) || !options.streamer) throw new Error('Expected real strategy input and streamer');
        const output = tokenizer.encode('Synthetic reply.', { add_special_tokens: false }).map(BigInt);
        nativeInputs.push(Array.from(input.data, String));
        nativeOutputs.push(output.map(String));
        budgets.push(options.max_new_tokens);
        // Deliberately retain a multi-token put group. Flattening it into
        // one-token events would silently change a later native stream replay.
        options.streamer.put(input.tolist());
        options.streamer.put([output]);
        options.streamer.end();
        return new runtime.Tensor('int64', BigInt64Array.from(output), [1, output.length]);
      },
    });
    // The harness isolates modules. Import the coordinator and hosted client
    // afterwards so both use its actual Production service/Worker realm.
    const { createProductionProviderGenerationCaptureOwner } = await import('@/features/transformers-js/model-support-investigation/logic/production-provider-generation-capture-owner');
    const { createTransformersJsGenerationCaptureClient } = await import('@/features/transformers-js/worker/client-hosted');
    const takeCalls: Array<ReturnType<typeof vi.fn<() => Promise<unknown>>>> = [];
    const unrecorded = vi.fn(() => {
      throw new Error('Unexpected extra Worker in single-realm collection control');
    });
    const owner = createProductionProviderGenerationCaptureOwner({
      runId: 'synthetic-native-collection', modelId: 'HuggingFaceTB/SmolLM2-135M-Instruct',
      plan: 'first-continuity-independent', traceLimits: { maximumEvents: 64, maximumCharacters: 4096 },
      maximumWorkerEpochs: 8,
      createCaptureClient: ({ runId, workerEpoch, getActiveRequest }) => {
        const capture = createTransformersJsGenerationCaptureClient({
          runId, workerEpoch, getActiveRequest,
          limits: {
            maxCalls: 8, maxInvocationsPerCall: 4, maxEvents: 256, maxTextBytes: 8192,
            maxTensorBytes: 8192, maxTotalTensorBytes: 65536,
            maxTokensPerStreamEvent: 4096, maxTotalStreamTokens: 16384, maxTotalStreamTokenBytes: 262144,
          },
        });
        const take = vi.fn(capture.takeGenerationCapture);
        takeCalls.push(take);
        return { ...capture, takeGenerationCapture: take };
      },
      createUnrecordedWorkerClient: unrecorded,
    });
    try {
      const provider = await owner.run();
      expect(provider.run).toEqual({ status: 'completed' });
      expect(provider.requests.map(request => request.status)).toEqual(['settled', 'settled', 'settled']);
      expect(budgets).toEqual([16, 16, 1]);
      expect(takeCalls).toHaveLength(1);
      expect(takeCalls[0]).not.toHaveBeenCalled();
      expect(owner.snapshot().native).toMatchObject({ status: 'retained', capture: { phase: 'not-requested' } });
      const collecting = owner.collectNative();
      expect(owner.collectNative()).toBe(collecting);
      await collecting;
      expect(owner.collectNative()).toBe(collecting);
      expect(takeCalls[0]).toHaveBeenCalledOnce();
      const snapshot = owner.snapshot();
      if (snapshot.native.status !== 'retained') throw new Error('Expected retained native collection');
      expect(snapshot.native.capture.phase).toBe('finished');
      expect(snapshot.native.capture.incompleteReasons).toEqual([]);
      expect(snapshot.native.capture.unrecordedWorkerCreations).toBe(0);
      expect(snapshot.native.capture.epochs).toHaveLength(1);
      const epoch = snapshot.native.capture.epochs[0]!;
      const contexts = provider.requests.map((request, index) => ({
        runId: 'synthetic-native-collection', workerEpoch: 1,
        requestId: request.requestId, generationCallId: index + 1,
      }));
      if (epoch.lifetime.status !== 'observed') throw new Error('Expected host-owned lifetime');
      const { loadDiagnostics, ...existingLifetime } = epoch.lifetime.value;
      expect(loadDiagnosticsSchema.parse(loadDiagnostics).events).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'allocation-succeeded', resource: 'onnx/model_q4f16.onnx', requestedBytes: 3 }),
        expect.objectContaining({ kind: 'session-fulfilled' }),
        expect.objectContaining({ kind: 'load-finished' }),
      ]));
      expect(existingLifetime).toEqual({
        runId: 'synthetic-native-collection', workerEpoch: 1, session: 'active',
        issuedCalls: contexts, incompleteReasons: [],
        // The host requests offline discovery; the Worker's exact selected
        // revision remains independently asserted in every call's loadIdentity.
        loadRequests: [{
          requestedModelId: 'HuggingFaceTB/SmolLM2-135M-Instruct',
          requestedRevision: undefined,
          revisionSelection: { kind: 'discover-cached' },
        }],
      });
      if (epoch.collection.status !== 'returned' || epoch.collection.result.status !== 'captured') throw new Error('Expected actual native capture result');
      const capture = epoch.collection.result.capture;
      expect(capture.calls).toEqual(contexts.map(context => ({ context, loadIdentity: {
        status: 'ready', workerLoadOrdinal: 1, requestedModelId: 'HuggingFaceTB/SmolLM2-135M-Instruct',
        requestedRevision: { status: 'provided', value: '12fd25f77366fa6b3b4b768ec3050bf629380bac' },
        cleanModelId: 'HuggingFaceTB/SmolLM2-135M-Instruct', autoClass: 'AutoModelForCausalLM', processor: 'tokenizer',
        selectedCandidate: { device: 'webgpu', dtype: 'q4f16' },
        resolvedRevision: { status: 'not-observed' }, sessionExecutionProvider: { status: 'not-observed' },
      }, outcome: 'fulfilled', invocations: [
        { nativeInvocationOrdinal: 1, stream: { status: 'available', restoration: 'restored' } },
      ] })));
      expect(capture.incompleteReasons).toEqual([]);
      expect(capture.events.filter(event => event.kind === 'native-stream')).toEqual(contexts.flatMap((context, index) => {
        const identity = { ...context, nativeInvocationOrdinal: 1 };
        const common = { kind: 'native-stream', identity };
        return [
          { ...common, operation: 'put', phase: 'entering', streamCallOrdinal: 1, detail: { kind: 'tokens', tokenType: 'bigint', groups: [nativeInputs[index]] } },
          { ...common, operation: 'put', phase: 'returned', streamCallOrdinal: 1, detail: { kind: 'none' } },
          { ...common, operation: 'put', phase: 'entering', streamCallOrdinal: 2, detail: { kind: 'tokens', tokenType: 'bigint', groups: [nativeOutputs[index]] } },
          { ...common, operation: 'on_finalized_text', phase: 'entering', streamCallOrdinal: 3, detail: { kind: 'finalized-text', text: 'Synthetic ', streamEnd: false } },
          { ...common, operation: 'on_finalized_text', phase: 'returned', streamCallOrdinal: 3, detail: { kind: 'none' } },
          { ...common, operation: 'put', phase: 'returned', streamCallOrdinal: 2, detail: { kind: 'none' } },
          { ...common, operation: 'end', phase: 'entering', streamCallOrdinal: 4, detail: { kind: 'none' } },
          { ...common, operation: 'on_finalized_text', phase: 'entering', streamCallOrdinal: 5, detail: { kind: 'finalized-text', text: 'reply.', streamEnd: true } },
          { ...common, operation: 'on_finalized_text', phase: 'returned', streamCallOrdinal: 5, detail: { kind: 'none' } },
          { ...common, operation: 'end', phase: 'returned', streamCallOrdinal: 4, detail: { kind: 'none' } },
        ];
      }));
      expect(snapshot.provider.requests.map(request => request.trace.settled)).toEqual(provider.requests.map(request => request.trace.settled));
      // Use the actual captured payload, not a hand-constructed native DTO, at
      // the encoder/ZIP boundary. Re-export must not take again or run a model.
      const nativeEvidenceModule = await import('@/features/transformers-js/model-support-investigation/logic/production-provider-native-evidence');
      const { createInitialInvestigationCheckpoint } = await import('@/features/transformers-js/model-support-investigation/logic/investigation-recovery');
      const { createPartialModelSupportEvidence } = await import('@/features/transformers-js/model-support-investigation/logic/create-partial-evidence');
      const activityBeforeExport = {
        sessionCreations: harness.observations.ortCalls.length,
        cacheOperations: harness.observations.fs.activity.length,
        fetchCalls: harness.observations.fetchCalls.length,
      };
      const nativeEvidence = await nativeEvidenceModule.createProductionProviderNativeEvidence({
        provider: snapshot.provider, native: snapshot.native.capture,
        maximumBinaryBytes: nativeEvidenceModule.PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES,
      });
      expect(nativeEvidence.summary).toEqual({
        phase: 'finished', refusedEpochCount: 0, recording: 'recorded', capturedCallCount: 3, enteredNativeInvocationCount: 3,
        issuedNotObservedCallCount: 0, unavailableEpochCount: 0, incompleteEpochCount: 0,
        unobservedLoadCount: 0, incompleteInvocationCount: 0, unrecordedValueCount: 0,
      });
      expect(nativeEvidence.binaries.length).toBeGreaterThan(0);
      const { run, recovery } = createInitialInvestigationCheckpoint({
        runId: provider.runId, modelId: provider.modelId, now: () => '2026-09-09T00:00:00.000Z',
      });
      run.productionProviderCapture = snapshot.provider;
      const encode = vi.spyOn(nativeEvidenceModule, 'createProductionProviderNativeEvidence');
      try {
        const first = await createPartialModelSupportEvidence({ run, recovery, nativeEvidence });
        const second = await createPartialModelSupportEvidence({ run, recovery, nativeEvidence: structuredClone(nativeEvidence) });
        const firstZip = await JSZip.loadAsync(await first.blob.arrayBuffer());
        const secondZip = await JSZip.loadAsync(await second.blob.arrayBuffer());
        expect(await firstZip.file(nativeEvidence.path)!.async('text')).toBe(nativeEvidence.json);
        for (const binary of nativeEvidence.binaries) {
          expect(await firstZip.file(binary.path)!.async('uint8array')).toEqual(new Uint8Array(await binary.blob.arrayBuffer()));
        }
        const firstPaths = Object.keys(firstZip.files).filter(path => !firstZip.files[path]!.dir).sort();
        expect(Object.keys(secondZip.files).filter(path => !secondZip.files[path]!.dir).sort()).toEqual(firstPaths);
        for (const path of firstPaths) {
          expect(await secondZip.file(path)!.async('uint8array')).toEqual(await firstZip.file(path)!.async('uint8array'));
        }
        expect(encode).not.toHaveBeenCalled();
      } finally {
        encode.mockRestore();
      }
      expect(takeCalls[0]).toHaveBeenCalledOnce();
      expect(budgets).toEqual([16, 16, 1]);
      expect({
        sessionCreations: harness.observations.ortCalls.length,
        cacheOperations: harness.observations.fs.activity.length,
        fetchCalls: harness.observations.fetchCalls.length,
      }).toEqual(activityBeforeExport);
      expect(unrecorded).not.toHaveBeenCalled();
      expect(harness.observations.workers).toHaveLength(1);
      expect(harness.service.getState().status).toBe('idle');
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      try {
        await owner.dispose();
      } finally {
        await harness.close();
      }
    }
  }, 30_000);

  it('collects the full fixed script through one real loaded runtime without inter-request capture reads', async () => {
    const budgets: unknown[] = [];
    const harness = await createProviderReplayTestRuntime({
      modelId: 'HuggingFaceTB/SmolLM2-135M-Instruct',
      expectedRevision: '12fd25f77366fa6b3b4b768ec3050bf629380bac', cacheRevision: '12fd25f77366fa6b3b4b768ec3050bf629380bac', metadataCache: "all-fixture",
      artifacts: [{ path: 'onnx/model_q4f16.onnx', bytes: Uint8Array.of(1, 2, 3) }],
      imagePlatform: undefined,
      generate: async ({ options, tokenizer, runtime }) => {
        const input = options.input_ids;
        if (!(input instanceof runtime.Tensor) || !options.streamer) throw new Error('Expected real strategy input and streamer');
        // Synthetic inference never emits a tool call. This checks collection
        // coverage, not weather-tool use or this text-only model's image ability.
        const output = tokenizer.encode('Synthetic reply.', { add_special_tokens: false }).map(BigInt);
        budgets.push(options.max_new_tokens);
        options.streamer.put(input.tolist());
        options.streamer.put([output]);
        options.streamer.end();
        return new runtime.Tensor('int64', BigInt64Array.from(output), [1, output.length]);
      },
    });
    const { createProductionProviderGenerationCaptureOwner } = await import('@/features/transformers-js/model-support-investigation/logic/production-provider-generation-capture-owner');
    const { createTransformersJsGenerationCaptureClient } = await import('@/features/transformers-js/worker/client-hosted');
    const takeCalls: Array<ReturnType<typeof vi.fn<() => Promise<unknown>>>> = [];
    const unrecorded = vi.fn(() => {
      throw new Error('The Full script must not create a replacement Worker');
    });
    const owner = createProductionProviderGenerationCaptureOwner({
      runId: 'synthetic-full-collection', modelId: 'HuggingFaceTB/SmolLM2-135M-Instruct',
      plan: 'full-v2', traceLimits: { maximumEvents: 64, maximumCharacters: 4096 },
      maximumWorkerEpochs: 8,
      createCaptureClient: ({ runId, workerEpoch, getActiveRequest }) => {
        const capture = createTransformersJsGenerationCaptureClient({
          runId, workerEpoch, getActiveRequest,
          limits: {
            maxCalls: 32, maxInvocationsPerCall: 4, maxEvents: 2048, maxTextBytes: 131072,
            maxTensorBytes: 1048576, maxTotalTensorBytes: 8388608,
            maxTokensPerStreamEvent: 4096, maxTotalStreamTokens: 16384, maxTotalStreamTokenBytes: 262144,
          },
        });
        const take = vi.fn(capture.takeGenerationCapture);
        takeCalls.push(take);
        return { ...capture, takeGenerationCapture: take };
      },
      createUnrecordedWorkerClient: unrecorded,
    });
    try {
      const provider = await owner.run();
      expect(provider.run).toEqual({ status: 'completed' });
      expect(provider.requests.map(request => request.scenario)).toEqual([
        'first-turn', 'continuity', 'independent-next-input', 'system-user', 'supplied-history',
        'reasoning-none', 'reasoning-low', 'reasoning-medium', 'reasoning-high',
        'natural-tool-minimal', 'natural-tool-representative', 'structured-tool-history', 'image',
      ]);
      expect(provider.requests.map(request => request.status)).toEqual(Array(13).fill('settled'));
      expect(provider.requests.map(request => request.notStartedReason)).toEqual(Array(13).fill(undefined));
      expect(provider.requests.map(request => request.trace.settled?.outcome)).toEqual(Array(13).fill({ status: 'fulfilled' }));
      expect(provider.requests.map(request => request.trace.limits)).toEqual(Array(13).fill({
        maximumEvents: 64, maximumCharacters: 4096, maximumFieldCharacters: 16384,
      }));
      expect(budgets).toEqual([16, 16, 1, 1, 1, 1, 1, 1, 1, 128, 128, 128, 1]);
      expect(takeCalls).toHaveLength(1);
      expect(takeCalls[0]).not.toHaveBeenCalled();
      await owner.collectNative();
      expect(takeCalls[0]).toHaveBeenCalledOnce();
      const snapshot = owner.snapshot();
      if (snapshot.native.status !== 'retained') throw new Error('Expected retained Full native collection');
      expect(snapshot.native.capture.phase).toBe('finished');
      expect(snapshot.native.capture.epochs).toHaveLength(1);
      const epoch = snapshot.native.capture.epochs[0]!;
      if (epoch.collection.status !== 'returned' || epoch.collection.result.status !== 'captured') throw new Error('Expected Full native capture');
      expect(epoch.collection.result.capture.calls.map(call => call.context.requestId)).toEqual(provider.requests.map(request => request.requestId));
      expect(epoch.collection.result.capture.calls.map(call => call.loadIdentity)).toEqual(Array(13).fill({
        status: 'ready', workerLoadOrdinal: 1, requestedModelId: 'HuggingFaceTB/SmolLM2-135M-Instruct',
        requestedRevision: { status: 'provided', value: '12fd25f77366fa6b3b4b768ec3050bf629380bac' },
        cleanModelId: 'HuggingFaceTB/SmolLM2-135M-Instruct', autoClass: 'AutoModelForCausalLM', processor: 'tokenizer',
        selectedCandidate: { device: 'webgpu', dtype: 'q4f16' },
        resolvedRevision: { status: 'not-observed' }, sessionExecutionProvider: { status: 'not-observed' },
      }));
      expect(epoch.collection.result.capture.incompleteReasons).toEqual([]);
      const { createProductionProviderNativeEvidence, verifyProductionProviderNativeEvidenceSidecar } = await import('@/features/transformers-js/model-support-investigation/logic/production-provider-native-evidence');
      const nativeEvidence = await createProductionProviderNativeEvidence({
        provider: snapshot.provider, native: snapshot.native.capture, maximumBinaryBytes: 64 * 1024 * 1024,
      });
      expect(nativeEvidence.summary).toEqual({
        phase: 'finished', refusedEpochCount: 0, recording: 'recorded', capturedCallCount: 13, enteredNativeInvocationCount: 13,
        issuedNotObservedCallCount: 0, unavailableEpochCount: 0, incompleteEpochCount: 0,
        unobservedLoadCount: 0, incompleteInvocationCount: 0, unrecordedValueCount: 0,
      });
      await expect(verifyProductionProviderNativeEvidenceSidecar({
        evidence: structuredClone(nativeEvidence), provider: snapshot.provider, maximumBinaryBytes: 64 * 1024 * 1024,
      })).resolves.toEqual(nativeEvidence);
      expect(takeCalls[0]).toHaveBeenCalledOnce();
      expect(unrecorded).not.toHaveBeenCalled();
      expect(harness.observations.workers).toHaveLength(1);
      expect(harness.observations.ortCalls).toHaveLength(1);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      try {
        await owner.dispose();
      } finally {
        await harness.close();
      }
    }
  }, 30_000);
});
