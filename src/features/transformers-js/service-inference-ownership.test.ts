// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { toToolCallId } from '@/01-models/ids';
import type { Tool } from '@/01-models/tool';
import { createTransformersJsService } from './index-hosted';
import type { TransformersJsInferenceScope } from './inference-operation';
import { createTransformersJsProvider } from './provider-hosted';
import { createMemoryFiles } from './replay-models/support/download-memory-files';
import { createProviderReplayTestRuntime } from './replay-models/support/provider-replay-test-runtime';
import type { TransformersJsWorkerClient } from './types';
import { ProductionWorkerLifecycleError } from './worker/production-worker-session';

function createClientFixture() {
  return {
    loadDownloadedModel: vi.fn<TransformersJsWorkerClient['loadDownloadedModel']>().mockResolvedValue({ device: 'webgpu' }),
    unloadModel: vi.fn<TransformersJsWorkerClient['unloadModel']>().mockResolvedValue(undefined),
    generateText: vi.fn<TransformersJsWorkerClient['generateText']>().mockResolvedValue(undefined),
    interrupt: vi.fn<TransformersJsWorkerClient['interrupt']>().mockResolvedValue(undefined),
    resetCache: vi.fn<TransformersJsWorkerClient['resetCache']>().mockResolvedValue(undefined),
    dispose: vi.fn<TransformersJsWorkerClient['dispose']>().mockResolvedValue(undefined),
  } satisfies TransformersJsWorkerClient;
}

function generationArgs({ continuationOwner }: { continuationOwner: string }) {
  return {
    messages: [], onChunk: vi.fn(), onToolCalls: vi.fn(),
    params: undefined, tools: undefined, continuationOwner,
  } satisfies Parameters<TransformersJsInferenceScope['generateText']>[0];
}

function observe({ promise }: { promise: Promise<void> }) {
  return promise.then(
    () => ({ status: 'fulfilled' as const }),
    (error: unknown) => ({ status: 'rejected' as const, error }),
  );
}

const owners: Array<ReturnType<typeof createTransformersJsService>> = [];
const forbiddenFetch = vi.fn<typeof fetch>(async () => {
  throw new Error('Inference ownership tests forbid network access');
});
function createOwner({ createWorkerClient }: { createWorkerClient: () => TransformersJsWorkerClient }) {
  const owner = createTransformersJsService({ createWorkerClient });
  owners.push(owner);
  return owner;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const fs = createMemoryFiles();
  fs.enter({ nextPhase: 'load', mutationPolicy: 'read-only' });
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => fs.root } });
  forbiddenFetch.mockClear();
  vi.stubGlobal('fetch', forbiddenFetch);
});

afterEach(async () => {
  try {
    await Promise.all(owners.splice(0).map(owner => owner.dispose().catch(() => undefined)));
    expect(forbiddenFetch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

// Controlled clients exercise the actual service and Provider ownership rules.
// Their successful void results are synthetic lifecycle controls, not native
// generation evidence or proof of physical browser Worker termination.
describe('Transformers.js inference scope ownership', () => {
  it('revokes an escaped facade after its callback returns', async () => {
    const client = createClientFixture();
    const owner = createOwner({ createWorkerClient: () => client });
    const escaped = Promise.withResolvers<TransformersJsInferenceScope>();
    await owner.service.runInferenceOperation({
      signal: undefined,
      operation: async ({ scope }) => {
        escaped.resolve(scope);
      },
    });
    const scope = await escaped.promise;
    expect(() => scope.assertActive()).toThrow();
    await expect(scope.loadDownloadedModel({ modelId: 'fixture/escaped' })).rejects.toThrow();
    await expect(scope.generateText(generationArgs({ continuationOwner: 'escaped' }))).rejects.toThrow();
    expect(client.loadDownloadedModel).not.toHaveBeenCalled();
    expect(client.generateText).not.toHaveBeenCalled();
  });

  it('rejects a simultaneous child without interrupting or overlapping the first child', async () => {
    const client = createClientFixture();
    const owner = createOwner({ createWorkerClient: () => client });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const secondOutcome = Promise.withResolvers<Awaited<ReturnType<typeof observe>>>();
    client.generateText.mockImplementationOnce(async () => {
      entered.resolve(); await release.promise;
    });
    await owner.service.loadDownloadedModel({ modelId: 'fixture/model' });
    const operation = observe({ promise: owner.service.runInferenceOperation({
      signal: undefined,
      operation: async ({ scope }) => {
        const first = scope.generateText(generationArgs({ continuationOwner: 'first' }));
        await entered.promise;
        secondOutcome.resolve(await observe({ promise: scope.generateText(generationArgs({ continuationOwner: 'second' })) }));
        await first;
      },
    }) });
    try {
      expect(await secondOutcome.promise).toMatchObject({ status: 'rejected', error: expect.any(Error) });
      expect(client.generateText).toHaveBeenCalledTimes(1);
      expect(client.interrupt).not.toHaveBeenCalled();
      release.resolve();
      expect(await operation).toEqual({ status: 'fulfilled' });
    } finally {
      release.resolve();
      await operation;
    }
  });

  it('drains an unawaited successful child after callback return before releasing the lane', async () => {
    const client = createClientFixture();
    const owner = createOwner({ createWorkerClient: () => client });
    const entered = Promise.withResolvers<void>();
    const callbackFinished = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const trace: string[] = [];
    let child: ReturnType<typeof observe> | undefined;
    client.generateText.mockImplementation(async ({ continuationOwner }) => {
      trace.push(`${continuationOwner}:start`);
      if (continuationOwner === 'first') {
        entered.resolve();
        await release.promise;
        trace.push('first:settled');
      }
    });
    await owner.service.loadDownloadedModel({ modelId: 'fixture/model' });
    const first = observe({ promise: owner.service.runInferenceOperation({
      signal: undefined,
      operation: async ({ scope }) => {
        child = observe({ promise: scope.generateText(generationArgs({ continuationOwner: 'first' })) });
        await entered.promise;
        trace.push('callback:finished');
        callbackFinished.resolve();
      },
    }) });
    let firstSettled = false;
    void first.then(() => {
      firstSettled = true;
    });
    await callbackFinished.promise;
    const second = observe({ promise: owner.service.generateText(generationArgs({ continuationOwner: 'second' })) });
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(firstSettled).toBe(false);
      expect(trace).toEqual(['first:start', 'callback:finished']);
      release.resolve();
      expect(await first).toEqual({ status: 'fulfilled' });
      expect(await child).toEqual({ status: 'fulfilled' });
      expect(await second).toEqual({ status: 'fulfilled' });
      expect(trace).toEqual(['first:start', 'callback:finished', 'first:settled', 'second:start']);
    } finally {
      release.resolve();
      await first;
      await second;
      await child;
    }
  });

  it('drains an unawaited rejected child after callback throw and preserves the callback error', async () => {
    const client = createClientFixture();
    const owner = createOwner({ createWorkerClient: () => client });
    const entered = Promise.withResolvers<void>();
    const callbackFinished = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const callbackError = new Error('Synthetic callback failure');
    const childError = new Error('Synthetic child failure');
    const trace: string[] = [];
    let child: ReturnType<typeof observe> | undefined;
    client.generateText.mockImplementation(async ({ continuationOwner }) => {
      trace.push(`${continuationOwner}:start`);
      if (continuationOwner === 'first') {
        entered.resolve();
        await release.promise;
        trace.push('first:settled');
        throw childError;
      }
    });
    await owner.service.loadDownloadedModel({ modelId: 'fixture/model' });
    const first = observe({ promise: owner.service.runInferenceOperation({
      signal: undefined,
      operation: async ({ scope }) => {
        child = observe({ promise: scope.generateText(generationArgs({ continuationOwner: 'first' })) });
        await entered.promise;
        trace.push('callback:finished');
        callbackFinished.resolve();
        throw callbackError;
      },
    }) });
    let firstSettled = false;
    void first.then(() => {
      firstSettled = true;
    });
    await callbackFinished.promise;
    const second = observe({ promise: owner.service.generateText(generationArgs({ continuationOwner: 'second' })) });
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(firstSettled).toBe(false);
      expect(trace).toEqual(['first:start', 'callback:finished']);
      release.resolve();
      expect(await first).toEqual({ status: 'rejected', error: callbackError });
      expect(await child).toEqual({ status: 'rejected', error: childError });
      expect(await second).toEqual({ status: 'fulfilled' });
      expect(trace).toEqual(['first:start', 'callback:finished', 'first:settled', 'second:start']);
    } finally {
      release.resolve();
      await first;
      await second;
      await child;
    }
  });

  it('retires the old epoch before a fresh runtime and ignores late child failure and callbacks', async () => {
    const oldClient = createClientFixture();
    const freshClient = createClientFixture();
    const createWorkerClient = vi.fn().mockReturnValueOnce(oldClient).mockReturnValue(freshClient);
    const owner = createOwner({ createWorkerClient });
    const entered = Promise.withResolvers<void>();
    const releaseOld = Promise.withResolvers<void>();
    const oldChildSettled = Promise.withResolvers<void>();
    const disposing = Promise.withResolvers<void>();
    const finishDispose = Promise.withResolvers<void>();
    const freshEntered = Promise.withResolvers<void>();
    const releaseFresh = Promise.withResolvers<void>();
    const chunks: string[] = [];
    const escaped = Promise.withResolvers<TransformersJsInferenceScope>();
    oldClient.generateText.mockImplementation(async ({ onChunk }) => {
      entered.resolve();
      await releaseOld.promise;
      onChunk({ chunk: 'stale child output' });
      throw new ProductionWorkerLifecycleError({ reason: 'worker-error', message: 'Synthetic retired Worker failure' });
    });
    oldClient.dispose.mockImplementation(async () => {
      disposing.resolve(); await finishDispose.promise;
    });
    freshClient.generateText.mockImplementation(async () => {
      freshEntered.resolve(); await releaseFresh.promise;
    });
    await owner.service.loadDownloadedModel({ modelId: 'fixture/old' });
    const old = observe({ promise: owner.service.runInferenceOperation({ signal: undefined, operation: async ({ scope }) => {
      escaped.resolve(scope);
      try {
        await scope.generateText({ ...generationArgs({ continuationOwner: 'old' }), onChunk: ({ chunk }) => {
          chunks.push(chunk);
        } });
      } finally {
        oldChildSettled.resolve();
      }
    } }) });
    await entered.promise;
    const waiting = observe({ promise: owner.service.loadDownloadedModel({ modelId: 'fixture/waiting' }) });
    const restart = observe({ promise: owner.service.restart() });
    const coalesced = observe({ promise: owner.service.restart() });
    let fresh: ReturnType<typeof observe> | undefined;
    try {
      await disposing.promise;
      expect(createWorkerClient).toHaveBeenCalledTimes(1);
      const retiredScope = await escaped.promise;
      expect(retiredScope.signal.aborted).toBe(true);
      expect(() => retiredScope.assertActive()).toThrow();
      expect(await old).toMatchObject({ status: 'rejected', error: { reason: 'restarted' } });
      expect(await waiting).toMatchObject({ status: 'rejected', error: { reason: 'restarted' } });
      expect(await observe({ promise: owner.service.loadDownloadedModel({ modelId: 'fixture/during-reset' }) })).toMatchObject({ status: 'rejected' });
      finishDispose.resolve();
      expect(await restart).toEqual({ status: 'fulfilled' });
      expect(await coalesced).toEqual({ status: 'fulfilled' });
      expect(oldClient.dispose).toHaveBeenCalledTimes(1);
      expect(createWorkerClient).toHaveBeenCalledTimes(2);
      await owner.service.loadDownloadedModel({ modelId: 'fixture/fresh' });
      fresh = observe({ promise: owner.service.generateText(generationArgs({ continuationOwner: 'fresh' })) });
      await freshEntered.promise;
      releaseOld.resolve();
      await oldChildSettled.promise;
      await Promise.resolve();
      await Promise.resolve();
      expect(chunks).toEqual([]);
      expect(owner.service.getState()).toMatchObject({ status: 'ready', activeModelId: 'fixture/fresh' });
      expect(freshClient.dispose).not.toHaveBeenCalled();
      expect(createWorkerClient).toHaveBeenCalledTimes(2);
      releaseFresh.resolve();
      expect(await fresh).toEqual({ status: 'fulfilled' });
      await owner.service.generateText(generationArgs({ continuationOwner: 'later' }));
      expect(freshClient.generateText).toHaveBeenCalledTimes(2);
    } finally {
      finishDispose.resolve();
      releaseOld.resolve();
      releaseFresh.resolve();
      await restart;
      await coalesced;
      await old;
      await oldChildSettled.promise;
      await waiting;
      await fresh;
    }
  });

  it('does not publish a replacement when retiring the old client fails', async () => {
    const oldClient = createClientFixture();
    const freshClient = createClientFixture();
    const disposalError = new Error('Synthetic physical disposal failure');
    oldClient.dispose.mockRejectedValue(disposalError);
    const createWorkerClient = vi.fn().mockReturnValueOnce(oldClient).mockReturnValue(freshClient);
    const owner = createOwner({ createWorkerClient });
    await owner.service.loadDownloadedModel({ modelId: 'fixture/old' });
    expect(await observe({ promise: owner.service.restart() })).toEqual({ status: 'rejected', error: disposalError });
    expect(await observe({ promise: owner.service.loadDownloadedModel({ modelId: 'fixture/new' }) })).toMatchObject({ status: 'rejected' });
    expect(createWorkerClient).toHaveBeenCalledTimes(1);
    expect(freshClient.loadDownloadedModel).not.toHaveBeenCalled();
    expect(freshClient.generateText).not.toHaveBeenCalled();
  });

  it('revokes a noncooperative Provider tool returning after restart without leaking events or continuing on the replacement', async () => {
    const oldClient = createClientFixture();
    const freshClient = createClientFixture();
    const createWorkerClient = vi.fn().mockReturnValueOnce(oldClient).mockReturnValue(freshClient);
    const owner = createOwner({ createWorkerClient });
    const provider = createTransformersJsProvider({ service: owner.service });
    const toolEntered = Promise.withResolvers<AbortSignal | undefined>();
    const releaseTool = Promise.withResolvers<void>();
    const toolReturned = Promise.withResolvers<void>();
    const onToolEvent = vi.fn();
    const onToolResult = vi.fn();
    const tool: Tool = {
      name: 'controlled_tool', description: 'Synthetic noncooperative tool lifetime.', parametersSchema: z.object({}),
      execute: async ({ signal, onEvent }) => {
        toolEntered.resolve(signal);
        await releaseTool.promise;
        await onEvent?.({ event: { type: 'output', stream: 'stdout', text: 'retired tool output' } });
        toolReturned.resolve();
        return { status: 'success', content: 'retired tool result' };
      },
    };
    oldClient.generateText.mockImplementationOnce(async ({ onToolCalls }) => {
      onToolCalls({ toolCalls: [{ id: toToolCallId({ raw: 'synthetic-owned-tool' }), type: 'function', function: { name: tool.name, arguments: '{}' } }] });
    });
    const oldChat = observe({ promise: provider.chat({ model: 'fixture/old', messages: [{ role: 'user', content: 'Synthetic tool request.' }], onChunk: vi.fn(), tools: [tool], onToolEvent, onToolResult }) });
    try {
      const toolSignal = await toolEntered.promise;
      await owner.service.restart();
      expect(await oldChat).toMatchObject({ status: 'rejected', error: { reason: 'restarted' } });
      expect(toolSignal?.aborted).toBe(true);
      await provider.chat({ model: 'fixture/fresh', messages: [{ role: 'user', content: 'Independent synthetic request.' }], onChunk: vi.fn() });
      releaseTool.resolve();
      await toolReturned.promise;
      await Promise.resolve();
      await Promise.resolve();
      expect(onToolEvent).not.toHaveBeenCalled();
      expect(onToolResult).not.toHaveBeenCalled();
      expect(oldClient.generateText).toHaveBeenCalledTimes(1);
      expect(freshClient.generateText).toHaveBeenCalledTimes(1);
      expect(freshClient.dispose).not.toHaveBeenCalled();
      expect(owner.service.getState()).toMatchObject({ status: 'ready', activeModelId: 'fixture/fresh' });
    } finally {
      releaseTool.resolve();
      await oldChat;
    }
  });

  it('revokes a noncooperative Provider tool rejecting after restart without leaking an error result to the replacement', async () => {
    const oldClient = createClientFixture();
    const freshClient = createClientFixture();
    const createWorkerClient = vi.fn().mockReturnValueOnce(oldClient).mockReturnValue(freshClient);
    const owner = createOwner({ createWorkerClient });
    const provider = createTransformersJsProvider({ service: owner.service });
    const toolEntered = Promise.withResolvers<AbortSignal | undefined>();
    const releaseTool = Promise.withResolvers<void>();
    const toolReturned = Promise.withResolvers<void>();
    const onToolEvent = vi.fn();
    const onToolResult = vi.fn();
    const tool: Tool = {
      name: 'controlled_tool', description: 'Synthetic noncooperative tool lifetime.', parametersSchema: z.object({}),
      execute: async ({ signal, onEvent }) => {
        toolEntered.resolve(signal);
        await releaseTool.promise;
        await onEvent?.({ event: { type: 'output', stream: 'stdout', text: 'retired tool output' } });
        toolReturned.resolve();
        throw new Error('Synthetic retired tool failure');
      },
    };
    oldClient.generateText.mockImplementationOnce(async ({ onToolCalls }) => {
      onToolCalls({ toolCalls: [{ id: toToolCallId({ raw: 'synthetic-owned-tool' }), type: 'function', function: { name: tool.name, arguments: '{}' } }] });
    });
    const oldChat = observe({ promise: provider.chat({ model: 'fixture/old', messages: [{ role: 'user', content: 'Synthetic tool request.' }], onChunk: vi.fn(), tools: [tool], onToolEvent, onToolResult }) });
    try {
      const toolSignal = await toolEntered.promise;
      await owner.service.restart();
      expect(await oldChat).toMatchObject({ status: 'rejected', error: { reason: 'restarted' } });
      expect(toolSignal?.aborted).toBe(true);
      await provider.chat({ model: 'fixture/fresh', messages: [{ role: 'user', content: 'Independent synthetic request.' }], onChunk: vi.fn() });
      releaseTool.resolve();
      await toolReturned.promise;
      await Promise.resolve();
      await Promise.resolve();
      expect(onToolEvent).not.toHaveBeenCalled();
      expect(onToolResult).not.toHaveBeenCalled();
      expect(oldClient.generateText).toHaveBeenCalledTimes(1);
      expect(freshClient.generateText).toHaveBeenCalledTimes(1);
      expect(freshClient.dispose).not.toHaveBeenCalled();
      expect(owner.service.getState()).toMatchObject({ status: 'ready', activeModelId: 'fixture/fresh' });
    } finally {
      releaseTool.resolve();
      await oldChat;
    }
  });

  it('retires a canceled Provider AutoLoad before starting the queued model on a fresh client', async () => {
    const original = createClientFixture();
    const replacement = createClientFixture();
    const loadEntered = Promise.withResolvers<void>();
    const pendingLoad = Promise.withResolvers<{ device: 'webgpu' }>();
    const loadSettled = Promise.withResolvers<void>();
    const disposalEntered = Promise.withResolvers<void>();
    const releaseDisposal = Promise.withResolvers<void>();
    const abort = new AbortController();
    const trace: string[] = [];
    original.loadDownloadedModel.mockImplementation(async () => {
      trace.push('old:load');
      loadEntered.resolve();
      try {
        return await pendingLoad.promise;
      } finally {
        loadSettled.resolve();
      }
    });
    original.dispose.mockImplementation(async () => {
      trace.push('old:dispose-start');
      pendingLoad.reject(new ProductionWorkerLifecycleError({ reason: 'disposed', message: 'Synthetic canceled Load retirement' }));
      disposalEntered.resolve();
      await releaseDisposal.promise;
      trace.push('old:dispose-complete');
    });
    replacement.loadDownloadedModel.mockImplementation(async ({ modelId }) => {
      trace.push(`fresh:load:${modelId}`);
      return { device: 'webgpu' };
    });
    replacement.generateText.mockImplementation(async () => {
      trace.push('fresh:generate');
    });
    const factory = vi.fn<() => TransformersJsWorkerClient>().mockReturnValueOnce(original).mockReturnValue(replacement);
    const owner = createOwner({ createWorkerClient: factory });
    const provider = createTransformersJsProvider({ service: owner.service });
    const first = observe({ promise: provider.chat({ model: 'fixture/old', messages: [], onChunk: vi.fn(), signal: abort.signal }) });
    await loadEntered.promise;
    const second = observe({ promise: provider.chat({ model: 'fixture/next', messages: [], onChunk: vi.fn() }) });
    let firstSettled = false;
    void first.then(() => {
      firstSettled = true;
    });
    try {
      // No Worker interrupt contract exists for Load. Cancel the owning chat;
      // the service must retire its captured client, not issue an interrupt RPC.
      abort.abort();
      expect(original.dispose).toHaveBeenCalledTimes(1);
      await disposalEntered.promise;
      await loadSettled.promise;
      expect(firstSettled).toBe(false);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(original.interrupt).not.toHaveBeenCalled();
      expect(original.generateText).not.toHaveBeenCalled();
      expect(replacement.loadDownloadedModel).not.toHaveBeenCalled();
      expect(replacement.generateText).not.toHaveBeenCalled();
      releaseDisposal.resolve();
      expect(await first).toMatchObject({ status: 'rejected', error: { name: 'AbortError' } });
      expect(await second).toEqual({ status: 'fulfilled' });
      expect(trace).toEqual(['old:load', 'old:dispose-start', 'old:dispose-complete', 'fresh:load:fixture/next', 'fresh:generate']);
      expect(factory).toHaveBeenCalledTimes(2);
      expect(original.generateText).not.toHaveBeenCalled();
      expect(owner.service.getState()).toMatchObject({ status: 'ready', activeModelId: 'fixture/next' });
    } finally {
      releaseDisposal.resolve();
      pendingLoad.reject(new Error('Synthetic Load test cleanup'));
      await first;
      await second;
    }
  });

  it('rejects queued and later Provider chats when canceled AutoLoad retirement fails', async () => {
    const original = createClientFixture();
    const replacement = createClientFixture();
    const loadEntered = Promise.withResolvers<void>();
    const pendingLoad = Promise.withResolvers<{ device: 'webgpu' }>();
    const disposalEntered = Promise.withResolvers<void>();
    const releaseDisposal = Promise.withResolvers<void>();
    const disposalError = new Error('Synthetic canceled Load cleanup failure');
    const abort = new AbortController();
    original.loadDownloadedModel.mockImplementation(async () => {
      loadEntered.resolve();
      return pendingLoad.promise;
    });
    original.dispose.mockImplementation(async () => {
      pendingLoad.reject(new ProductionWorkerLifecycleError({ reason: 'disposed', message: 'Synthetic canceled Load retirement' }));
      disposalEntered.resolve();
      await releaseDisposal.promise;
      throw disposalError;
    });
    const factory = vi.fn<() => TransformersJsWorkerClient>().mockReturnValueOnce(original).mockReturnValue(replacement);
    const owner = createOwner({ createWorkerClient: factory });
    const provider = createTransformersJsProvider({ service: owner.service });
    const first = observe({ promise: provider.chat({ model: 'fixture/old', messages: [], onChunk: vi.fn(), signal: abort.signal }) });
    await loadEntered.promise;
    const waiting = observe({ promise: provider.chat({ model: 'fixture/waiting', messages: [], onChunk: vi.fn() }) });
    try {
      abort.abort();
      await disposalEntered.promise;
      expect(factory).toHaveBeenCalledTimes(1);
      expect(replacement.loadDownloadedModel).not.toHaveBeenCalled();
      releaseDisposal.resolve();
      expect(await first).toEqual({ status: 'rejected', error: disposalError });
      expect(await waiting).toEqual({ status: 'rejected', error: disposalError });
      expect(await observe({ promise: provider.chat({ model: 'fixture/later', messages: [], onChunk: vi.fn() }) })).toEqual({ status: 'rejected', error: disposalError });
      expect(factory).toHaveBeenCalledTimes(1);
      expect(original.dispose).toHaveBeenCalledTimes(1);
      expect(original.generateText).not.toHaveBeenCalled();
      expect(original.interrupt).not.toHaveBeenCalled();
      expect(replacement.loadDownloadedModel).not.toHaveBeenCalled();
      expect(replacement.generateText).not.toHaveBeenCalled();
      expect(owner.service.getState()).toMatchObject({ status: 'error', activeModelId: undefined });
    } finally {
      releaseDisposal.resolve();
      pendingLoad.reject(new Error('Synthetic Load test cleanup'));
      await first;
      await waiting;
    }
  });

  it('keeps a successful Provider tool and its continuation ahead of a queued different-model chat', async () => {
    const client = createClientFixture();
    const owner = createOwner({ createWorkerClient: () => client });
    const provider = createTransformersJsProvider({ service: owner.service });
    const toolEntered = Promise.withResolvers<void>();
    const releaseTool = Promise.withResolvers<void>();
    const trace: string[] = [];
    const toolId = toToolCallId({ raw: 'synthetic-fifo-tool' });
    const tool: Tool = {
      name: 'controlled_tool', description: 'Synthetic successful tool lifetime.', parametersSchema: z.object({}),
      execute: async () => {
        trace.push('tool:entered');
        toolEntered.resolve();
        await releaseTool.promise;
        trace.push('tool:completed');
        return { status: 'success', content: 'Synthetic tool result.' };
      },
    };
    client.loadDownloadedModel.mockImplementation(async ({ modelId }) => {
      trace.push(`load:${modelId}`);
      return { device: 'webgpu' };
    });
    client.generateText.mockImplementationOnce(async ({ onToolCalls }) => {
      trace.push('old:initial');
      onToolCalls({ toolCalls: [{ id: toolId, type: 'function', function: { name: tool.name, arguments: '{}' } }] });
    }).mockImplementationOnce(async () => {
      trace.push('old:continuation');
    }).mockImplementationOnce(async () => {
      trace.push('next:initial');
    });
    const onToolResult = vi.fn();
    const first = observe({ promise: provider.chat({ model: 'fixture/old', messages: [{ role: 'user', content: 'Synthetic tool request.' }], onChunk: vi.fn(), tools: [tool], onToolResult }) });
    await toolEntered.promise;
    const second = observe({ promise: provider.chat({ model: 'fixture/next', messages: [{ role: 'user', content: 'Independent next request.' }], onChunk: vi.fn() }) });
    try {
      expect(trace).toEqual(['load:fixture/old', 'old:initial', 'tool:entered']);
      expect(client.loadDownloadedModel).toHaveBeenCalledTimes(1);
      expect(client.generateText).toHaveBeenCalledTimes(1);
      releaseTool.resolve();
      expect(await first).toEqual({ status: 'fulfilled' });
      expect(await second).toEqual({ status: 'fulfilled' });
      expect(trace).toEqual(['load:fixture/old', 'old:initial', 'tool:entered', 'tool:completed', 'old:continuation', 'load:fixture/next', 'next:initial']);
      expect(onToolResult).toHaveBeenCalledExactlyOnceWith({ id: toolId, result: { status: 'success', content: 'Synthetic tool result.' } });
      expect(client.generateText.mock.calls[1]?.[0].messages.at(-1)).toEqual({ role: 'tool', content: 'Synthetic tool result.', tool_call_id: toolId });
      expect(client.generateText.mock.calls[2]?.[0].messages).toEqual([{ role: 'user', content: 'Independent next request.' }]);
      expect(client.interrupt).not.toHaveBeenCalled();
      expect(client.dispose).not.toHaveBeenCalled();
    } finally {
      releaseTool.resolve();
      await first;
      await second;
    }
  });

  it('drains a normally canceled noncooperative Provider tool before admitting the queued chat', async () => {
    const client = createClientFixture();
    const owner = createOwner({ createWorkerClient: () => client });
    const provider = createTransformersJsProvider({ service: owner.service });
    const toolEntered = Promise.withResolvers<AbortSignal | undefined>();
    const releaseTool = Promise.withResolvers<void>();
    const abort = new AbortController();
    const trace: string[] = [];
    const onToolEvent = vi.fn();
    const onToolResult = vi.fn();
    const tool: Tool = {
      name: 'controlled_tool', description: 'Synthetic noncooperative normal cancellation.', parametersSchema: z.object({}),
      execute: async ({ signal, onEvent }) => {
        trace.push('tool:entered');
        toolEntered.resolve(signal);
        await releaseTool.promise;
        await onEvent?.({ event: { type: 'output', stream: 'stdout', text: 'Canceled tool output.' } });
        trace.push('tool:completed');
        return { status: 'success', content: 'Canceled tool result.' };
      },
    };
    client.loadDownloadedModel.mockImplementation(async ({ modelId }) => {
      trace.push(`load:${modelId}`);
      return { device: 'webgpu' };
    });
    client.generateText.mockImplementationOnce(async ({ onToolCalls }) => {
      trace.push('old:initial');
      onToolCalls({ toolCalls: [{ id: toToolCallId({ raw: 'synthetic-canceled-tool' }), type: 'function', function: { name: tool.name, arguments: '{}' } }] });
    }).mockImplementationOnce(async () => {
      trace.push('next:initial');
    });
    const first = observe({ promise: provider.chat({ model: 'fixture/old', messages: [], onChunk: vi.fn(), tools: [tool], onToolEvent, onToolResult, signal: abort.signal }) });
    const toolSignal = await toolEntered.promise;
    const second = observe({ promise: provider.chat({ model: 'fixture/next', messages: [{ role: 'user', content: 'Independent request after cancellation.' }], onChunk: vi.fn() }) });
    let firstSettled = false;
    let secondSettled = false;
    void first.then(() => {
      firstSettled = true;
    });
    void second.then(() => {
      secondSettled = true;
    });
    try {
      abort.abort();
      await Promise.resolve();
      await Promise.resolve();
      expect(toolSignal?.aborted).toBe(true);
      expect(firstSettled).toBe(false);
      expect(secondSettled).toBe(false);
      expect(trace).toEqual(['load:fixture/old', 'old:initial', 'tool:entered']);
      expect(client.dispose).not.toHaveBeenCalled();
      expect(client.interrupt).not.toHaveBeenCalled();
      releaseTool.resolve();
      expect(await first).toMatchObject({ status: 'rejected', error: { name: 'AbortError' } });
      expect(await second).toEqual({ status: 'fulfilled' });
      expect(trace).toEqual(['load:fixture/old', 'old:initial', 'tool:entered', 'tool:completed', 'load:fixture/next', 'next:initial']);
      expect(onToolEvent).not.toHaveBeenCalled();
      expect(onToolResult).not.toHaveBeenCalled();
      expect(client.generateText).toHaveBeenCalledTimes(2);
      expect(client.generateText.mock.calls[1]?.[0].messages).toEqual([{ role: 'user', content: 'Independent request after cancellation.' }]);
      expect(client.dispose).not.toHaveBeenCalled();
      expect(owner.service.getState()).toMatchObject({ status: 'ready', activeModelId: 'fixture/next' });
    } finally {
      releaseTool.resolve();
      await first;
      await second;
    }
  });

  it('holds the lane after actual Worker interrupt acknowledgement until the native boundary settles', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const trace: string[] = [];
    const boundary = 'Synthetic native boundary stop; no generated output evidence';
    const harness = await createProviderReplayTestRuntime({
      modelId: 'HuggingFaceTB/SmolLM2-135M-Instruct',
      expectedRevision: '12fd25f77366fa6b3b4b768ec3050bf629380bac',
      cacheRevision: '12fd25f77366fa6b3b4b768ec3050bf629380bac',
      metadataCache: 'all-fixture',
      artifacts: [{ path: 'onnx/model_q4f16.onnx', bytes: Uint8Array.of(1, 2, 3) }],
      imagePlatform: undefined,
      generate: async () => {
        const ordinal = harness.observations.inferenceCalls.length;
        trace.push(`native:${ordinal}:entered`);
        if (ordinal === 1) {
          entered.resolve();
          await release.promise;
        }
        trace.push(`native:${ordinal}:settled`);
        throw new Error(boundary);
      },
    });
    const operations: Array<ReturnType<typeof observe>> = [];
    try {
      await harness.service.loadDownloadedModel({ modelId: 'HuggingFaceTB/SmolLM2-135M-Instruct' });
      const first = observe({ promise: harness.service.generateText({
        ...generationArgs({ continuationOwner: '00000000-0000-4000-8000-000000000001' }),
        messages: [{ role: 'user', content: 'First synthetic ownership input.' }],
      }) });
      operations.push(first);
      expect(await Promise.race([entered.promise.then(() => ({ status: 'entered' })), first])).toEqual({ status: 'entered' });
      let firstSettled = false;
      void first.then(() => {
        firstSettled = true;
      });
      const second = observe({ promise: harness.service.generateText({
        ...generationArgs({ continuationOwner: '00000000-0000-4000-8000-000000000002' }),
        messages: [{ role: 'user', content: 'Second independent synthetic ownership input.' }],
      }) });
      operations.push(second);
      const worker = harness.observations.workers[0]!;
      const interruptAcknowledged = Promise.withResolvers<void>();
      const requestSchema = z.object({ id: z.string(), type: z.literal('APPLY'), path: z.array(z.string()) });
      const replySchema = z.object({ id: z.string(), type: z.literal('RAW') });
      // Observe the actual service-issued Comlink request and matching reply;
      // do not invoke an entry directly or manufacture an acknowledgement.
      worker.addEventListener('message', event => {
        if (!(event instanceof MessageEvent)) return;
        const reply = replySchema.safeParse(event.data);
        if (!reply.success) return;
        const acknowledgedInterrupt = worker.hostMessages.some(message => {
          const request = requestSchema.safeParse(message);
          return request.success && request.data.id === reply.data.id
            && request.data.path.length === 1 && request.data.path[0] === 'interrupt';
        });
        if (acknowledgedInterrupt) interruptAcknowledged.resolve();
      });
      await harness.service.interrupt();
      await interruptAcknowledged.promise;
      expect(firstSettled).toBe(false);
      expect(trace).toEqual(['native:1:entered']);
      release.resolve();
      expect(await first).toMatchObject({ status: 'rejected' });
      expect(await second).toMatchObject({ status: 'rejected', error: { message: boundary } });
      expect(trace).toEqual(['native:1:entered', 'native:1:settled', 'native:2:entered', 'native:2:settled']);
      expect(harness.observations.inferenceCalls).toHaveLength(2);
      expect(harness.observations.workers).toHaveLength(1);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      release.resolve();
      await Promise.all(operations);
      await harness.close();
    }
    // The real client/Comlink/entry and transformed TJS input path ran in the
    // harness's single simulated Node Worker Realm; no browser/GPU claim.
    expect(harness.observations.cleanupErrors).toEqual([]);
  }, 30_000);

  it('preserves a deferred host callback rejection through scoped service, Comlink and Worker delivery settlement', async () => {
    const callbackEntered = Promise.withResolvers<void>();
    const releaseCallback = Promise.withResolvers<void>();
    const trace: string[] = [];
    const callbackError = new Error('Synthetic asynchronous delivery rejection');
    const secondBoundary = 'Synthetic independent native input stop';
    const callbackResult = releaseCallback.promise.then(() => {
      trace.push('callback:settled');
      throw callbackError;
    });
    // Own the rejection even in the RED case where a wrapper discards the
    // returned promise. The oracle is the RPC result, not an unhandled rejection.
    void callbackResult.catch(() => undefined);
    let nativeCalls = 0;
    const harness = await createProviderReplayTestRuntime({
      modelId: 'HuggingFaceTB/SmolLM2-135M-Instruct',
      expectedRevision: '12fd25f77366fa6b3b4b768ec3050bf629380bac',
      cacheRevision: '12fd25f77366fa6b3b4b768ec3050bf629380bac',
      metadataCache: 'all-fixture',
      artifacts: [{ path: 'onnx/model_q4f16.onnx', bytes: Uint8Array.of(1, 2, 3) }],
      imagePlatform: undefined,
      generate: async ({ options, tokenizer, runtime }) => {
        nativeCalls++;
        trace.push(`native:${nativeCalls}:entered`);
        if (nativeCalls !== 1) throw new Error(secondBoundary);
        const input = options.input_ids;
        if (!(input instanceof runtime.Tensor) || !options.streamer) throw new Error('Expected actual tokenizer input and streamer');
        // Explicit synthetic tokens exercise delivery mechanics, not model
        // inference correctness. The actual strategy/streamer/entry still run.
        const output = tokenizer.encode('Synthetic delivery.', { add_special_tokens: false }).map(BigInt);
        options.streamer.put(input.tolist());
        for (const token of output) options.streamer.put([[token]]);
        options.streamer.end();
        trace.push('native:1:returned');
        return new runtime.Tensor('int64', BigInt64Array.from(output), [1, output.length]);
      },
    });
    const operations: Array<ReturnType<typeof observe>> = [];
    try {
      await harness.service.loadDownloadedModel({ modelId: 'HuggingFaceTB/SmolLM2-135M-Instruct' });
      const first = observe({ promise: harness.service.runInferenceOperation({ signal: undefined, operation: async ({ scope }) => {
        await scope.generateText({
          ...generationArgs({ continuationOwner: '00000000-0000-4000-8000-000000000003' }),
          messages: [{ role: 'user', content: 'Synthetic delivery ownership input.' }],
          onChunk: () => {
            trace.push('callback:entered');
            callbackEntered.resolve();
            return callbackResult;
          },
        });
      } }) });
      operations.push(first);
      expect(await Promise.race([callbackEntered.promise.then(() => ({ status: 'entered' })), first])).toEqual({ status: 'entered' });
      const second = observe({ promise: harness.service.generateText({
        ...generationArgs({ continuationOwner: '00000000-0000-4000-8000-000000000004' }),
        messages: [{ role: 'user', content: 'Independent input after delivery failure.' }],
      }) });
      operations.push(second);
      expect(trace).toEqual(['native:1:entered', 'native:1:returned', 'callback:entered']);
      releaseCallback.resolve();
      expect(await first).toMatchObject({ status: 'rejected', error: { message: callbackError.message } });
      expect(await second).toMatchObject({ status: 'rejected', error: { message: secondBoundary } });
      expect(trace).toEqual(['native:1:entered', 'native:1:returned', 'callback:entered', 'callback:settled', 'native:2:entered']);
      expect(harness.observations.inferenceCalls).toHaveLength(2);
      expect(harness.observations.workers).toHaveLength(1);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      releaseCallback.resolve();
      await Promise.all(operations);
      await harness.close();
    }
    expect(harness.observations.cleanupErrors).toEqual([]);
  }, 30_000);
});
