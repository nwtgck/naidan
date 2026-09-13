// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTransformersJsService } from './index-hosted';
import type { TransformersJsWorkerClient } from './types';
import { createTransformersJsProvider } from './provider-hosted';
import type { ChatMessage, LmParameters } from '@/01-models/types';

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

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('Service concurrency controls forbid network access');
  }));
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// The real service owns controlled, small client operations. These tests do not
// claim native inference, physical Worker termination, or browser GPU behavior.
describe('Transformers.js service runtime serialization', () => {
  it('records a completed unload without fatal recovery when its owner was interrupted', async () => {
    const client = createClientFixture();
    const factory = vi.fn(() => client);
    const owner = createTransformersJsService({ createWorkerClient: factory });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    client.unloadModel.mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
    const operations: Promise<unknown>[] = [];
    try {
      await owner.service.loadDownloadedModel({ modelId: 'fixture/model' });
      const unloading = owner.service.unloadModel();
      operations.push(expect(unloading).rejects.toMatchObject({ name: 'AbortError' }));
      await entered.promise;
      await owner.service.interrupt();
      release.resolve(); await Promise.all(operations);
      expect(client.dispose).not.toHaveBeenCalled();
      expect(factory).toHaveBeenCalledTimes(1);
      expect(owner.service.getState()).toMatchObject({ status: 'idle', activeModelId: undefined });
    } finally { release.resolve(); await Promise.allSettled(operations); await owner.dispose(); }
  });

  it('allows an independent service to finish while another service holds its own runtime', async () => {
    const firstClient = createClientFixture();
    const secondClient = createClientFixture();
    const first = createTransformersJsService({ createWorkerClient: () => firstClient });
    const second = createTransformersJsService({ createWorkerClient: () => secondClient });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    firstClient.generateText.mockImplementationOnce(async () => {
      entered.resolve(); await release.promise;
    });
    const operations: Promise<unknown>[] = [];
    let firstFinished = false;
    try {
      await first.service.loadDownloadedModel({ modelId: 'fixture/first' });
      await second.service.loadDownloadedModel({ modelId: 'fixture/second' });
      operations.push(first.service.generateText({ messages: [], onChunk: vi.fn(), onToolCalls: vi.fn() }).then(() => {
        firstFinished = true;
      }));
      await entered.promise;
      await second.service.generateText({ messages: [], onChunk: vi.fn(), onToolCalls: vi.fn() });
      expect(secondClient.generateText).toHaveBeenCalledTimes(1);
      expect(firstFinished).toBe(false);
      expect(firstClient.interrupt).not.toHaveBeenCalled();
    } finally {
      release.resolve(); await Promise.allSettled(operations);
      await Promise.all([first.dispose(), second.dispose()]);
    }
  });

  it('preserves an ordinary generation error and starts the next queued request afterward', async () => {
    const client = createClientFixture();
    const owner = createTransformersJsService({ createWorkerClient: () => client });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const failure = new Error('Controlled nonfatal generation failure');
    client.generateText.mockImplementationOnce(async () => {
      entered.resolve(); await release.promise; throw failure;
    });
    const operations: Promise<unknown>[] = [];
    try {
      await owner.service.loadDownloadedModel({ modelId: 'fixture/model' });
      const first = owner.service.generateText({ messages: [], onChunk: vi.fn(), onToolCalls: vi.fn() });
      operations.push(expect(first).rejects.toBe(failure));
      await entered.promise;
      operations.push(owner.service.generateText({ messages: [{ role: 'user', content: 'Next request.' }], onChunk: vi.fn(), onToolCalls: vi.fn() }));
      expect(client.generateText).toHaveBeenCalledTimes(1);
      release.resolve(); await Promise.all(operations);
      expect(client.generateText).toHaveBeenCalledTimes(2);
      expect(client.dispose).not.toHaveBeenCalled();
    } finally {
      release.resolve(); await Promise.allSettled(operations); await owner.dispose();
    }
  });

  it('snapshots Provider messages and parameters before a different chat finishes', async () => {
    const client = createClientFixture();
    const owner = createTransformersJsService({ createWorkerClient: () => client });
    const provider = createTransformersJsProvider({ service: owner.service });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    client.generateText.mockImplementationOnce(async () => {
      entered.resolve(); await release.promise;
    });
    const operations: Promise<unknown>[] = [];
    try {
      operations.push(provider.chat({ model: 'fixture/model', messages: [], onChunk: vi.fn() }));
      await entered.promise;
      const messages: ChatMessage[] = [{ role: 'user', content: 'Accepted Provider input.' }];
      const parameters: LmParameters = {
        temperature: 0.25, topP: undefined, maxCompletionTokens: undefined,
        presencePenalty: undefined, frequencyPenalty: undefined,
        reasoning: { effort: undefined }, stop: ['accepted-stop'],
      };
      operations.push(provider.chat({ model: 'fixture/model', messages, parameters, onChunk: vi.fn() }));
      messages[0]!.content = 'Changed while queued.';
      parameters.stop!.push('changed-stop');
      release.resolve(); await Promise.all(operations);
      expect(client.generateText.mock.calls[1]![0].messages).toEqual([{ role: 'user', content: 'Accepted Provider input.' }]);
      expect(client.generateText.mock.calls[1]![0].params?.stop).toEqual(['accepted-stop']);
      expect(client.loadDownloadedModel).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve(); await Promise.allSettled(operations); await owner.dispose();
    }
  });

  it('snapshots a queued generation input before its caller can mutate it', async () => {
    const client = createClientFixture();
    const owner = createTransformersJsService({ createWorkerClient: () => client });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    client.generateText.mockImplementationOnce(async () => {
      entered.resolve(); await release.promise;
    });
    const operations: Promise<unknown>[] = [];
    try {
      await owner.service.loadDownloadedModel({ modelId: 'fixture/model' });
      operations.push(owner.service.generateText({ messages: [], onChunk: vi.fn(), onToolCalls: vi.fn() }));
      await entered.promise;
      const messages: ChatMessage[] = [{ role: 'user', content: 'Accepted input.' }];
      const params: LmParameters = {
        temperature: 0.25, stop: ['accepted-stop'], topP: undefined,
        maxCompletionTokens: undefined, presencePenalty: undefined,
        frequencyPenalty: undefined, reasoning: { effort: undefined },
      };
      operations.push(owner.service.generateText({ messages, params, onChunk: vi.fn(), onToolCalls: vi.fn() }));
      messages[0]!.content = 'Changed after admission.';
      params.temperature = 0.75;
      params.stop!.push('changed-stop');
      release.resolve();
      await Promise.all(operations);
      expect(client.generateText.mock.calls[1]![0].messages).toEqual([{ role: 'user', content: 'Accepted input.' }]);
      expect(client.generateText.mock.calls[1]![0].params).toMatchObject({ temperature: 0.25, stop: ['accepted-stop'] });
    } finally {
      release.resolve(); await Promise.allSettled(operations); await owner.dispose();
    }
  });

  it('rejects a direct generation accepted without a ready model without creating a client', async () => {
    const client = createClientFixture();
    const factory = vi.fn(() => client);
    const owner = createTransformersJsService({ createWorkerClient: factory });
    try {
      await expect(owner.service.generateText({ messages: [], onChunk: vi.fn(), onToolCalls: vi.fn() })).rejects.toThrow('Model not loaded');
      expect(factory).not.toHaveBeenCalled();
    } finally {
      await owner.dispose();
    }
  });

  it('does not send a queued direct generation to a different model selected ahead of it', async () => {
    const client = createClientFixture();
    const owner = createTransformersJsService({ createWorkerClient: () => client });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    client.generateText.mockImplementationOnce(async () => {
      entered.resolve(); await release.promise;
    });
    const operations: Promise<unknown>[] = [];
    try {
      await owner.service.loadDownloadedModel({ modelId: 'fixture/first' });
      operations.push(owner.service.generateText({ messages: [], onChunk: vi.fn(), onToolCalls: vi.fn() }));
      await entered.promise;
      operations.push(owner.service.loadDownloadedModel({ modelId: 'fixture/second' }));
      const rejected = expect(owner.service.generateText({ messages: [], onChunk: vi.fn(), onToolCalls: vi.fn() })).rejects.toThrow('no longer loaded');
      operations.push(rejected);
      release.resolve();
      await Promise.all(operations);
      expect(client.generateText).toHaveBeenCalledTimes(1);
      expect(client.loadDownloadedModel.mock.calls.map(([args]) => args.modelId)).toEqual(['fixture/first', 'fixture/second']);
    } finally {
      release.resolve(); await Promise.allSettled(operations); await owner.dispose();
    }
  });

  it('invalidates ready state when canceled while fatal recovery is retiring its old client', async () => {
    const original = createClientFixture();
    const replacement = createClientFixture();
    const disposalStarted = Promise.withResolvers<void>();
    const releaseDisposal = Promise.withResolvers<void>();
    const abort = new AbortController();
    original.generateText.mockRejectedValueOnce(new Error('RuntimeError: Aborted()'));
    original.dispose.mockImplementationOnce(async () => {
      disposalStarted.resolve(); await releaseDisposal.promise;
    });
    const factory = vi.fn<() => TransformersJsWorkerClient>().mockReturnValueOnce(original).mockReturnValueOnce(replacement);
    const owner = createTransformersJsService({ createWorkerClient: factory });
    const provider = createTransformersJsProvider({ service: owner.service });
    const operations: Promise<unknown>[] = [];
    try {
      await owner.service.loadDownloadedModel({ modelId: 'fixture/model' });
      const generation = provider.chat({ model: 'fixture/model', messages: [], onChunk: vi.fn(), signal: abort.signal });
      operations.push(generation.catch(error => error));
      await disposalStarted.promise;
      abort.abort();
      releaseDisposal.resolve();
      await expect(operations[0]).resolves.toMatchObject({ name: 'AbortError' });
      await provider.chat({ model: 'fixture/model', messages: [], onChunk: vi.fn() });
      expect(replacement.loadDownloadedModel).toHaveBeenCalledTimes(1);
      expect(replacement.generateText).toHaveBeenCalledTimes(1);
      expect(replacement.loadDownloadedModel.mock.invocationCallOrder[0]).toBeLessThan(replacement.generateText.mock.invocationCallOrder[0]!);
      expect(factory).toHaveBeenCalledTimes(2);
    } finally {
      releaseDisposal.resolve(); await Promise.allSettled(operations); await owner.dispose();
    }
  });

  it('forbids replacement and subsequent Load after fatal recovery cannot dispose its old client', async () => {
    const original = createClientFixture();
    const replacement = createClientFixture();
    const failure = new Error('Controlled disposal failure');
    original.generateText.mockRejectedValueOnce(new Error('RuntimeError: Aborted()'));
    original.dispose.mockRejectedValue(failure);
    const factory = vi.fn<() => TransformersJsWorkerClient>().mockReturnValueOnce(original).mockReturnValue(replacement);
    const owner = createTransformersJsService({ createWorkerClient: factory });
    try {
      await owner.service.loadDownloadedModel({ modelId: 'fixture/model' });
      await expect(owner.service.generateText({ messages: [], onChunk: vi.fn(), onToolCalls: vi.fn() })).rejects.toBe(failure);
      await expect(owner.service.loadDownloadedModel({ modelId: 'fixture/next' })).rejects.toBe(failure);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(replacement.loadDownloadedModel).not.toHaveBeenCalled();
    } finally {
      await owner.dispose().catch(() => undefined);
    }
  });

  it('dispatches generation FIFO only after the preceding client operation settles', async () => {
    const client = createClientFixture();
    const owner = createTransformersJsService({ createWorkerClient: () => client });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const starts: string[] = [];
    client.generateText.mockImplementation(async ({ continuationOwner }) => {
      starts.push(continuationOwner!);
      if (continuationOwner === 'first') {
        entered.resolve();
        await release.promise;
      }
    });
    const operations: Promise<unknown>[] = [];
    try {
      await owner.service.loadDownloadedModel({ modelId: 'fixture/model' });
      operations.push(owner.service.generateText({ messages: [], onChunk: vi.fn(), onToolCalls: vi.fn(), continuationOwner: 'first' }));
      await entered.promise;
      operations.push(owner.service.generateText({ messages: [], onChunk: vi.fn(), onToolCalls: vi.fn(), continuationOwner: 'second' }));
      operations.push(owner.service.generateText({ messages: [], onChunk: vi.fn(), onToolCalls: vi.fn(), continuationOwner: 'third' }));
      await Promise.resolve();
      expect(starts).toEqual(['first']);
      release.resolve();
      await Promise.all(operations);
      expect(starts).toEqual(['first', 'second', 'third']);
      expect(client.interrupt).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.allSettled(operations);
      await owner.dispose();
    }
  });

  it('cancels a waiting generation without interrupting the running owner', async () => {
    const client = createClientFixture();
    const owner = createTransformersJsService({ createWorkerClient: () => client });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const abort = new AbortController();
    client.generateText.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const operations: Promise<unknown>[] = [];
    try {
      await owner.service.loadDownloadedModel({ modelId: 'fixture/model' });
      operations.push(owner.service.generateText({ messages: [], onChunk: vi.fn(), onToolCalls: vi.fn() }));
      await entered.promise;
      const waiting = owner.service.generateText({ messages: [], onChunk: vi.fn(), onToolCalls: vi.fn(), signal: abort.signal });
      // Own either outcome immediately; the abort result is checked separately
      // from whether the active client's interrupt authority was exercised.
      const waitingOutcome = waiting.then(() => ({ kind: 'fulfilled' as const }), error => ({ kind: 'rejected' as const, error }));
      operations.push(waitingOutcome);
      abort.abort();
      await expect(waitingOutcome).resolves.toMatchObject({ kind: 'rejected', error: { name: 'AbortError' } });
      expect(client.interrupt).not.toHaveBeenCalled();
      expect(client.generateText).toHaveBeenCalledTimes(1);
      release.resolve();
      await operations[0];
    } finally {
      release.resolve();
      await Promise.allSettled(operations);
      await owner.dispose();
    }
  });

  it('starts only one same-model Load when two callers arrive before client acquisition yields', async () => {
    const client = createClientFixture();
    const owner = createTransformersJsService({ createWorkerClient: () => client });
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    client.loadDownloadedModel.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return { device: 'webgpu' };
    });
    const operations: Promise<unknown>[] = [];
    try {
      operations.push(owner.service.loadDownloadedModel({ modelId: 'fixture/model' }));
      operations.push(owner.service.loadDownloadedModel({ modelId: 'fixture/model' }));
      await entered.promise;
      expect(client.loadDownloadedModel).toHaveBeenCalledTimes(1);
      release.resolve();
      await Promise.all(operations);
      expect(client.loadDownloadedModel).toHaveBeenCalledTimes(1);
      expect(owner.service.getState()).toMatchObject({ status: 'ready', activeModelId: 'fixture/model' });
    } finally {
      release.resolve();
      await Promise.allSettled(operations);
      await owner.dispose();
    }
  });

  it('does not unload a model until its active generation has settled', async () => {
    const client = createClientFixture();
    const owner = createTransformersJsService({ createWorkerClient: () => client });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    client.generateText.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const operations: Promise<unknown>[] = [];
    try {
      await owner.service.loadDownloadedModel({ modelId: 'fixture/model' });
      operations.push(owner.service.generateText({ messages: [], onChunk: vi.fn(), onToolCalls: vi.fn() }));
      await entered.promise;
      operations.push(owner.service.unloadModel());
      await Promise.resolve();
      expect(client.unloadModel).not.toHaveBeenCalled();
      release.resolve();
      await Promise.all(operations);
      expect(client.unloadModel).toHaveBeenCalledTimes(1);
      expect(owner.service.getState()).toMatchObject({ status: 'idle', activeModelId: undefined });
    } finally {
      release.resolve();
      await Promise.allSettled(operations);
      await owner.dispose();
    }
  });
});
