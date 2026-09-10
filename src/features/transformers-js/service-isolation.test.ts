// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFiles } from './replay-models/support/download-memory-files';
import { ProductionWorkerLifecycleError } from './worker/production-worker-session';
import type { TransformersJsWorkerClient } from './types';
import type { ChatMessage } from '@/01-models/types';
import { toToolCallId } from '@/01-models/ids';
import type { resolvePublicHuggingFaceRevision } from './download-verification/logic/resolve-public-hugging-face-revision';
import type { reuseDownloadedProductionRevision } from './download-verification/logic/reuse-downloaded-production-revision';
import type { runProductionDownloadPreparation } from './download-verification/logic/run-production-download-preparation';

const download = vi.hoisted(() => ({
  resolve: vi.fn<typeof resolvePublicHuggingFaceRevision>(),
  reuse: vi.fn<typeof reuseDownloadedProductionRevision>(),
  prepare: vi.fn<typeof runProductionDownloadPreparation>(),
}));
vi.mock('./download-verification/logic/resolve-public-hugging-face-revision', () => ({ resolvePublicHuggingFaceRevision: download.resolve }));
vi.mock('./download-verification/logic/reuse-downloaded-production-revision', () => ({ reuseDownloadedProductionRevision: download.reuse }));
vi.mock('./download-verification/logic/run-production-download-preparation', () => ({ runProductionDownloadPreparation: download.prepare }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

const owners: Array<{ dispose(): Promise<void> }> = [];
async function createOwner({ createWorkerClient }: { createWorkerClient: () => TransformersJsWorkerClient }) {
  const { createTransformersJsService } = await import('./index-hosted');
  const owner = createTransformersJsService({ createWorkerClient });
  owners.push(owner);
  return owner;
}

beforeEach(() => {
  vi.resetAllMocks();
  const fs = createMemoryFiles();
  fs.enter({ nextPhase: 'load', mutationPolicy: 'read-only' });
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => fs.root } });
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('Service ownership tests forbid network access');
  }));
  download.resolve.mockRejectedValue(new Error('Unexpected explicit Download'));
  download.reuse.mockRejectedValue(new Error('Unexpected explicit Download reuse'));
  download.prepare.mockRejectedValue(new Error('Unexpected explicit Download preparation'));
});

afterEach(async () => {
  try {
    // All fixture clients are local and finite. A deliberately rejected dispose
    // is already asserted by its test and must not prevent other owner cleanup.
    await Promise.all(owners.splice(0).map(owner => owner.dispose().catch(() => undefined)));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

// These tests cover the real service with controlled client lifecycles, not
// native Worker termination, GPU reclamation, or cancellation of Download I/O.
describe('Transformers.js service instance ownership', () => {
  it.each(['absent', 'undefined'] as const)('keeps %s optional tool fields out of ordinary messages sent to every model', async shape => {
    const client = createClientFixture();
    const owner = await createOwner({ createWorkerClient: () => client });
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Synthetic user.' },
      { role: 'assistant', content: 'Synthetic answer.' },
    ];
    if (shape === 'undefined') {
      for (const message of messages) {
        message.tool_calls = undefined;
        message.tool_call_id = undefined;
      }
    }
    await owner.service.loadDownloadedModel({ modelId: 'fixture/model' });
    await owner.service.generateText({ messages, onChunk: vi.fn(), onToolCalls: vi.fn() });
    const sent = client.generateText.mock.calls[0]?.[0].messages;
    expect(sent).toStrictEqual([
      { role: 'user', content: 'Synthetic user.' },
      { role: 'assistant', content: 'Synthetic answer.' },
    ]);
    expect(sent).not.toBe(messages);
    expect(sent?.[0]).not.toBe(messages[0]);
  });

  it('preserves image parts, explicit empty tool lists and tool associations in detached Worker messages', async () => {
    const client = createClientFixture();
    const owner = await createOwner({ createWorkerClient: () => client });
    const id = toToolCallId({ raw: 'synthetic-call' });
    const parts = [
      { type: 'text' as const, text: 'Describe the fixture.' },
      { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,fixture' } },
    ];
    const calls = [{ id, type: 'function' as const, function: { name: 'lookup', arguments: '{"value":1}' } }];
    const messages: ChatMessage[] = [
      { role: 'user', content: parts },
      { role: 'assistant', content: '', tool_calls: calls },
      { role: 'tool', content: 'Synthetic result.', tool_call_id: id },
      { role: 'assistant', content: 'Done.', tool_calls: [] },
    ];
    const expected = structuredClone(messages);
    await owner.service.loadDownloadedModel({ modelId: 'fixture/model' });
    await owner.service.generateText({ messages, onChunk: vi.fn(), onToolCalls: vi.fn() });
    parts[0]!.text = 'Changed';
    parts[1]!.image_url!.url = 'changed';
    calls[0]!.function.arguments = '{}';
    messages[2]!.tool_call_id = toToolCallId({ raw: 'changed' });
    expect(client.generateText.mock.calls[0]?.[0].messages).toStrictEqual(expected);
  });

  it('isolates model state, progress listeners and generated callbacks between owners', async () => {
    const firstClient = createClientFixture();
    const secondClient = createClientFixture();
    const firstFactory = vi.fn(() => firstClient);
    const secondFactory = vi.fn(() => secondClient);
    const first = await createOwner({ createWorkerClient: firstFactory });
    const second = await createOwner({ createWorkerClient: secondFactory });
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    first.service.subscribe({ listener: firstListener });
    second.service.subscribe({ listener: secondListener });
    await first.service.loadDownloadedModel({ modelId: 'fixture/first' });
    expect(second.service.getState()).toMatchObject({ status: 'idle', activeModelId: undefined });
    expect(secondListener).toHaveBeenCalledOnce();
    await second.service.loadDownloadedModel({ modelId: 'fixture/second' });
    const firstEvents = firstListener.mock.calls.length;
    firstClient.generateText.mockImplementationOnce(async ({ onChunk }) => onChunk({ chunk: 'first' }));
    secondClient.generateText.mockImplementationOnce(async ({ onChunk }) => onChunk({ chunk: 'second' }));
    const chunks: string[] = [];
    await first.service.generateText({ messages: [], onChunk: ({ chunk }) => chunks.push(chunk), onToolCalls: vi.fn() });
    await second.service.generateText({ messages: [], onChunk: ({ chunk }) => chunks.push(chunk), onToolCalls: vi.fn() });
    expect(chunks).toEqual(['first', 'second']);
    await second.service.unloadModel();
    expect(firstListener).toHaveBeenCalledTimes(firstEvents);
    expect(first.service.getState()).toMatchObject({ status: 'ready', activeModelId: 'fixture/first' });
    expect(firstFactory).toHaveBeenCalledOnce();
    expect(secondFactory).toHaveBeenCalledOnce();
    const { transformersJsService } = await import('./index-hosted');
    expect(transformersJsService.getState()).toMatchObject({ status: 'idle', activeModelId: undefined });
  });

  it('keeps the one-use explicit Download revision hint local to its service', async () => {
    const revision = 'a'.repeat(40);
    download.resolve.mockResolvedValue({ normalizedModelId: 'fixture/same', requestedRevision: 'main', resolvedRevision: revision });
    download.reuse.mockResolvedValue({
      reused: true, loadRevision: revision,
      acceptance: {
        status: 'accepted', selectedRevision: { revision, loaderRevisionOption: revision, source: 'current-resolved-revision' },
        attempts: [], error: undefined,
      },
    });
    const firstClient = createClientFixture();
    const secondClient = createClientFixture();
    const first = await createOwner({ createWorkerClient: () => firstClient });
    const second = await createOwner({ createWorkerClient: () => secondClient });
    await first.service.downloadModel({ modelId: 'fixture/same' });
    await second.service.loadDownloadedModel({ modelId: 'fixture/same' });
    await first.service.loadDownloadedModel({ modelId: 'fixture/same' });
    expect(secondClient.loadDownloadedModel).toHaveBeenCalledWith(expect.objectContaining({ revision: undefined }));
    expect(firstClient.loadDownloadedModel).toHaveBeenCalledWith(expect.objectContaining({ revision }));
    expect(download.prepare).not.toHaveBeenCalled();
  });

  it('disposes an unused owner idempotently without creating a client and rejects new work', async () => {
    const factory = vi.fn(() => createClientFixture());
    const owner = await createOwner({ createWorkerClient: factory });
    const closing = owner.dispose();
    expect(owner.dispose()).toBe(closing);
    await closing;
    await expect(owner.service.loadDownloadedModel({ modelId: 'fixture/closed' })).rejects.toMatchObject({ reason: 'disposed' });
    await expect(owner.service.generateText({ messages: [], onChunk: vi.fn(), onToolCalls: vi.fn() })).rejects.toMatchObject({ reason: 'disposed' });
    await expect(owner.service.restart()).rejects.toMatchObject({ reason: 'disposed' });
    await expect(owner.service.downloadModel({ modelId: 'fixture/closed' })).rejects.toMatchObject({ reason: 'disposed' });
    expect(factory).not.toHaveBeenCalled();
    expect(download.resolve).not.toHaveBeenCalled();
  });

  it('rejects pending generation on terminal disposal without fatal-error resurrection', async () => {
    const client = createClientFixture();
    const pending = deferred<void>();
    const entered = deferred<void>();
    const disposed = new ProductionWorkerLifecycleError({ reason: 'disposed', message: 'Fixture client disposed' });
    client.generateText.mockImplementationOnce(() => {
      entered.resolve(); return pending.promise;
    });
    client.dispose.mockImplementationOnce(async () => pending.reject(disposed));
    const factory = vi.fn(() => client);
    const owner = await createOwner({ createWorkerClient: factory });
    await owner.service.loadDownloadedModel({ modelId: 'fixture/pending' });
    const generation = owner.service.generateText({ messages: [], onChunk: vi.fn(), onToolCalls: vi.fn() });
    const rejected = expect(generation).rejects.toBe(disposed);
    await entered.promise;
    await owner.dispose();
    await rejected;
    expect(factory).toHaveBeenCalledOnce();
    expect(client.dispose).toHaveBeenCalledOnce();
    expect(client.unloadModel).not.toHaveBeenCalled();
  });

  it('does not publish ready or accept late progress after a disposed pending Load completes', async () => {
    const client = createClientFixture();
    const pending = deferred<{ device: 'webgpu' }>();
    const entered = deferred<void>();
    client.loadDownloadedModel.mockImplementationOnce(() => {
      entered.resolve(); return pending.promise;
    });
    const factory = vi.fn(() => client);
    const owner = await createOwner({ createWorkerClient: factory });
    const listener = vi.fn();
    const modelListener = vi.fn();
    owner.service.subscribe({ listener });
    owner.service.subscribeModelList({ listener: modelListener });
    const loading = owner.service.loadDownloadedModel({ modelId: 'fixture/late' });
    const rejected = expect(loading).rejects.toMatchObject({ reason: 'disposed' });
    await entered.promise;
    await owner.dispose();
    const atDisposal = listener.mock.calls.length;
    client.loadDownloadedModel.mock.calls[0]![0].progressCallback({ info: { status: 'done', file: 'fixture.onnx', progress: 100 } });
    pending.resolve({ device: 'webgpu' });
    await rejected;
    expect(listener).toHaveBeenCalledTimes(atDisposal);
    expect(modelListener).not.toHaveBeenCalled();
    expect(owner.service.getState()).toMatchObject({ status: 'idle', activeModelId: undefined });
    expect(factory).toHaveBeenCalledOnce();
  });

  it('closes during restart disposal without creating a replacement for restart or its waiting Load', async () => {
    const client = createClientFixture();
    const releaseDisposal = deferred<void>();
    const disposalStarted = deferred<void>();
    client.dispose.mockImplementationOnce(() => {
      disposalStarted.resolve(); return releaseDisposal.promise;
    });
    const factory = vi.fn(() => client);
    const owner = await createOwner({ createWorkerClient: factory });
    await owner.service.loadDownloadedModel({ modelId: 'fixture/restart' });
    const restarting = owner.service.restart();
    const restartRejected = expect(restarting).rejects.toMatchObject({ reason: 'disposed' });
    await disposalStarted.promise;
    const loading = owner.service.loadDownloadedModel({ modelId: 'fixture/next' });
    const loadRejected = expect(loading).rejects.toMatchObject({ reason: 'disposed' });
    const closing = owner.dispose();
    expect(owner.dispose()).toBe(closing);
    releaseDisposal.resolve();
    await closing;
    await restartRejected;
    await loadRejected;
    expect(factory).toHaveBeenCalledOnce();
    expect(client.dispose).toHaveBeenCalledOnce();
    expect(client.loadDownloadedModel).toHaveBeenCalledOnce();
  });

  it('retains terminal cleanup failure and never retries disposal or creates another client', async () => {
    const client = createClientFixture();
    const error = new Error('Synthetic client disposal failure');
    client.dispose.mockRejectedValueOnce(error);
    const factory = vi.fn(() => client);
    const owner = await createOwner({ createWorkerClient: factory });
    await owner.service.loadDownloadedModel({ modelId: 'fixture/cleanup' });
    const closing = owner.dispose();
    await expect(closing).rejects.toBe(error);
    expect(owner.dispose()).toBe(closing);
    await expect(owner.service.restart()).rejects.toMatchObject({ reason: 'disposed' });
    expect(client.dispose).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledOnce();
  });

  it('preserves ordinary fatal generation restart while the owner is open', async () => {
    const original = createClientFixture();
    const replacement = createClientFixture();
    const error = new ProductionWorkerLifecycleError({ reason: 'worker-error', message: 'Synthetic fatal generation error' });
    original.generateText.mockRejectedValueOnce(error);
    const factory = vi.fn<() => TransformersJsWorkerClient>().mockReturnValueOnce(original).mockReturnValueOnce(replacement);
    const owner = await createOwner({ createWorkerClient: factory });
    await owner.service.loadDownloadedModel({ modelId: 'fixture/recover' });
    await expect(owner.service.generateText({ messages: [], onChunk: vi.fn(), onToolCalls: vi.fn() })).rejects.toBe(error);
    expect(original.dispose).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(owner.service.getState()).toMatchObject({ status: 'idle', activeModelId: undefined });
    await owner.service.loadDownloadedModel({ modelId: 'fixture/recover' });
    expect(replacement.loadDownloadedModel).toHaveBeenCalledOnce();
    await owner.dispose();
    expect(original.dispose).toHaveBeenCalledOnce();
    expect(replacement.dispose).toHaveBeenCalledOnce();
  });

  it('preserves the original generation error when terminal disposal interrupts its recovery', async () => {
    const client = createClientFixture();
    const error = new ProductionWorkerLifecycleError({ reason: 'worker-error', message: 'Original synthetic failure' });
    const disposalStarted = deferred<void>();
    const releaseDisposal = deferred<void>();
    client.generateText.mockRejectedValueOnce(error);
    client.dispose.mockImplementationOnce(() => {
      disposalStarted.resolve(); return releaseDisposal.promise;
    });
    const factory = vi.fn(() => client);
    const owner = await createOwner({ createWorkerClient: factory });
    await owner.service.loadDownloadedModel({ modelId: 'fixture/fatal' });
    const generation = owner.service.generateText({ messages: [], onChunk: vi.fn(), onToolCalls: vi.fn() });
    const rejected = expect(generation).rejects.toBe(error);
    await disposalStarted.promise;
    const closing = owner.dispose();
    releaseDisposal.resolve();
    await closing;
    await rejected;
    expect(factory).toHaveBeenCalledOnce();
  });

  it('does not restart when a pending unload rejects after terminal disposal', async () => {
    const client = createClientFixture();
    const entered = deferred<void>();
    const pending = deferred<void>();
    const error = new Error('Synthetic delayed unload failure');
    client.unloadModel.mockImplementationOnce(() => {
      entered.resolve(); return pending.promise;
    });
    const factory = vi.fn(() => client);
    const owner = await createOwner({ createWorkerClient: factory });
    await owner.service.loadDownloadedModel({ modelId: 'fixture/unload' });
    const unloading = owner.service.unloadModel();
    const rejected = expect(unloading).rejects.toBe(error);
    await entered.promise;
    await owner.dispose();
    pending.reject(error);
    await rejected;
    expect(factory).toHaveBeenCalledOnce();
    expect(client.dispose).toHaveBeenCalledOnce();
  });

  it('leaves separately owned Download I/O uncancelled but refuses its next phase after disposal', async () => {
    const resolution = deferred<Awaited<ReturnType<typeof resolvePublicHuggingFaceRevision>>>();
    const entered = deferred<void>();
    download.resolve.mockImplementationOnce(() => {
      entered.resolve(); return resolution.promise;
    });
    const factory = vi.fn(() => createClientFixture());
    const owner = await createOwner({ createWorkerClient: factory });
    const pendingDownload = owner.service.downloadModel({ modelId: 'fixture/download' });
    const rejected = expect(pendingDownload).rejects.toMatchObject({ reason: 'disposed' });
    await entered.promise;
    await owner.dispose();
    // The external operation is explicitly released by the fixture: dispose
    // never claimed to cancel its HTTP/acceptance owner or pending OPFS work.
    resolution.resolve({ normalizedModelId: 'fixture/download', requestedRevision: 'main', resolvedRevision: 'b'.repeat(40) });
    await rejected;
    expect(download.reuse).not.toHaveBeenCalled();
    expect(download.prepare).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
    expect(owner.service.getState()).toMatchObject({ status: 'idle', activeModelId: undefined });
  });

  it('keeps abort local and forwards the original callbacks without a settlement gate', async () => {
    const firstClient = createClientFixture();
    const secondClient = createClientFixture();
    const first = await createOwner({ createWorkerClient: () => firstClient });
    const second = await createOwner({ createWorkerClient: () => secondClient });
    await first.service.loadDownloadedModel({ modelId: 'fixture/first' });
    await second.service.loadDownloadedModel({ modelId: 'fixture/second' });
    const pending = deferred<void>();
    const entered = deferred<void>();
    firstClient.generateText.mockImplementationOnce(() => {
      entered.resolve(); return pending.promise;
    });
    const controller = new AbortController();
    const onChunk = vi.fn();
    const onToolCalls = vi.fn();
    const generation = first.service.generateText({ messages: [], onChunk, onToolCalls, signal: controller.signal });
    await entered.promise;
    controller.abort();
    pending.resolve();
    await generation;
    expect(firstClient.interrupt).toHaveBeenCalledOnce();
    expect(secondClient.interrupt).not.toHaveBeenCalled();
    const request = firstClient.generateText.mock.calls[0]![0];
    expect(request.onChunk).toBe(onChunk);
    expect(request.onToolCalls).toBe(onToolCalls);
    // Controlled late delivery at the client boundary, not a browser timing
    // claim. An open service must not add a new callback ACK or drop this call.
    request.onChunk({ chunk: 'late fixture chunk' });
    expect(onChunk).toHaveBeenCalledExactlyOnceWith({ chunk: 'late fixture chunk' });
  });
});
