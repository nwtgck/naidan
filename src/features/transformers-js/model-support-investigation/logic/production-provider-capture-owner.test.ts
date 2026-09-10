// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFiles } from '@/features/transformers-js/replay-models/support/download-memory-files';
import { createTransformersJsService, transformersJsService } from '@/features/transformers-js/index-hosted';
import { ProductionWorkerLifecycleError } from '@/features/transformers-js/worker/production-worker-session';
import { toToolCallId } from '@/01-models/ids';
import type { TransformersJsWorkerClient } from '@/features/transformers-js/types';
import * as providerTrace from './production-provider-trace';
import {
  createProductionProviderCaptureOwner,
  type ProductionProviderCapturePlan,
  type ProductionProviderCaptureRequestIdentity,
} from './production-provider-capture-owner';

const limits = { maximumEvents: 100, maximumCharacters: 4096 };
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

function clientFixture() {
  return {
    loadDownloadedModel: vi.fn<TransformersJsWorkerClient['loadDownloadedModel']>().mockResolvedValue({ device: 'webgpu' }),
    generateText: vi.fn<TransformersJsWorkerClient['generateText']>().mockResolvedValue(undefined),
    interrupt: vi.fn<TransformersJsWorkerClient['interrupt']>().mockResolvedValue(undefined),
    unloadModel: vi.fn<TransformersJsWorkerClient['unloadModel']>().mockResolvedValue(undefined),
    resetCache: vi.fn<TransformersJsWorkerClient['resetCache']>().mockResolvedValue(undefined),
    dispose: vi.fn<TransformersJsWorkerClient['dispose']>().mockResolvedValue(undefined),
  } satisfies TransformersJsWorkerClient;
}

function createOwner({ client, runId, plan, traceLimits }: {
  client: TransformersJsWorkerClient;
  runId: string;
  plan: ProductionProviderCapturePlan;
  traceLimits: typeof limits;
}) {
  const factory = vi.fn(() => client);
  const owner = createProductionProviderCaptureOwner({
    runId, modelId: 'fixture/model', plan, createWorkerClient: factory, traceLimits,
  });
  owners.push(owner);
  return { owner, factory };
}

beforeEach(() => {
  fs = createMemoryFiles();
  fs.enter({ nextPhase: 'load', mutationPolicy: 'read-only' });
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => fs.root } });
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('Provider capture owner tests forbid network access');
  }));
});

afterEach(async () => {
  try {
    // Controlled clients settle their pending operations in each test. Cleanup
    // failure cases are asserted locally and must not hide other owner cleanup.
    await Promise.all(owners.splice(0).map(owner => owner.dispose().catch(() => undefined)));
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

// Real service + Provider + trace; only the native Worker client and read-only
// OPFS platform are controlled here. These are not Comlink/browser timing tests.
describe('isolated fixed Production Provider capture owner', () => {
  it('reports pending and settled requests without inferring completion from an absent active request', async () => {
    const client = clientFixture();
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    const secondEntered = deferred<void>();
    const releaseSecond = deferred<void>();
    client.generateText.mockImplementationOnce(async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
    });
    client.generateText.mockImplementationOnce(async () => {
      secondEntered.resolve();
      await releaseSecond.promise;
    });
    const { owner } = createOwner({ client, runId: 'progress', plan: 'first-continuity-independent', traceLimits: limits });
    expect(owner.getProgress()).toEqual({
      runId: 'progress', modelId: 'fixture/model', plan: 'first-continuity-independent',
      run: { status: 'not-started' }, lifetime: 'open', activeRequest: undefined,
      totalRequests: 3, selectedRequests: 3, settledRequests: 0, loadStatus: 'idle',
    });
    const running = owner.run();
    try {
      await firstEntered.promise;
      const first = owner.getProgress();
      expect(first).toMatchObject({ run: { status: 'running' }, loadStatus: 'ready', settledRequests: 0,
        activeRequest: { runId: 'progress', requestId: 'progress-first-turn', scenario: 'first-turn' } });
      expect(Object.isFrozen(first)).toBe(true);
      releaseFirst.resolve();
      await secondEntered.promise;
      expect(owner.getProgress()).toMatchObject({ run: { status: 'running' }, settledRequests: 1,
        activeRequest: { runId: 'progress', requestId: 'progress-continuity', scenario: 'continuity' } });
      expect(first.settledRequests).toBe(0);
      releaseSecond.resolve();
      await running;
      expect(owner.getProgress()).toMatchObject({ run: { status: 'completed' }, settledRequests: 3, activeRequest: undefined });
      await owner.dispose();
      expect(owner.getProgress()).toMatchObject({ run: { status: 'completed' }, lifetime: 'closed', loadStatus: 'idle' });
    } finally {
      releaseFirst.resolve();
      releaseSecond.resolve();
      await running;
    }
  });

  it('samples only small progress counters without copying trace payloads or invoking a UI callback', async () => {
    const original = providerTrace.createProductionProviderTrace;
    const snapshots: Array<ReturnType<typeof vi.fn<ReturnType<typeof original>['snapshot']>>> = [];
    vi.spyOn(providerTrace, 'createProductionProviderTrace').mockImplementation(args => {
      const trace = original(args);
      const snapshot = vi.fn(trace.snapshot);
      snapshots.push(snapshot);
      return { ...trace, snapshot };
    });
    const client = clientFixture();
    const { owner } = createOwner({ client, runId: 'small-progress', plan: 'generation-v2', traceLimits: limits });
    client.generateText.mockImplementation(async ({ onChunk }) => {
      onChunk({ chunk: 'Synthetic observed output.' });
      expect(owner.getProgress()).toMatchObject({ run: { status: 'running' }, selectedRequests: 3, totalRequests: 13 });
      expect(snapshots.every(snapshot => snapshot.mock.calls.length === 0)).toBe(true);
    });
    for (let index = 0; index < 100; index += 1) owner.getProgress();
    expect(snapshots).toHaveLength(13);
    expect(snapshots.every(snapshot => snapshot.mock.calls.length === 0)).toBe(true);
    const result = await owner.run();
    expect(result.requests.filter(request => request.input !== undefined).map(request => request.trace.settled?.outcome)).toEqual([
      { status: 'fulfilled' }, { status: 'fulfilled' }, { status: 'fulfilled' },
    ]);
    expect(owner.getProgress().settledRequests).toBe(3);
    // The script's final full snapshot is expected; sampling did not create it.
    expect(snapshots.map(snapshot => snapshot.mock.calls.length)).toEqual(Array(13).fill(1));
  });

  it('keeps Full v2 fixed independent capabilities in one loaded service without reducing natural tool budgets', async () => {
    const client = clientFixture();
    const { owner } = createOwner({ client, runId: 'full-v2', plan: 'full-v2', traceLimits: limits });
    const result = await owner.run();
    expect(result.format).toBe('production-provider-capture-v2');
    expect(result.requests.map(request => request.scenario)).toEqual([
      'first-turn', 'continuity', 'independent-next-input', 'system-user', 'supplied-history',
      'reasoning-none', 'reasoning-low', 'reasoning-medium', 'reasoning-high',
      'natural-tool-minimal', 'natural-tool-representative', 'structured-tool-history', 'image',
    ]);
    expect(result.requests.map(request => request.input?.parameters.maxCompletionTokens)).toEqual([16, 16, 1, 1, 1, 1, 1, 1, 1, 128, 128, 128, 1]);
    expect(result.requests.slice(5, 9).map(request => request.input?.parameters.reasoning.effort)).toEqual(['none', 'low', 'medium', 'high']);
    expect(result.requests.every(request => request.status === 'settled')).toBe(true);
    expect(client.loadDownloadedModel).toHaveBeenCalledOnce();
    expect(client.generateText).toHaveBeenCalledTimes(13);
  });

  it('blocks only continuity after first rejection in v2 while same-runtime independent inputs proceed', async () => {
    const client = clientFixture();
    client.generateText.mockRejectedValueOnce(new Error('ordinary runtime rejection'));
    const { owner } = createOwner({ client, runId: 'reject-v2', plan: 'generation-continuity-v2', traceLimits: limits });
    const result = await owner.run();
    expect(result.run).toEqual({ status: 'completed' });
    expect(result.requests[0]?.trace.settled?.outcome.status).toBe('rejected');
    expect(result.requests[1]).toMatchObject({ status: 'not-started', notStartedReason: 'first-settlement-unavailable' });
    expect(result.requests.slice(2, 5).map(request => request.status)).toEqual(['settled', 'settled', 'settled']);
    expect(result.requests.slice(5).every(request => request.status === 'not-started')).toBe(true);
    expect(client.loadDownloadedModel).toHaveBeenCalledOnce();
    expect(client.generateText).toHaveBeenCalledTimes(4);
    // Settlement includes a rejected request; this counter is not a success count.
    expect(owner.getProgress()).toMatchObject({ settledRequests: 4, selectedRequests: 5 });
  });

  it('continues independent v2 requests after capture overflow without repairing first history from late text', async () => {
    const client = clientFixture();
    let late: Parameters<TransformersJsWorkerClient['generateText']>[0]['onChunk'] | undefined;
    client.generateText.mockImplementationOnce(async ({ onChunk }) => {
      late = onChunk; onChunk({ chunk: 'overflow' });
    });
    client.generateText.mockImplementationOnce(async () => {
      late?.({ chunk: 'not usable as history' });
    });
    const { owner } = createOwner({ client, runId: 'overflow-v2', plan: 'generation-continuity-v2', traceLimits: { maximumEvents: 1, maximumCharacters: 2 } });
    const result = await owner.run();
    expect(result.run).toEqual({ status: 'completed' });
    expect(result.requests[0]?.trace.settled).toMatchObject({ outcome: { status: 'fulfilled' }, completeness: 'incomplete' });
    expect(result.requests[1]).toMatchObject({ status: 'not-started', notStartedReason: 'first-settlement-unavailable' });
    expect(client.generateText.mock.calls[1]?.[0].messages).toEqual([{ role: 'user', content: 'A separate synthetic capture conversation.' }]);
    expect(client.generateText).toHaveBeenCalledTimes(4);
    expect(client.loadDownloadedModel).toHaveBeenCalledOnce();
  });

  it('records the ordinary Provider weather execution and result reinsertion without changing the fixed input', async () => {
    const client = clientFixture();
    let emitted = false;
    client.generateText.mockImplementation(async ({ messages, onToolCalls, onChunk }) => {
      if (!emitted && messages.length === 1 && messages[0]?.content === 'Use the weather tool for Tokyo.') {
        emitted = true;
        onToolCalls?.({ toolCalls: [{ id: toToolCallId({ raw: 'fixed-generated-tool' }), type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"Tokyo"}' } }] });
      } else if (emitted && messages.at(-1)?.role === 'tool') onChunk({ chunk: 'Tool continuation.' });
    });
    const { owner } = createOwner({ client, runId: 'tools-v2', plan: 'generation-capabilities-v2', traceLimits: limits });
    const result = await owner.run();
    const natural = result.requests.find(request => request.scenario === 'natural-tool-minimal');
    expect(natural?.input?.messages).toEqual([{ role: 'user', content: 'Use the weather tool for Tokyo.' }]);
    expect(natural?.trace.events).toContainEqual({ kind: 'tool-success', sequence: 2, phase: 'before-settlement', toolCallId: 'fixed-generated-tool', content: '{"temperatureC":20,"condition":"clear"}' });
    const continued = client.generateText.mock.calls.find(([request]) => request.messages.at(-1)?.tool_call_id === toToolCallId({ raw: 'fixed-generated-tool' }));
    expect(continued?.[0].messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'fixed-generated-tool', content: '{"temperatureC":20,"condition":"clear"}' });
    expect(continued?.[0].params?.maxCompletionTokens).toBe(128);
    expect(continued?.[0].tools?.[0]?.function.parameters).toEqual({ type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false });
    expect(client.loadDownloadedModel).toHaveBeenCalledOnce();
  });

  it('preserves explicit v2 deadline and unselected reasons without starting later requests', async () => {
    const client = clientFixture();
    const { owner } = createOwner({ client, runId: 'deadline-v2', plan: 'generation-v2', traceLimits: limits });
    client.generateText.mockImplementationOnce(async () => {
      owner.abort({ reason: 'deadline' });
    });
    const result = await owner.run();
    expect(result.run).toEqual({ status: 'stopped', reason: 'aborted' });
    expect(result.requests[1]?.notStartedReason).toBe('scope-not-selected');
    expect(result.requests[3]?.notStartedReason).toBe('deadline');
    expect(result.requests[4]?.notStartedReason).toBe('deadline');
    expect(client.generateText).toHaveBeenCalledOnce();
  });

  it('does not let v2 independent requests auto-load a replacement after fatal runtime loss', async () => {
    const client = clientFixture();
    client.generateText.mockRejectedValueOnce(new ProductionWorkerLifecycleError({ reason: 'worker-error', message: 'lost runtime' }));
    const { owner, factory } = createOwner({ client, runId: 'lost-v2', plan: 'full-v2', traceLimits: limits });
    const result = await owner.run();
    expect(result.run).toEqual({ status: 'stopped', reason: 'runtime-unavailable' });
    expect(result.requests.slice(1).every(request => request.status === 'not-started')).toBe(true);
    expect(client.loadDownloadedModel).toHaveBeenCalledOnce();
    expect(client.generateText).toHaveBeenCalledOnce();
    // The ordinary service eagerly replaces its failed client, but the capture
    // must not load or generate on that replacement for a later scenario.
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('runs fixed first, caller-settled continuity and independent inputs serially in one service', async () => {
    const client = clientFixture();
    const { owner, factory } = createOwner({ client, runId: 'three', plan: 'first-continuity-independent', traceLimits: limits });
    const identities: Array<ProductionProviderCaptureRequestIdentity | undefined> = [];
    client.generateText.mockImplementationOnce(async ({ onChunk }) => {
      identities.push(owner.getActiveRequest());
      onChunk({ chunk: 'First ' }); onChunk({ chunk: 'answer.' });
    });
    client.generateText.mockImplementationOnce(async ({ onChunk }) => {
      identities.push(owner.getActiveRequest());
      onChunk({ chunk: 'Second answer.' });
    });
    client.generateText.mockImplementationOnce(async ({ onChunk }) => {
      identities.push(owner.getActiveRequest());
      onChunk({ chunk: 'Independent answer.' });
    });
    const result = await owner.run();
    expect(result.run).toEqual({ status: 'completed' });
    expect(result.lifetime).toBe('open');
    expect(result.observation).toBe('open');
    expect(result.disposal).toBe('not-requested');
    expect(result.requests.map(request => request.input?.messages)).toEqual([
      [{ role: 'user', content: 'Template probe user message.' }],
      [
        { role: 'user', content: 'Template probe user message.' },
        { role: 'assistant', content: 'First answer.' },
        { role: 'user', content: 'Continue the synthetic conversation with a short response.' },
      ],
      [{ role: 'user', content: 'A separate synthetic capture conversation.' }],
    ]);
    expect(client.generateText.mock.calls.map(([input]) => input.messages.map(message => ({ role: message.role, content: message.content }))))
      .toEqual(result.requests.map(request => request.input?.messages));
    expect(client.generateText.mock.calls.map(([input]) => input.params)).toEqual(result.requests.map(request => request.input?.parameters));
    expect(result.requests.map(request => request.input?.parameters.maxCompletionTokens)).toEqual([16, 16, 1]);
    expect(client.generateText.mock.calls.every(([input]) => input.tools === undefined)).toBe(true);
    expect(identities).toEqual([
      { runId: 'three', requestId: 'three-first-turn', scenario: 'first-turn' },
      { runId: 'three', requestId: 'three-continuity', scenario: 'continuity' },
      { runId: 'three', requestId: 'three-independent-next-input', scenario: 'independent-next-input' },
    ]);
    expect(identities.every(Object.isFrozen)).toBe(true);
    expect(owner.getActiveRequest()).toBeUndefined();
    expect(result.requests.map(request => request.trace.settled?.outcome)).toEqual([
      { status: 'fulfilled' }, { status: 'fulfilled' }, { status: 'fulfilled' },
    ]);
    expect(result.requests.every(request => request.status === 'settled' && request.trace.completeness === 'complete')).toBe(true);
    expect(factory).toHaveBeenCalledOnce();
    expect(client.loadDownloadedModel).toHaveBeenCalledOnce();
    expect(client.dispose).not.toHaveBeenCalled();
    expect(client.unloadModel).not.toHaveBeenCalled();
    expect(client.resetCache).not.toHaveBeenCalled();
    expect(Object.keys(owner).sort()).toEqual(['abort', 'dispose', 'getActiveRequest', 'getProgress', 'run', 'snapshot']);
    expect(result.capabilities).toEqual({
      providerCallbacks: 'bounded-projection', nativeInvocations: 'not-collected-by-this-owner', tools: 'not-selected', images: 'not-selected',
    });
    expect(transformersJsService.getState()).toMatchObject({ status: 'idle', activeModelId: undefined });
  });

  it('honors first-only without implicitly scheduling continuity or an independent request', async () => {
    const client = clientFixture();
    const { owner } = createOwner({ client, runId: 'first', plan: 'first-only', traceLimits: limits });
    const result = await owner.run();
    expect(result.plan).toBe('first-only');
    expect(result.run).toEqual({ status: 'completed' });
    expect(result.requests.map(request => request.scenario)).toEqual(['first-turn']);
    expect(client.generateText).toHaveBeenCalledOnce();
  });

  it('keeps an empty settled assistant and assigns late first chunks to the first request during continuity', async () => {
    const client = clientFixture();
    const { owner } = createOwner({ client, runId: 'late', plan: 'first-continuity-independent', traceLimits: limits });
    let firstCallback: Parameters<TransformersJsWorkerClient['generateText']>[0]['onChunk'] | undefined;
    client.generateText.mockImplementationOnce(async ({ onChunk }) => {
      firstCallback = onChunk; // no callback before the first Promise settles
    });
    client.generateText.mockImplementationOnce(async ({ messages, onChunk }) => {
      expect(messages[1]?.content).toBe('');
      expect(owner.snapshot().requests[0]?.trace.settled?.events).toEqual([
        { kind: 'assistant-start', phase: 'before-settlement', sequence: 0 },
      ]);
      firstCallback?.({ chunk: 'late first text' });
      onChunk({ chunk: 'second text' });
    });
    const result = await owner.run();
    expect(result.run).toEqual({ status: 'completed' });
    expect(result.requests[1]?.input?.messages[1]).toEqual({ role: 'assistant', content: '' });
    expect(result.requests[0]?.trace.lateEvents).toEqual([
      { kind: 'chunk', chunk: 'late first text', phase: 'after-settlement', sequence: 2 },
    ]);
    expect(result.requests[1]?.trace.events.filter(event => event.kind === 'chunk').map(event => event.chunk)).toEqual(['second text']);
    expect(result.requests[2]?.input?.messages).toEqual([{ role: 'user', content: 'A separate synthetic capture conversation.' }]);
    expect(client.loadDownloadedModel).toHaveBeenCalledOnce();
  });

  it('keeps immutable partial inputs and snapshots while the real Provider is pending', async () => {
    const client = clientFixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    const { owner } = createOwner({ client, runId: 'partial', plan: 'first-only', traceLimits: limits });
    client.generateText.mockImplementationOnce(({ onChunk }) => {
      onChunk({ chunk: 'partial' }); entered.resolve(); return release.promise;
    });
    const running = owner.run();
    await entered.promise;
    const before = owner.snapshot();
    expect(before.run).toEqual({ status: 'running' });
    expect(before.requests[0]?.status).toBe('awaiting-settlement');
    expect(before.requests[0]?.trace.settled).toBeUndefined();
    const input = before.requests[0]?.input;
    if (input === undefined) throw new Error('Missing prepared request');
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(before.requests)).toBe(true);
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.messages)).toBe(true);
    expect(input.messages.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(input.parameters.reasoning)).toBe(true);
    const forwarded = client.generateText.mock.calls[0]![0].messages;
    expect(forwarded).not.toBe(input.messages);
    expect(forwarded[0]).not.toBe(input.messages[0]);
    forwarded[0]!.content = 'mutated worker fixture argument';
    expect(input.messages[0]?.content).toBe('Template probe user message.');
    release.resolve();
    const complete = await running;
    expect(complete.requests[0]?.trace.settled?.outcome.status).toBe('fulfilled');
    expect(before.requests[0]?.trace.settled).toBeUndefined();
    const callback = client.generateText.mock.calls[0]![0].onChunk;
    callback({ chunk: 'after completion' });
    expect(complete.requests[0]?.trace.lateEvents).toEqual([]);
    expect(owner.snapshot().requests[0]?.trace.lateEvents).toHaveLength(1);
    await owner.dispose();
    expect(owner.snapshot().observation).toBe('end-requested-by-dispose');
    expect(owner.snapshot().requests[0]?.trace.lateEvents).toHaveLength(1);
  });

  it('separates a rejected Provider outcome from a stopped script and preserves partial callbacks', async () => {
    const client = clientFixture();
    const original = Object.assign(new Error('Private error text must not be copied'), { name: 'RangeError' });
    client.generateText.mockImplementationOnce(async ({ onChunk }) => {
      onChunk({ chunk: 'partial before failure' }); throw original;
    });
    const { owner, factory } = createOwner({ client, runId: 'reject', plan: 'first-continuity-independent', traceLimits: limits });
    const result = await owner.run();
    expect(result.run).toEqual({ status: 'stopped', reason: 'provider-rejected' });
    expect(result.requests[0]?.trace.settled?.outcome).toEqual({ status: 'rejected', errorName: 'RangeError' });
    expect(result.requests[0]?.trace.events).toContainEqual({
      kind: 'chunk', chunk: 'partial before failure', sequence: 1, phase: 'before-settlement',
    });
    expect(result.requests.slice(1).map(request => ({ status: request.status, input: request.input, settled: request.trace.settled })))
      .toEqual([{ status: 'not-started', input: undefined, settled: undefined }, { status: 'not-started', input: undefined, settled: undefined }]);
    expect(JSON.stringify(result)).not.toContain('Private error text');
    expect(factory).toHaveBeenCalledOnce();
    expect(client.generateText).toHaveBeenCalledOnce();
  });

  it('does not construct history from an overflowing trace or turn fulfilled into rejected', async () => {
    const client = clientFixture();
    client.generateText.mockImplementationOnce(async ({ onChunk }) => onChunk({ chunk: 'not fully retained' }));
    const { owner } = createOwner({
      client, runId: 'overflow', plan: 'first-continuity-independent', traceLimits: { maximumEvents: 1, maximumCharacters: 10 },
    });
    const result = await owner.run();
    expect(result.run).toEqual({ status: 'stopped', reason: 'capture-incomplete' });
    expect(result.requests[0]?.trace.settled?.outcome).toEqual({ status: 'fulfilled' });
    expect(result.requests[0]?.trace.completeness).toBe('incomplete');
    expect(result.requests.slice(1).every(request => request.status === 'not-started' && request.input === undefined)).toBe(true);
    expect(client.generateText).toHaveBeenCalledOnce();
  });

  it('records pre-run abort as not-started, not as a Provider rejection', async () => {
    const client = clientFixture();
    const { owner, factory } = createOwner({ client, runId: 'preabort', plan: 'first-continuity-independent', traceLimits: limits });
    owner.abort({ reason: 'user-requested' });
    owner.abort({ reason: 'deadline' });
    const result = await owner.run();
    expect(result.run).toEqual({ status: 'stopped', reason: 'aborted' });
    expect(result.abortReason).toBe('user-requested');
    expect(result.requests.every(request => request.status === 'not-started' && request.trace.settled === undefined)).toBe(true);
    expect(result.events.filter(event => event.kind === 'abort-requested')).toHaveLength(1);
    expect(factory).not.toHaveBeenCalled();
    expect(client.interrupt).not.toHaveBeenCalled();
  });

  it('keeps actual fulfilled settlement when abort races with a cooperative generation completion', async () => {
    const client = clientFixture();
    const entered = deferred<void>();
    const generation = deferred<void>();
    client.generateText.mockImplementationOnce(() => {
      entered.resolve(); return generation.promise;
    });
    client.interrupt.mockImplementationOnce(async () => generation.resolve());
    const { owner } = createOwner({ client, runId: 'aborting', plan: 'first-continuity-independent', traceLimits: limits });
    const running = owner.run();
    await entered.promise;
    owner.abort({ reason: 'deadline' });
    const result = await running;
    expect(result.abortReason).toBe('deadline');
    expect(result.run).toEqual({ status: 'stopped', reason: 'aborted' });
    expect(result.requests[0]?.trace.settled?.outcome).toEqual({ status: 'fulfilled' });
    expect(result.requests.slice(1).every(request => request.status === 'not-started')).toBe(true);
    expect(client.interrupt).toHaveBeenCalledOnce();
    expect(client.generateText).toHaveBeenCalledOnce();
  });

  it('rejects concurrent and repeated runs rather than queuing them', async () => {
    const client = clientFixture();
    const entered = deferred<void>();
    const generation = deferred<void>();
    client.generateText.mockImplementationOnce(() => {
      entered.resolve(); return generation.promise;
    });
    const { owner } = createOwner({ client, runId: 'once', plan: 'first-only', traceLimits: limits });
    const running = owner.run();
    await entered.promise;
    await expect(owner.run()).rejects.toThrow('only once');
    generation.resolve();
    await running;
    await expect(owner.run()).rejects.toThrow('only once');
    expect(client.generateText).toHaveBeenCalledOnce();
  });

  it('terminally disposes pending work without waiting for settlement or resurrecting a client', async () => {
    const client = clientFixture();
    const entered = deferred<void>();
    const generation = deferred<void>();
    const cleanup = deferred<void>();
    const disposed = new ProductionWorkerLifecycleError({ reason: 'disposed', message: 'Controlled physical client disposal' });
    client.generateText.mockImplementationOnce(() => {
      entered.resolve(); return generation.promise;
    });
    client.dispose.mockImplementationOnce(() => {
      generation.reject(disposed); return cleanup.promise;
    });
    const { owner, factory } = createOwner({ client, runId: 'dispose-pending', plan: 'first-continuity-independent', traceLimits: limits });
    const running = owner.run();
    await entered.promise;
    const closing = owner.dispose();
    expect(owner.dispose()).toBe(closing);
    expect(client.dispose).toHaveBeenCalledOnce();
    expect(owner.snapshot()).toMatchObject({ lifetime: 'closing', disposal: 'pending', observation: 'end-requested-by-dispose' });
    await expect(owner.run()).rejects.toThrow('terminally disposed');
    const result = await running;
    expect(result.run).toEqual({ status: 'stopped', reason: 'disposed' });
    expect(result.requests[0]?.trace.settled?.outcome).toEqual({ status: 'rejected', errorName: 'ProductionWorkerLifecycleError' });
    expect(result.requests.slice(1).every(request => request.status === 'not-started')).toBe(true);
    cleanup.resolve();
    await closing;
    expect(owner.snapshot()).toMatchObject({ lifetime: 'closed', disposal: 'completed' });
    expect(factory).toHaveBeenCalledOnce();
    expect(client.unloadModel).not.toHaveBeenCalled();
    expect(client.resetCache).not.toHaveBeenCalled();
  });

  it('retains cleanup failure without changing the original failed Provider trace', async () => {
    const client = clientFixture();
    const generationError = Object.assign(new Error('Original generation failure'), { name: 'SyntaxError' });
    const cleanupError = new Error('Separate cleanup failure');
    client.generateText.mockRejectedValueOnce(generationError);
    client.dispose.mockRejectedValueOnce(cleanupError);
    const { owner, factory } = createOwner({ client, runId: 'two-failures', plan: 'first-only', traceLimits: limits });
    const result = await owner.run();
    const closing = owner.dispose();
    await expect(closing).rejects.toBe(cleanupError);
    expect(owner.dispose()).toBe(closing);
    expect(owner.snapshot()).toMatchObject({ lifetime: 'closed', disposal: 'failed' });
    expect(owner.snapshot().requests[0]?.trace.settled).toEqual(result.requests[0]?.trace.settled);
    expect(result.requests[0]?.trace.settled?.outcome).toEqual({ status: 'rejected', errorName: 'SyntaxError' });
    await expect(owner.run()).rejects.toThrow('terminally disposed');
    expect(factory).toHaveBeenCalledOnce();
    expect(client.dispose).toHaveBeenCalledOnce();
  });

  it('disposes an unused owner without creating a Worker and never accepts a later run', async () => {
    const client = clientFixture();
    const { owner, factory } = createOwner({ client, runId: 'unused', plan: 'first-only', traceLimits: limits });
    const closing = owner.dispose();
    expect(owner.dispose()).toBe(closing);
    await closing;
    await expect(owner.run()).rejects.toThrow('terminally disposed');
    expect(owner.snapshot()).toMatchObject({ run: { status: 'not-started' }, lifetime: 'closed', disposal: 'completed' });
    expect(factory).not.toHaveBeenCalled();
    expect(client.dispose).not.toHaveBeenCalled();
  });

  it('does not interrupt or dispose a separate real service or another capture owner', async () => {
    const ordinaryClient = clientFixture();
    const ordinary = createTransformersJsService({ createWorkerClient: () => ordinaryClient });
    owners.push(ordinary);
    await ordinary.service.loadDownloadedModel({ modelId: 'fixture/model' });
    const first = createOwner({ client: clientFixture(), runId: 'isolated-one', plan: 'first-only', traceLimits: limits });
    const secondClient = clientFixture();
    const second = createOwner({ client: secondClient, runId: 'isolated-two', plan: 'first-only', traceLimits: limits });
    await first.owner.run();
    await second.owner.run();
    await first.owner.dispose();
    expect(ordinary.service.getState()).toMatchObject({ status: 'ready', activeModelId: 'fixture/model' });
    expect(ordinaryClient.dispose).not.toHaveBeenCalled();
    expect(ordinaryClient.interrupt).not.toHaveBeenCalled();
    expect(secondClient.dispose).not.toHaveBeenCalled();
    expect(secondClient.interrupt).not.toHaveBeenCalled();
    expect(second.owner.snapshot().lifetime).toBe('open');
    expect(transformersJsService.getState()).toMatchObject({ status: 'idle', activeModelId: undefined });
  });

  it('rejects malformed identities and recording limits before creating a client', () => {
    const factory = vi.fn(() => clientFixture());
    expect(() => createProductionProviderCaptureOwner({
      runId: 'valid', modelId: 'https://external.invalid/model', plan: 'first-only', createWorkerClient: factory, traceLimits: limits,
    })).toThrow();
    expect(() => createProductionProviderCaptureOwner({
      runId: 'valid', modelId: 'fixture/..', plan: 'first-only', createWorkerClient: factory, traceLimits: limits,
    })).toThrow();
    expect(() => createProductionProviderCaptureOwner({
      runId: 'valid', modelId: 'huggingface.co/fixture/model', plan: 'first-only', createWorkerClient: factory, traceLimits: limits,
    })).toThrow();
    expect(() => createProductionProviderCaptureOwner({
      runId: 'invalid/identity', modelId: 'fixture/model', plan: 'first-only', createWorkerClient: factory, traceLimits: limits,
    })).toThrow();
    expect(() => createProductionProviderCaptureOwner({
      runId: 'valid', modelId: 'fixture/model', plan: 'first-only', createWorkerClient: factory,
      traceLimits: { maximumEvents: 5000, maximumCharacters: 10 },
    })).toThrow();
    expect(factory).not.toHaveBeenCalled();
  });

  it('preserves the supported hf.co spelling through the real Provider and service without alias reloads', async () => {
    const client = clientFixture();
    const owner = createProductionProviderCaptureOwner({
      runId: 'hf-alias', modelId: 'hf.co/fixture/model', plan: 'first-continuity-independent',
      createWorkerClient: () => client, traceLimits: limits,
    });
    owners.push(owner);
    const result = await owner.run();
    expect(result.modelId).toBe('hf.co/fixture/model');
    expect(result.run).toEqual({ status: 'completed' });
    expect(client.loadDownloadedModel).toHaveBeenCalledOnce();
    expect(client.loadDownloadedModel.mock.calls[0]?.[0].modelId).toBe('hf.co/fixture/model');
    expect(client.generateText).toHaveBeenCalledTimes(3);
  });
});
