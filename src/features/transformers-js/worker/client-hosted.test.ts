import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProductionRuntimeStartupFixture, installProductionRuntimeStartupPlatform } from '@/features/transformers-js/runtime/fixtures/production-runtime-startup-fixture';
import type { TransformersJsWorkerClient } from '@/features/transformers-js/types';
import type { GenerationCaptureRequest } from './generation-capture-protocol';

const mocks = vi.hoisted(() => ({
  release: vi.fn(),
  wrap: vi.fn(),
  terminate: vi.fn(),
  workerConstructor: vi.fn(),
}));

vi.mock('@/utils/worker-transport', async importOriginal => ({
  ...await importOriginal<typeof import('@/utils/worker-transport')>(),
  releaseWorkerRemote: mocks.release,
  wrapWorkerRemote: mocks.wrap,
}));

class MockWorker extends EventTarget {
  static latest: MockWorker;
  constructor(url: URL, options: WorkerOptions) {
    super();
    mocks.workerConstructor(url, options);
    MockWorker.latest = this;
  }

  terminate = mocks.terminate;
  readonly startup = createProductionRuntimeStartupFixture({ emitFromWorker: ({ message }) => this.dispatchEvent(new MessageEvent('message', { data: message })) });
  postMessage(message: unknown) {
    this.startup.acceptHostMessage({ message });
  }
  async publishReady() {
    this.startup.start(); await this.startup.ready;
  }
}

vi.stubGlobal('Worker', MockWorker);

describe('Transformers.js Worker client cleanup', () => {
  beforeEach(() => {
    installProductionRuntimeStartupPlatform({ origin: 'http://localhost' });
    vi.clearAllMocks();
    mocks.wrap.mockReturnValue({});
  });

  it('terminates without waiting for a hung remote release', async () => {
    mocks.release.mockReturnValue(new Promise<never>(() => undefined));
    const { createTransformersJsWorkerClient } = await import('./client-hosted');
    const client = createTransformersJsWorkerClient();
    await MockWorker.latest.publishReady();

    await expect(client.dispose()).resolves.toBeUndefined();

    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.terminate).toHaveBeenCalledOnce();
  });

  it('starts through the offline bootstrap instead of evaluating the runtime entry directly', async () => {
    const { createTransformersJsWorkerClient } = await import('./client-hosted');
    const client = createTransformersJsWorkerClient();

    expect(mocks.workerConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: expect.stringMatching(/\/worker\/bootstrap\.ts$/u) }),
      { type: 'module' },
    );
    await client.dispose();
  });

  it('still terminates when remote release throws synchronously', async () => {
    mocks.release.mockImplementation(() => {
      throw new Error('release failed');
    });
    const { createTransformersJsWorkerClient } = await import('./client-hosted');
    const client = createTransformersJsWorkerClient();
    await MockWorker.latest.publishReady();

    await expect(client.dispose()).resolves.toBeUndefined();

    expect(mocks.terminate).toHaveBeenCalledOnce();
  });

  it.each(['fulfilled', 'rejected'] as const)('ignores actual Comlink callbacks from a %s call during the next request', async outcome => {
    const comlink = await vi.importActual<typeof import('comlink')>('comlink');
    const channel = new MessageChannel();
    const callbacks: Array<{
      chunk: import('comlink').Remote<(chunk: string) => void>;
      tools: import('comlink').Remote<(tools: []) => void>;
    }> = [];
    const api = {
      async generateText(_messages: unknown, chunk: typeof callbacks[number]['chunk'], tools: typeof callbacks[number]['tools']) {
        callbacks.push({ chunk, tools });
        if (callbacks.length === 1) {
          await chunk('first');
          await tools([]);
          if (outcome === 'rejected') throw new Error('First generation failed');
        } else {
          await callbacks[0]!.chunk('late-first');
          await callbacks[0]!.tools([]);
          await chunk('second');
          await tools([]);
        }
      },
    };
    comlink.expose(api, channel.port1);
    mocks.wrap.mockReturnValue(comlink.wrap<typeof api>(channel.port2));
    const { createTransformersJsWorkerClient } = await import('./client-hosted');
    const client = createTransformersJsWorkerClient();
    const first = vi.fn();
    const firstTools = vi.fn();
    const second = vi.fn();
    const secondTools = vi.fn();
    try {
      await MockWorker.latest.publishReady();
      const firstCall = client.generateText({ messages: [], onChunk: first, onToolCalls: firstTools, params: undefined, tools: undefined });
      if (outcome === 'rejected') await expect(firstCall).rejects.toThrow('First generation failed');
      else await firstCall;
      await client.generateText({ messages: [], onChunk: second, onToolCalls: secondTools, params: undefined, tools: undefined });
      expect(first).toHaveBeenCalledExactlyOnceWith({ chunk: 'first' });
      expect(firstTools).toHaveBeenCalledExactlyOnceWith({ toolCalls: [] });
      expect(second).toHaveBeenCalledExactlyOnceWith({ chunk: 'second' });
      expect(secondTools).toHaveBeenCalledExactlyOnceWith({ toolCalls: [] });
    } finally {
      await client.dispose();
      for (const callback of callbacks) {
        callback.chunk[comlink.releaseProxy]();
        callback.tools[comlink.releaseProxy]();
      }
      channel.port1.close();
      channel.port2.close();
    }
  });

  it('rejects disposal while a real Comlink callback is held and ignores later delivery', async () => {
    const comlink = await vi.importActual<typeof import('comlink')>('comlink');
    const channel = new MessageChannel();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    let remoteCallback: import('comlink').Remote<(chunk: string) => void> | undefined;
    const api = {
      async generateText(_messages: unknown, chunk: NonNullable<typeof remoteCallback>) {
        remoteCallback = chunk;
        await chunk('entered-before-disposal');
        await chunk('late-after-disposal');
        finished.resolve();
      },
    };
    comlink.expose(api, channel.port1);
    mocks.wrap.mockReturnValue(comlink.wrap<typeof api>(channel.port2));
    const { createTransformersJsWorkerClient } = await import('./client-hosted');
    const client = createTransformersJsWorkerClient();
    const received: string[] = [];
    try {
      await MockWorker.latest.publishReady();
      const pending = client.generateText({
        messages: [], onChunk: async ({ chunk }) => {
          received.push(chunk);
          entered.resolve();
          await release.promise;
        }, onToolCalls: vi.fn(), params: undefined, tools: undefined,
      });
      const rejected = expect(pending).rejects.toThrow('Production Worker disposed');
      await entered.promise;
      await client.dispose();
      await rejected;
      expect(mocks.terminate).toHaveBeenCalledOnce();
      release.resolve();
      await finished.promise;
      expect(received).toEqual(['entered-before-disposal']);
    } finally {
      release.resolve();
      await client.dispose();
      remoteCallback?.[comlink.releaseProxy]();
      channel.port1.close();
      channel.port2.close();
    }
  });
});

const captureLimits: GenerationCaptureRequest['limits'] = {
  maxCalls: 3,
  maxInvocationsPerCall: 2,
  maxEvents: 32,
  maxTextBytes: 1024,
  maxTensorBytes: 1024,
  maxTotalTensorBytes: 4096, maxTokensPerStreamEvent: 4096, maxTotalStreamTokens: 16384, maxTotalStreamTokenBytes: 262144,
};

function generate({ client }: { client: TransformersJsWorkerClient }): Promise<void> {
  return client.generateText({
    messages: [{ role: 'user', content: 'Synthetic capture input.' }],
    onChunk: () => undefined,
    onToolCalls: () => undefined,
    params: undefined,
    tools: undefined,
  });
}

describe('investigation-owned generation capture client', () => {
  beforeEach(() => {
    installProductionRuntimeStartupPlatform({ origin: 'http://localhost' });
    vi.clearAllMocks();
    vi.stubGlobal('Worker', MockWorker);
  });

  it('keeps ordinary generation on the same RPC without recording or collection', async () => {
    const generateText = vi.fn().mockResolvedValue(undefined);
    const takeGenerationCapture = vi.fn();
    mocks.wrap.mockReturnValue({ generateText, takeGenerationCapture });
    const { createTransformersJsWorkerClient } = await import('./client-hosted');
    const client = createTransformersJsWorkerClient();
    try {
      await MockWorker.latest.publishReady();
      await generate({ client });
      expect(generateText).toHaveBeenCalledExactlyOnceWith(
        [{ role: 'user', content: 'Synthetic capture input.' }],
        expect.any(Function), expect.any(Function), undefined, undefined, undefined, undefined,
      );
      expect(takeGenerationCapture).not.toHaveBeenCalled();
    } finally {
      await client.dispose();
    }
  });

  it('passes operation ownership only in the appended RPC slot without enabling capture', async () => {
    const generateText = vi.fn().mockResolvedValue(undefined);
    mocks.wrap.mockReturnValue({ generateText });
    const { createTransformersJsWorkerClient } = await import('./client-hosted');
    const client = createTransformersJsWorkerClient();
    const continuationOwner = 'f28f6802-947c-4b9d-bc99-223d8d469f4b';
    try {
      await MockWorker.latest.publishReady();
      await client.generateText({ messages: [], onChunk: () => undefined, onToolCalls: () => undefined, params: undefined, tools: undefined, continuationOwner });
      expect(generateText).toHaveBeenCalledExactlyOnceWith([], expect.any(Function), expect.any(Function), undefined, undefined, undefined, continuationOwner);
    } finally {
      await client.dispose();
    }
  });

  it('snapshots request identity before startup and separates calls within the same Provider request', async () => {
    const generateText = vi.fn().mockResolvedValue(undefined);
    const takeGenerationCapture = vi.fn().mockResolvedValue({ status: 'not-started' });
    mocks.wrap.mockReturnValue({ generateText, takeGenerationCapture });
    const { createTransformersJsGenerationCaptureClient } = await import('./client-hosted');
    const active = { runId: 'synthetic-run', requestId: 'first-request' };
    const getActiveRequest = vi.fn(() => active);
    const limits = { ...captureLimits };
    const owner = createTransformersJsGenerationCaptureClient({
      runId: 'synthetic-run', workerEpoch: 1, limits, getActiveRequest,
    });
    try {
      const first = generate({ client: owner.client });
      expect(getActiveRequest).toHaveBeenCalledOnce();
      expect(generateText).not.toHaveBeenCalled();
      active.requestId = 'second-request';
      limits.maxCalls = 1;
      await MockWorker.latest.publishReady();
      await first;
      await generate({ client: owner.client });
      await generate({ client: owner.client });
      expect(generateText.mock.calls.map(call => call[5])).toEqual([
        { context: { runId: 'synthetic-run', workerEpoch: 1, requestId: 'first-request', generationCallId: 1 }, limits: captureLimits },
        { context: { runId: 'synthetic-run', workerEpoch: 1, requestId: 'second-request', generationCallId: 2 }, limits: captureLimits },
        { context: { runId: 'synthetic-run', workerEpoch: 1, requestId: 'second-request', generationCallId: 3 }, limits: captureLimits },
      ]);
      expect(takeGenerationCapture).not.toHaveBeenCalled();
      expect(owner.getCaptureLifetime().issuedCalls).toEqual(generateText.mock.calls.map(call => call[5].context));
      await expect(owner.takeGenerationCapture()).resolves.toEqual({ status: 'not-started' });
      expect(takeGenerationCapture).toHaveBeenCalledExactlyOnceWith({ runId: 'synthetic-run', workerEpoch: 1 });
    } finally {
      await owner.client.dispose();
    }
  });

  it('retains a bounded incomplete record while still forwarding calls beyond recording capacity', async () => {
    const generateText = vi.fn().mockResolvedValue(undefined);
    mocks.wrap.mockReturnValue({ generateText });
    const { createTransformersJsGenerationCaptureClient } = await import('./client-hosted');
    const getActiveRequest = vi.fn(() => ({ runId: 'synthetic-run', requestId: 'first-request' }));
    const owner = createTransformersJsGenerationCaptureClient({
      runId: 'synthetic-run', workerEpoch: 2, limits: { ...captureLimits, maxCalls: 1 }, getActiveRequest,
    });
    try {
      await MockWorker.latest.publishReady();
      await generate({ client: owner.client });
      await generate({ client: owner.client });
      await generate({ client: owner.client });
      expect(generateText).toHaveBeenCalledTimes(3);
      expect(generateText.mock.calls.slice(1).map(call => call[5])).toEqual([undefined, undefined]);
      expect(getActiveRequest).toHaveBeenCalledOnce();
      const snapshot = owner.getCaptureLifetime();
      expect(snapshot.incompleteReasons).toEqual(['call-limit']);
      expect(snapshot.issuedCalls).toEqual([{ runId: 'synthetic-run', workerEpoch: 2, requestId: 'first-request', generationCallId: 1 }]);
      snapshot.issuedCalls[0]!.requestId = 'modified-copy';
      expect(owner.getCaptureLifetime().issuedCalls[0]!.requestId).toBe('first-request');
    } finally {
      await owner.client.dispose();
    }
  });

  it('does not replace a generation rejection when the request observer throws', async () => {
    const original = new Error('Synthetic native failure');
    const generateText = vi.fn().mockRejectedValue(original);
    mocks.wrap.mockReturnValue({ generateText });
    const { createTransformersJsGenerationCaptureClient } = await import('./client-hosted');
    const owner = createTransformersJsGenerationCaptureClient({
      runId: 'synthetic-run', workerEpoch: 1, limits: captureLimits,
      getActiveRequest: () => {
        throw new Error('Synthetic observer failure');
      },
    });
    try {
      await MockWorker.latest.publishReady();
      await expect(generate({ client: owner.client })).rejects.toBe(original);
      expect(generateText.mock.calls[0]![5]).toBeUndefined();
      expect(owner.getCaptureLifetime().incompleteReasons).toEqual(['request-invalid']);
    } finally {
      await owner.client.dispose();
    }
  });

  it('does not attach another run identity to a successful generation', async () => {
    const generateText = vi.fn().mockResolvedValue(undefined);
    mocks.wrap.mockReturnValue({ generateText });
    const { createTransformersJsGenerationCaptureClient } = await import('./client-hosted');
    const owner = createTransformersJsGenerationCaptureClient({
      runId: 'synthetic-run', workerEpoch: 1, limits: captureLimits,
      getActiveRequest: () => ({ runId: 'other-run', requestId: 'first-request' }),
    });
    try {
      await MockWorker.latest.publishReady();
      await expect(generate({ client: owner.client })).resolves.toBeUndefined();
      expect(generateText.mock.calls[0]![5]).toBeUndefined();
      expect(owner.getCaptureLifetime().issuedCalls).toEqual([]);
      expect(owner.getCaptureLifetime().incompleteReasons).toEqual(['request-invalid']);
    } finally {
      await owner.client.dispose();
    }
  });

  it('returns busy without waiting and preserves terminal disposal for later collection', async () => {
    const takeGenerationCapture = vi.fn().mockResolvedValue({ status: 'busy' });
    mocks.wrap.mockReturnValue({ takeGenerationCapture });
    const { createTransformersJsGenerationCaptureClient } = await import('./client-hosted');
    const owner = createTransformersJsGenerationCaptureClient({
      runId: 'synthetic-run', workerEpoch: 1, limits: captureLimits, getActiveRequest: () => undefined,
    });
    await MockWorker.latest.publishReady();
    await expect(owner.takeGenerationCapture()).resolves.toEqual({ status: 'busy' });
    expect(takeGenerationCapture).toHaveBeenCalledOnce();
    const disposal = owner.client.dispose();
    expect(owner.getCaptureLifetime().session).toBe('inactive');
    await expect(owner.takeGenerationCapture()).rejects.toMatchObject({ name: 'ProductionWorkerLifecycleError', reason: 'disposed' });
    await disposal;
    expect(takeGenerationCapture).toHaveBeenCalledOnce();
    expect(mocks.terminate).toHaveBeenCalledOnce();
  });

  it('rejects malformed collection data without disclosing the raw response', async () => {
    const takeGenerationCapture = vi.fn().mockResolvedValue({ status: 'not-started', privateText: 'not for export' });
    mocks.wrap.mockReturnValue({ takeGenerationCapture });
    const { createTransformersJsGenerationCaptureClient } = await import('./client-hosted');
    const owner = createTransformersJsGenerationCaptureClient({
      runId: 'synthetic-run', workerEpoch: 1, limits: captureLimits, getActiveRequest: () => undefined,
    });
    try {
      await MockWorker.latest.publishReady();
      await expect(owner.takeGenerationCapture()).rejects.toThrow(/^Invalid generation capture response$/u);
      expect(takeGenerationCapture).toHaveBeenCalledOnce();
    } finally {
      await owner.client.dispose();
    }
  });

  it('records requested Load identity without claiming that main was resolved or loading succeeded', async () => {
    const original = new Error('Missing local file');
    const loadDownloadedModel = vi.fn().mockRejectedValue(original);
    mocks.wrap.mockReturnValue({ loadDownloadedModel });
    const { createTransformersJsGenerationCaptureClient } = await import('./client-hosted');
    const owner = createTransformersJsGenerationCaptureClient({
      runId: 'synthetic-run', workerEpoch: 1, limits: captureLimits, getActiveRequest: () => undefined,
    });
    try {
      await MockWorker.latest.publishReady();
      await expect(owner.client.loadDownloadedModel({ modelId: 'org/synthetic-model', revisionSelection: { kind: 'pinned', revision: 'main' }, progressCallback: () => undefined })).rejects.toBe(original);
      expect(owner.getCaptureLifetime().loadRequests).toEqual([{ requestedModelId: 'org/synthetic-model', requestedRevision: 'main', revisionSelection: { kind: 'pinned', revision: 'main' } }]);
      expect(loadDownloadedModel).toHaveBeenCalledExactlyOnceWith('org/synthetic-model', { kind: 'pinned', revision: 'main' }, expect.any(Function), { runId: 'synthetic-run', workerEpoch: 1 });
    } finally {
      await owner.client.dispose();
    }
  });

  it('rejects a structurally valid capture belonging to another Worker epoch', async () => {
    const takeGenerationCapture = vi.fn().mockResolvedValue({ status: 'captured', capture: {
      runId: 'synthetic-run', workerEpoch: 2, schemaVersion: 1, byteOrder: 'little-endian', limits: captureLimits,
      calls: [], events: [], incompleteReasons: [],
      unobserved: ['native-stop-cause', 'native-forward-input', 'kv-bytes'],
    } });
    mocks.wrap.mockReturnValue({ takeGenerationCapture });
    const { createTransformersJsGenerationCaptureClient } = await import('./client-hosted');
    const owner = createTransformersJsGenerationCaptureClient({
      runId: 'synthetic-run', workerEpoch: 1, limits: captureLimits, getActiveRequest: () => undefined,
    });
    try {
      await MockWorker.latest.publishReady();
      await expect(owner.takeGenerationCapture()).rejects.toThrow(/^Invalid generation capture response$/u);
    } finally {
      await owner.client.dispose();
    }
  });

  it('rejects a structurally valid capture with different recording limits', async () => {
    const takeGenerationCapture = vi.fn().mockResolvedValue({ status: 'captured', capture: {
      runId: 'synthetic-run', workerEpoch: 1, schemaVersion: 1, byteOrder: 'little-endian', limits: { ...captureLimits, maxCalls: 4 },
      calls: [], events: [], incompleteReasons: [],
      unobserved: ['native-stop-cause', 'native-forward-input', 'kv-bytes'],
    } });
    mocks.wrap.mockReturnValue({ takeGenerationCapture });
    const { createTransformersJsGenerationCaptureClient } = await import('./client-hosted');
    const owner = createTransformersJsGenerationCaptureClient({
      runId: 'synthetic-run', workerEpoch: 1, limits: captureLimits, getActiveRequest: () => undefined,
    });
    try {
      await MockWorker.latest.publishReady();
      await expect(owner.takeGenerationCapture()).rejects.toThrow(/^Invalid generation capture response$/u);
    } finally {
      await owner.client.dispose();
    }
  });

  it('keeps an unavailable environment unavailable without creating a recording Worker', async () => {
    vi.stubGlobal('Worker', undefined);
    const { createTransformersJsGenerationCaptureClient } = await import('./client-hosted');
    const getActiveRequest = vi.fn(() => ({ runId: 'synthetic-run', requestId: 'first-request' }));
    const owner = createTransformersJsGenerationCaptureClient({
      runId: 'synthetic-run', workerEpoch: 1, limits: captureLimits, getActiveRequest,
    });
    try {
      await expect(generate({ client: owner.client })).rejects.toThrow('not available in this environment');
      await expect(owner.takeGenerationCapture()).rejects.toThrow('not available in this environment');
      expect(owner.getCaptureLifetime()).toEqual({
        runId: 'synthetic-run', workerEpoch: 1, session: 'inactive', issuedCalls: [], loadRequests: [], incompleteReasons: [],
        // The host ledger exists independently of Worker availability. No Load
        // was requested, so this is not evidence of an unobserved successful Load.
        loadDiagnostics: {
          format: 'production-load-diagnostics-v1', owner: { runId: 'synthetic-run', workerEpoch: 1 },
          limits: { maxEvents: 512, maxResources: 128 },
          byteAccounting: 'successful-allocation-request-sum-not-live-memory-or-gc',
          coverage: 'transformers-readResponse-and-session-entry-only-not-response-arrayBuffer-or-ort-internals',
          events: [], incompleteReasons: [],
        },
      });
      expect(getActiveRequest).not.toHaveBeenCalled();
      expect(mocks.workerConstructor).not.toHaveBeenCalled();
    } finally {
      await owner.client.dispose();
      vi.stubGlobal('Worker', MockWorker);
    }
  });
});
