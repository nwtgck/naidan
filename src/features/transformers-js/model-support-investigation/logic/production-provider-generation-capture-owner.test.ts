// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransformersJsWorkerClient } from '@/features/transformers-js/types';
import type { GenerationCaptureReadResult, GenerationCaptureRequest } from '@/features/transformers-js/worker/generation-capture-protocol';
import { createMemoryFiles } from '@/features/transformers-js/download-verification/fixtures/raw-download-replay/memory-files';
import { createProductionProviderGenerationCaptureOwner } from './production-provider-generation-capture-owner';

type OwnerArguments = Parameters<typeof createProductionProviderGenerationCaptureOwner>[0];
const owners: Array<{ dispose(): Promise<void> }> = [];
let fs: ReturnType<typeof createMemoryFiles>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function captureFixture({ runId, workerEpoch, getActiveRequest }: Parameters<OwnerArguments['createCaptureClient']>[0]) {
  let session: 'active' | 'inactive' = 'active';
  const issuedCalls: GenerationCaptureRequest['context'][] = [];
  const client = {
    loadDownloadedModel: vi.fn<TransformersJsWorkerClient['loadDownloadedModel']>().mockResolvedValue({ device: 'webgpu' }),
    generateText: vi.fn<TransformersJsWorkerClient['generateText']>(async ({ onChunk }) => {
      const request = getActiveRequest();
      if (request === undefined) throw new Error('Expected active synthetic Provider request');
      issuedCalls.push({ runId, workerEpoch, requestId: request.requestId, generationCallId: issuedCalls.length + 1 });
      onChunk({ chunk: 'Synthetic reply.' });
    }),
    interrupt: vi.fn<TransformersJsWorkerClient['interrupt']>().mockResolvedValue(undefined),
    unloadModel: vi.fn<TransformersJsWorkerClient['unloadModel']>().mockResolvedValue(undefined),
    resetCache: vi.fn<TransformersJsWorkerClient['resetCache']>().mockResolvedValue(undefined),
    dispose: vi.fn<TransformersJsWorkerClient['dispose']>(async () => {
      session = 'inactive';
    }),
  } satisfies TransformersJsWorkerClient;
  return {
    client,
    takeGenerationCapture: vi.fn<() => Promise<GenerationCaptureReadResult>>().mockResolvedValue({ status: 'not-started' }),
    getCaptureLifetime: vi.fn(() => ({
      runId, workerEpoch, session,
      issuedCalls: issuedCalls.map(context => ({ ...context })), loadRequests: [], incompleteReasons: [],
    })),
  };
}

function createOwner({ maximumWorkerEpochs, plan }: { maximumWorkerEpochs: number; plan: OwnerArguments['plan'] }) {
  const captures: ReturnType<typeof captureFixture>[] = [];
  const createCaptureClient = vi.fn<OwnerArguments['createCaptureClient']>(input => {
    const capture = captureFixture(input);
    captures.push(capture);
    return capture;
  });
  const unrecorded = captureFixture({ runId: 'unrecorded', workerEpoch: 1, getActiveRequest: () => undefined }).client;
  const createUnrecordedWorkerClient = vi.fn(() => unrecorded);
  const owner = createProductionProviderGenerationCaptureOwner({
    runId: 'synthetic-run', modelId: 'fixture/model', plan,
    traceLimits: { maximumEvents: 100, maximumCharacters: 4096 }, maximumWorkerEpochs,
    createCaptureClient, createUnrecordedWorkerClient,
  });
  owners.push(owner);
  return { owner, captures, createCaptureClient, createUnrecordedWorkerClient, unrecorded };
}

function retainedNative({ owner }: { owner: ReturnType<typeof createProductionProviderGenerationCaptureOwner> }) {
  const native = owner.snapshot().native;
  expect(native.status).toBe('retained');
  if (native.status !== 'retained') throw new Error('Expected retained native collection');
  return native.capture;
}

function nativeResult({ workerEpoch }: { workerEpoch: number }): GenerationCaptureReadResult {
  const context = { runId: 'synthetic-run', workerEpoch, requestId: 'synthetic-run-first-turn', generationCallId: 1 };
  const identity = { ...context, nativeInvocationOrdinal: 1 };
  return { status: 'captured', capture: {
    schemaVersion: 1, runId: context.runId, workerEpoch, byteOrder: 'little-endian',
    limits: { maxCalls: 32, maxInvocationsPerCall: 8, maxEvents: 4096, maxTextBytes: 262144, maxTensorBytes: 16777216, maxTotalTensorBytes: 67108864, maxTokensPerStreamEvent: 65536, maxTotalStreamTokens: 262144, maxTotalStreamTokenBytes: 8388608 },
    calls: [{ context, loadIdentity: { status: 'not-observed', reason: 'no-completed-load' }, outcome: 'fulfilled', invocations: [{ nativeInvocationOrdinal: 1, stream: { status: 'not-attempted' } }] }],
    events: [
      { kind: 'inputs', identity, phase: 'native-kwargs', values: [{ name: 'input_ids', snapshot: { status: 'captured', dtype: 'uint8', dims: [2], byteLength: 2, bytes: Uint8Array.of(5, 6) } }] },
      { kind: 'chunk', identity, phase: 'strategy-raw', text: 'Synthetic raw capture content.' },
    ], incompleteReasons: [], unobserved: ['native-stop-cause', 'native-forward-input', 'kv-bytes'],
  } };
}

beforeEach(() => {
  fs = createMemoryFiles();
  fs.enter({ nextPhase: 'load', mutationPolicy: 'read-only' });
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => fs.root } });
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('Collection tests forbid network access');
  }));
});

afterEach(async () => {
  try {
    await Promise.all(owners.splice(0).map(owner => owner.dispose().catch(() => undefined)));
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

// The Provider and service are real. Only the Worker-client and read-only OPFS
// platform boundaries are controlled; native/Comlink timing has separate tests.
describe('Provider native generation collection ownership', () => {
  it('samples only the Provider without inspecting native lifetime observers or taking capture', async () => {
    const { owner, captures } = createOwner({ maximumWorkerEpochs: 8, plan: 'first-only' });
    await owner.run();
    const capture = captures[0]!;
    capture.getCaptureLifetime.mockClear();
    capture.getCaptureLifetime.mockImplementation(() => {
      throw new Error('Native lifetime must not be sampled');
    });
    const provider = owner.snapshotProvider();
    expect(provider.run.status).toBe('completed');
    expect(provider.requests[0]?.status).toBe('settled');
    expect(capture.getCaptureLifetime).not.toHaveBeenCalled();
    expect(capture.takeGenerationCapture).not.toHaveBeenCalled();
  });

  it('delegates lightweight Provider progress without reading native lifetime or collecting', async () => {
    const { owner, captures, createCaptureClient } = createOwner({ maximumWorkerEpochs: 8, plan: 'first-only' });
    expect(owner.getProgress()).toMatchObject({ runId: 'synthetic-run', run: { status: 'not-started' }, totalRequests: 1, selectedRequests: 1, settledRequests: 0, loadStatus: 'idle' });
    expect(createCaptureClient).not.toHaveBeenCalled();
    await owner.run();
    expect(owner.getProgress()).toMatchObject({ run: { status: 'completed' }, settledRequests: 1, loadStatus: 'ready' });
    expect(Object.isFrozen(owner.getProgress())).toBe(true);
    expect(captures[0]!.getCaptureLifetime).not.toHaveBeenCalled();
    expect(captures[0]!.takeGenerationCapture).not.toHaveBeenCalled();
  });

  it('does not recreate native retention if an aborted request triggers a later ordinary service restart', async () => {
    const { owner, captures, createCaptureClient, createUnrecordedWorkerClient } = createOwner({ maximumWorkerEpochs: 8, plan: 'first-only' });
    const entered = deferred<void>();
    const pending = deferred<void>();
    createCaptureClient.mockImplementationOnce(input => {
      const capture = captureFixture(input);
      captures.push(capture);
      capture.client.generateText.mockImplementation(async () => {
        entered.resolve(); await pending.promise;
      });
      return capture;
    });
    const running = owner.run();
    await entered.promise;
    owner.abort({ reason: 'deadline' });
    const detached = owner.detachNativeCollection({ reason: 'run-deadline' });
    if (detached.status !== 'detached') throw new Error('Expected native ownership transfer');
    pending.reject(new Error('Synthetic allocation failed'));
    await running;
    expect(createCaptureClient).toHaveBeenCalledOnce();
    expect(createUnrecordedWorkerClient).toHaveBeenCalledOnce();
    expect(detached.cutoff.unrecordedWorkerCreations).toBe(0);
    expect(owner.snapshot().native).toEqual({ status: 'released', cutoff: detached.cutoff });
    expect(captures[0]!.takeGenerationCapture).not.toHaveBeenCalled();
  });

  it('never reads native text or host lifetime accessors into the small cutoff', async () => {
    const { owner, captures } = createOwner({ maximumWorkerEpochs: 8, plan: 'first-only' });
    await owner.run();
    const lifetime = captures[0]!.getCaptureLifetime();
    const getter = vi.fn(() => {
      throw new Error('Private host field');
    });
    Object.defineProperty(lifetime, 'session', { get: getter });
    captures[0]!.getCaptureLifetime.mockReturnValue(lifetime);
    owner.abort({ reason: 'user-requested' });
    const detached = owner.detachNativeCollection({ reason: 'user-requested' });
    if (detached.status !== 'detached') throw new Error('Expected native ownership transfer');
    expect(detached.cutoff.epochs[0]?.lifetime).toEqual({ status: 'unavailable' });
    expect(getter).not.toHaveBeenCalled();
    expect(JSON.stringify(detached.cutoff)).not.toContain('Private');
  });

  it('does not adopt a late successful take after disposal and synchronous detach', async () => {
    const { owner, captures } = createOwner({ maximumWorkerEpochs: 8, plan: 'first-only' });
    await owner.run();
    const pendingTake = deferred<GenerationCaptureReadResult>();
    captures[0]!.takeGenerationCapture.mockReturnValue(pendingTake.promise);
    const collecting = owner.collectNative();
    const disposal = owner.dispose();
    expect(captures[0]!.client.dispose).toHaveBeenCalledOnce();
    const detached = owner.detachNativeCollection({ reason: 'disposed' });
    expect(detached.status).toBe('detached');
    if (detached.status !== 'detached') throw new Error('Expected first detach');
    expect(detached.capture.phase).toBe('collecting');
    expect(detached.capture.epochs[0]?.collection).toEqual({ status: 'pending' });
    pendingTake.resolve(nativeResult({ workerEpoch: 1 }));
    await collecting;
    await disposal;
    expect(owner.snapshot().native).toEqual({ status: 'released', cutoff: detached.cutoff });
    expect(detached.capture.epochs[0]?.collection).toEqual({ status: 'pending' });
    expect(owner.detachNativeCollection({ reason: 'user-requested' })).toEqual({ status: 'already-detached', cutoff: detached.cutoff });
    await expect(owner.collectNative()).rejects.toThrow('Native capture collection has been released');
    expect(captures[0]!.takeGenerationCapture).toHaveBeenCalledOnce();
  });

  it('transfers a finished raw result once and retains no raw payload in subsequent owner snapshots', async () => {
    const { owner, captures } = createOwner({ maximumWorkerEpochs: 8, plan: 'first-only' });
    await owner.run();
    const raw = nativeResult({ workerEpoch: 1 });
    captures[0]!.takeGenerationCapture.mockResolvedValue(raw);
    await owner.collectNative();
    const externalBeforeDetach = retainedNative({ owner });
    const detached = owner.detachNativeCollection({ reason: 'normal-completion' });
    if (detached.status !== 'detached') throw new Error('Expected native ownership transfer');
    expect(detached.capture.epochs[0]?.collection).toEqual({ status: 'returned', result: raw });
    expect(detached.cutoff).toEqual({
      format: 'production-provider-native-cutoff-v1', runId: 'synthetic-run', reason: 'normal-completion', phaseAtCutoff: 'finished',
      maximumWorkerEpochs: 8, unrecordedWorkerCreations: 0, incompleteReasons: [],
      epochs: [{ workerEpoch: 1, lifetime: { status: 'observed', session: 'active', issuedCallCount: 1, loadRequestCount: 0 }, collectionStatus: 'returned' }],
    });
    expect(Object.isFrozen(detached.cutoff)).toBe(true);
    expect(Object.isFrozen(detached.cutoff.epochs[0]?.lifetime)).toBe(true);
    expect(JSON.stringify(owner.snapshot().native)).not.toContain('Synthetic raw capture content.');
    expect(owner.snapshot().native).toEqual({ status: 'released', cutoff: detached.cutoff });
    expect(owner.detachNativeCollection({ reason: 'disposed' })).toEqual({ status: 'already-detached', cutoff: detached.cutoff });
    expect(captures[0]!.client.dispose).not.toHaveBeenCalled();
    // Previously returned raw snapshots are external ownership and are not
    // revoked or overwritten by dropping the owner's own retention.
    expect(externalBeforeDetach.epochs[0]?.collection).toEqual({ status: 'returned', result: raw });
    await expect(owner.collectNative()).rejects.toThrow('Native capture collection has been released');
    expect(captures[0]!.takeGenerationCapture).toHaveBeenCalledOnce();
  });

  it('keeps a pending take and its not-requested suffix at cutoff without starting the next epoch after a late rejection', async () => {
    const { owner, captures, createCaptureClient } = createOwner({ maximumWorkerEpochs: 8, plan: 'first-only' });
    createCaptureClient.mockImplementationOnce(input => {
      const capture = captureFixture(input);
      captures.push(capture);
      capture.client.generateText.mockRejectedValue(new Error('Synthetic allocation failed'));
      // This adversarial host boundary reports an old epoch as still active.
      // The service's original eager restart/disposal behavior is unchanged.
      capture.getCaptureLifetime.mockImplementation(() => ({ runId: input.runId, workerEpoch: input.workerEpoch, session: 'active', issuedCalls: [], loadRequests: [], incompleteReasons: [] }));
      return capture;
    });
    await owner.run();
    expect(captures).toHaveLength(2);
    const pending = deferred<GenerationCaptureReadResult>();
    captures[0]!.takeGenerationCapture.mockReturnValue(pending.promise);
    const collecting = owner.collectNative();
    owner.abort({ reason: 'deadline' });
    const detached = owner.detachNativeCollection({ reason: 'collection-deadline' });
    if (detached.status !== 'detached') throw new Error('Expected native ownership transfer');
    expect(detached.capture.epochs.map(epoch => epoch.collection.status)).toEqual(['pending', 'not-requested']);
    pending.reject(new Error('Private late take failure must not be captured'));
    await collecting;
    expect(captures[1]!.takeGenerationCapture).not.toHaveBeenCalled();
    expect(owner.snapshot().native).toEqual({ status: 'released', cutoff: detached.cutoff });
    expect(detached.cutoff.phaseAtCutoff).toBe('collecting');
    expect(JSON.stringify(detached.cutoff)).not.toContain('Private');
  });

  it('preserves a returned prefix beside a pending epoch when the collection deadline closes adoption', async () => {
    const { owner, captures, createCaptureClient } = createOwner({ maximumWorkerEpochs: 8, plan: 'first-only' });
    createCaptureClient.mockImplementationOnce(input => {
      const capture = captureFixture(input);
      captures.push(capture);
      capture.client.generateText.mockRejectedValue(new Error('Synthetic allocation failed'));
      capture.getCaptureLifetime.mockImplementation(() => ({ runId: input.runId, workerEpoch: input.workerEpoch, session: 'active', issuedCalls: [], loadRequests: [], incompleteReasons: [] }));
      return capture;
    });
    await owner.run();
    const first = nativeResult({ workerEpoch: 1 });
    captures[0]!.takeGenerationCapture.mockResolvedValue(first);
    const enteredSecond = deferred<void>();
    const second = deferred<GenerationCaptureReadResult>();
    captures[1]!.takeGenerationCapture.mockImplementation(() => {
      enteredSecond.resolve(); return second.promise;
    });
    const collecting = owner.collectNative();
    await enteredSecond.promise;
    owner.abort({ reason: 'deadline' });
    const detached = owner.detachNativeCollection({ reason: 'collection-deadline' });
    if (detached.status !== 'detached') throw new Error('Expected native ownership transfer');
    expect(detached.capture.epochs.map(epoch => epoch.collection)).toEqual([{ status: 'returned', result: first }, { status: 'pending' }]);
    second.resolve(nativeResult({ workerEpoch: 2 }));
    await collecting;
    expect(detached.cutoff.epochs.map(epoch => epoch.collectionStatus)).toEqual(['returned', 'pending']);
    expect(owner.snapshot().native).toEqual({ status: 'released', cutoff: detached.cutoff });
  });

  it('rejects normal detach before collection and interruption detach without an abort or disposal request', async () => {
    const { owner, captures, createCaptureClient } = createOwner({ maximumWorkerEpochs: 8, plan: 'first-only' });
    expect(() => owner.detachNativeCollection({ reason: 'normal-completion' })).toThrow('requires completed collection');
    expect(() => owner.detachNativeCollection({ reason: 'run-deadline' })).toThrow('requires abort or disposal');
    expect(createCaptureClient).not.toHaveBeenCalled();
    await owner.run();
    expect(() => owner.detachNativeCollection({ reason: 'normal-completion' })).toThrow('requires completed collection');
    const pending = deferred<GenerationCaptureReadResult>();
    captures[0]!.takeGenerationCapture.mockReturnValue(pending.promise);
    const collecting = owner.collectNative();
    expect(() => owner.detachNativeCollection({ reason: 'normal-completion' })).toThrow('requires completed collection');
    owner.abort({ reason: 'user-requested' });
    const detached = owner.detachNativeCollection({ reason: 'user-requested' });
    expect(detached.status).toBe('detached');
    pending.resolve({ status: 'not-started' });
    await collecting;
  });

  it('releases unstarted collection while the actual Provider request is still awaiting its direct settlement', async () => {
    const { owner, captures, createCaptureClient } = createOwner({ maximumWorkerEpochs: 8, plan: 'first-only' });
    const entered = deferred<void>();
    const pending = deferred<void>();
    createCaptureClient.mockImplementationOnce(input => {
      const capture = captureFixture(input);
      captures.push(capture);
      capture.client.generateText.mockImplementation(async () => {
        entered.resolve(); await pending.promise;
      });
      return capture;
    });
    const running = owner.run();
    await entered.promise;
    expect(() => owner.detachNativeCollection({ reason: 'run-deadline' })).toThrow('requires abort or disposal');
    owner.abort({ reason: 'deadline' });
    const detached = owner.detachNativeCollection({ reason: 'run-deadline' });
    if (detached.status !== 'detached') throw new Error('Expected native ownership transfer');
    expect(detached.capture.phase).toBe('not-requested');
    expect(detached.capture.epochs[0]?.collection.status).toBe('not-requested');
    expect(owner.snapshot().provider.run.status).toBe('running');
    expect(owner.snapshot().provider.requests[0]?.status).toBe('awaiting-settlement');
    expect(captures[0]!.takeGenerationCapture).not.toHaveBeenCalled();
    pending.resolve();
    await running;
    expect(owner.snapshot().native).toEqual({ status: 'released', cutoff: detached.cutoff });
    expect(owner.snapshot().provider.run).toEqual({ status: 'stopped', reason: 'aborted' });
  });

  it('rejects collection before the script without creating any Worker', async () => {
    const { owner, createCaptureClient } = createOwner({ maximumWorkerEpochs: 8, plan: 'first-only' });
    await expect(owner.collectNative()).rejects.toThrow('requires the Provider script to have stopped');
    expect(createCaptureClient).not.toHaveBeenCalled();
    expect(retainedNative({ owner })).toEqual({
      format: 'production-provider-native-collection-v1', runId: 'synthetic-run', maximumWorkerEpochs: 8,
      phase: 'not-requested', unrecordedWorkerCreations: 0, incompleteReasons: [], epochs: [],
    });
  });

  it('rejects collection while a Provider request is pending without awaiting or interrupting it', async () => {
    const { owner, captures, createCaptureClient } = createOwner({ maximumWorkerEpochs: 8, plan: 'first-only' });
    const entered = deferred<void>();
    const release = deferred<void>();
    createCaptureClient.mockImplementationOnce(input => {
      const capture = captureFixture(input);
      captures.push(capture);
      capture.client.generateText.mockImplementation(async () => {
        entered.resolve(); await release.promise;
      });
      return capture;
    });
    const running = owner.run();
    await entered.promise;
    try {
      await expect(owner.collectNative()).rejects.toThrow('requires the Provider script to have stopped');
      expect(captures[0]!.takeGenerationCapture).not.toHaveBeenCalled();
      expect(captures[0]!.client.interrupt).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await running;
    }
  });

  it('runs immediate continuity before collecting once and reuses the same collection result', async () => {
    const { owner, captures, createCaptureClient } = createOwner({ maximumWorkerEpochs: 8, plan: 'first-continuity-independent' });
    const provider = await owner.run();
    expect(createCaptureClient).toHaveBeenCalledOnce();
    expect(captures[0]!.client.generateText).toHaveBeenCalledTimes(3);
    expect(captures[0]!.takeGenerationCapture).not.toHaveBeenCalled();
    expect(provider.requests[1]!.input!.messages).toEqual([
      { role: 'user', content: 'Template probe user message.' },
      { role: 'assistant', content: 'Synthetic reply.' },
      { role: 'user', content: 'Continue the synthetic conversation with a short response.' },
    ]);
    const collecting = owner.collectNative();
    expect(owner.collectNative()).toBe(collecting);
    await collecting;
    expect(owner.collectNative()).toBe(collecting);
    expect(captures[0]!.takeGenerationCapture).toHaveBeenCalledOnce();
    expect(retainedNative({ owner }).phase).toBe('finished');
    expect(retainedNative({ owner }).epochs.map(epoch => epoch.collection)).toEqual([
      { status: 'returned', result: { status: 'not-started' } },
    ]);
    expect(owner.snapshot().provider.requests.map(request => request.trace.settled)).toEqual(provider.requests.map(request => request.trace.settled));
    expect(captures[0]!.client.loadDownloadedModel).toHaveBeenCalledOnce();
    expect(captures[0]!.client.dispose).not.toHaveBeenCalled();
  });

  it('preserves a busy response instead of silently retrying or draining', async () => {
    const { owner, captures } = createOwner({ maximumWorkerEpochs: 8, plan: 'first-only' });
    await owner.run();
    captures[0]!.takeGenerationCapture.mockResolvedValue({ status: 'busy' });
    await owner.collectNative();
    await owner.collectNative();
    expect(captures[0]!.takeGenerationCapture).toHaveBeenCalledOnce();
    expect(retainedNative({ owner }).epochs[0]!.collection).toEqual({ status: 'returned', result: { status: 'busy' } });
  });

  it('keeps collection failure separate from a successful Provider and never exports its raw error', async () => {
    const { owner, captures } = createOwner({ maximumWorkerEpochs: 8, plan: 'first-only' });
    const provider = await owner.run();
    captures[0]!.takeGenerationCapture.mockRejectedValue(new Error('Private synthetic diagnostic detail'));
    await owner.collectNative();
    await owner.collectNative();
    expect(retainedNative({ owner }).epochs[0]!.collection).toEqual({ status: 'failed', reason: 'take-failed' });
    expect(owner.snapshot().provider).toEqual(provider);
    expect(captures[0]!.takeGenerationCapture).toHaveBeenCalledOnce();
  });

  it('retains a lost epoch when the real service restarts after native failure', async () => {
    const { owner, captures, createCaptureClient } = createOwner({ maximumWorkerEpochs: 8, plan: 'first-continuity-independent' });
    createCaptureClient.mockImplementationOnce(input => {
      const capture = captureFixture(input);
      captures.push(capture);
      capture.client.generateText.mockRejectedValue(new Error('Synthetic allocation failed'));
      return capture;
    });
    const provider = await owner.run();
    expect(provider.run).toEqual({ status: 'stopped', reason: 'provider-rejected' });
    expect(captures).toHaveLength(2);
    expect(captures[0]!.client.dispose).toHaveBeenCalledOnce();
    expect(captures[1]!.client.generateText).not.toHaveBeenCalled();
    await owner.collectNative();
    expect(retainedNative({ owner }).epochs.map(epoch => ({ workerEpoch: epoch.workerEpoch, collection: epoch.collection }))).toEqual([
      { workerEpoch: 1, collection: { status: 'unavailable', reason: 'session-inactive' } },
      { workerEpoch: 2, collection: { status: 'returned', result: { status: 'not-started' } } },
    ]);
    expect(captures[0]!.takeGenerationCapture).not.toHaveBeenCalled();
    expect(captures[1]!.takeGenerationCapture).toHaveBeenCalledOnce();
  });

  it('does not prevent a normal service restart when epoch recording capacity is exhausted', async () => {
    const { owner, captures, createCaptureClient, createUnrecordedWorkerClient, unrecorded } = createOwner({ maximumWorkerEpochs: 1, plan: 'first-only' });
    createCaptureClient.mockImplementationOnce(input => {
      const capture = captureFixture(input);
      captures.push(capture);
      capture.client.generateText.mockRejectedValue(new Error('Synthetic allocation failed'));
      return capture;
    });
    await owner.run();
    expect(createUnrecordedWorkerClient).toHaveBeenCalledOnce();
    expect(retainedNative({ owner })).toMatchObject({ maximumWorkerEpochs: 1, unrecordedWorkerCreations: 1, incompleteReasons: ['epoch-limit'] });
    expect(retainedNative({ owner }).epochs).toHaveLength(1);
    await owner.collectNative();
    await owner.dispose();
    expect(unrecorded.dispose).toHaveBeenCalledOnce();
    expect(captures[0]!.client.dispose).toHaveBeenCalledOnce();
  });

  it('starts disposal immediately even while collection is pending', async () => {
    const { owner, captures } = createOwner({ maximumWorkerEpochs: 8, plan: 'first-only' });
    await owner.run();
    const pendingTake = deferred<GenerationCaptureReadResult>();
    captures[0]!.takeGenerationCapture.mockReturnValue(pendingTake.promise);
    captures[0]!.client.dispose.mockImplementation(async () => {
      pendingTake.reject(new Error('Synthetic Worker disposed'));
    });
    const collecting = owner.collectNative();
    expect(retainedNative({ owner }).epochs[0]!.collection).toEqual({ status: 'pending' });
    const disposal = owner.dispose();
    expect(captures[0]!.client.dispose).toHaveBeenCalledOnce();
    await disposal;
    await collecting;
    expect(retainedNative({ owner }).epochs[0]!.collection).toEqual({ status: 'failed', reason: 'take-failed' });
    expect(owner.snapshot().provider.disposal).toBe('completed');
  });

  it('does not claim an unobservable host lifetime was a not-started Worker recorder', async () => {
    const { owner, captures } = createOwner({ maximumWorkerEpochs: 8, plan: 'first-only' });
    await owner.run();
    captures[0]!.getCaptureLifetime.mockImplementation(() => {
      throw new Error('Private host observer failure');
    });
    await owner.collectNative();
    expect(retainedNative({ owner }).epochs[0]).toEqual({
      workerEpoch: 1, lifetime: { status: 'unavailable' }, collection: { status: 'unavailable', reason: 'host-state-unavailable' },
    });
    expect(captures[0]!.takeGenerationCapture).not.toHaveBeenCalled();
  });
});
