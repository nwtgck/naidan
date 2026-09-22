import type { GenerationEvent } from '@/features/llama-cpp-browser/types';
// @vitest-environment node
import { MessageChannel } from 'node:worker_threads';
import * as Comlink from 'comlink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlobContext } from '@/utils/blob-view';
import { exposeWorkerRemote, releaseWorkerRemote, workerProxy, wrapWorkerRemote } from '@/utils/worker-transport';
import { createModelBlobFixture, ggufFile } from '@/features/llama-cpp-browser/test-utils/model-blob-view';
import { storedModelDirectory } from '@/features/llama-cpp-browser/runtime/model-store';
import { logDiagnostic } from '@/features/llama-cpp-browser/debug-log';
import { createWorkerApi } from './api';
import type { LlamaCppWorkerApi, WorkerGenerateCall } from './types';
import type { generate } from './generation';

const native = vi.hoisted(() => ({ generate: vi.fn(), release: vi.fn(), invalidate: vi.fn() }));
vi.mock('./generation', () => ({ generate: native.generate }));
vi.mock('./session', () => ({ releaseSession: native.release, invalidateStoredModel: native.invalidate }));
const completed = () => ({ content: 'ok', reasoningContent: '', toolCalls: [], finishReason: 'stop' as const });
const request = (generationId: number): WorkerGenerateCall => ({ generationId, model: 'user/model-GGUF', messages: [{ role: 'user', content: 'hello' }], temperature: 0, topP: 1, maxTokens: 1, presencePenalty: 0, frequencyPenalty: 0, stop: [], options: { profile: 'cpu-wasm32' } });
let fixture: ReturnType<typeof createModelBlobFixture>;
beforeEach(() => {
  fixture = createModelBlobFixture({ releaseProxy: Comlink.releaseProxy }); vi.clearAllMocks();
  native.generate.mockImplementation(async () => completed());
});
afterEach(() => {
  fixture.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function progressProxy() {
  const released = vi.fn();
  const progress = Object.assign(vi.fn(), { [Comlink.releaseProxy]: released });
  return { progress, released };
}

async function putModel() {
  await fixture.put({ path: 'models/user/model-GGUF/model.gguf', bytes: await fixture.bytes({ blob: ggufFile({ name: 'model.gguf', size: 128 }) }) });
}

describe('model API per-operation Blob ownership', () => {
  it('imports a real File, lists it with a new host, and releases both operation hosts', async () => {
    fixture.blockWorkerReads();
    const api = createWorkerApi(); const importing = fixture.host(); const callback = progressProxy();
    const model = await api.importModel({ generationId: 1, file: ggufFile({ name: 'model.gguf', size: 300_000 }) }, callback.progress, importing.host);
    expect(importing.read).toHaveBeenCalled(); expect(importing.released).toHaveBeenCalledOnce();
    expect(callback.progress).toHaveBeenCalled(); expect(callback.released).toHaveBeenCalledOnce();
    const listing = fixture.host();
    expect((await api.listModels(listing.host)).map(item => item.id)).toEqual([model.id]);
    expect(listing.read).toHaveBeenCalled(); expect(listing.released).toHaveBeenCalledOnce();
    expect(importing.released).toHaveBeenCalledOnce();
    expect(native.release).not.toHaveBeenCalled();
  });

  it('does not release an import host before progress acknowledgements finish', async () => {
    fixture.blockWorkerReads();
    const api = createWorkerApi(); const host = fixture.host(); const callback = progressProxy();
    const waiting = Promise.withResolvers<void>();
    callback.progress.mockReturnValue(waiting.promise);
    const importing = api.importDirectory({ directory: { name: 'model-GGUF', files: [{ path: 'model.gguf', file: ggufFile({ name: 'model.gguf', size: 128 }) }] }, generationId: 1 }, callback.progress, host.host);
    await vi.waitFor(() => expect(callback.progress).toHaveBeenCalled());
    expect(host.released).not.toHaveBeenCalled(); expect(callback.released).not.toHaveBeenCalled();
    await expect(api.release()).rejects.toThrow('busy');
    waiting.resolve(); await importing;
    expect(host.released).toHaveBeenCalledOnce(); expect(callback.released).toHaveBeenCalledOnce();
  });

  it.each(['file', 'directory'] as const)('stops %s import while waiting for bytes and releases after cleanup', async source => {
    fixture.blockWorkerReads();
    const api = createWorkerApi(); const host = fixture.host(); const callback = progressProxy();
    const late = Promise.withResolvers<Awaited<ReturnType<typeof host.read>>>();
    const waiting = Promise.withResolvers<void>(); const original = host.read.getMockImplementation()!;
    host.read.mockImplementation(args => {
      if (args.length > 8) {
        waiting.resolve(); return late.promise;
      } return original(args);
    });
    const importing = (() => {
      switch (source) {
      case 'file': return api.importModel({ file: ggufFile({ name: 'model.gguf', size: 128 }), generationId: 1 }, callback.progress, host.host);
      case 'directory': return api.importDirectory({ directory: { name: 'model-GGUF', files: [{ path: 'model.gguf', file: ggufFile({ name: 'model.gguf', size: 128 }) }] }, generationId: 1 }, callback.progress, host.host);
      default: { const _ex: never = source; throw new Error(String(_ex)); }
      }
    })();
    const rejected = expect(importing).rejects.toThrow('aborted');
    await waiting.promise;
    await api.cancelGeneration({ generationId: 2 }); expect(host.released).not.toHaveBeenCalled();
    await api.cancelGeneration({ generationId: 1 }); await rejected;
    expect(await fixture.names({ folder: await fixture.directory({ path: 'models/user' }) })).toEqual([]);
    expect(host.released).toHaveBeenCalledOnce(); expect(callback.released).toHaveBeenCalledOnce();
    late.reject(new Error('Late host failure'));
    expect(await api.listModels(fixture.host().host)).toEqual([]);
  });

  it.each(['importModel', 'importDirectory', 'generate'] as const)('releases the rejected %s host and callbacks without cancelling the active read', async method => {
    await putModel(); fixture.blockWorkerReads();
    const api = createWorkerApi(); const first = fixture.host(); const original = first.read.getMockImplementation()!;
    const wait = Promise.withResolvers<void>(); const began = Promise.withResolvers<void>();
    first.read.mockImplementation(async args => {
      began.resolve(); await wait.promise; return original(args);
    });
    const listing = api.listModels(first.host);
    await began.promise;
    const second = fixture.host(); const callback = progressProxy();
    let rejected: Promise<unknown>;
    switch (method) {
    case 'importModel': rejected = api.importModel({ generationId: 1, file: ggufFile({ name: 'other.gguf', size: 128 }) }, callback.progress, second.host); break;
    case 'importDirectory': rejected = api.importDirectory({ directory: { name: 'Other', files: [{ path: 'model.gguf', file: ggufFile({ name: 'model.gguf', size: 128 }) }] }, generationId: 2 }, callback.progress, second.host); break;
    case 'generate': rejected = api.generate(request(2), callback.progress, callback.progress, undefined, second.host); break;
    default: { const exhaustive: never = method; throw new Error(String(exhaustive)); }
    }
    await expect(rejected).rejects.toThrow('busy');
    expect(second.released).toHaveBeenCalledOnce(); expect(callback.released).toHaveBeenCalledOnce();
    expect(first.released).not.toHaveBeenCalled(); expect(second.read).not.toHaveBeenCalled();
    wait.resolve(); expect(await listing).toHaveLength(1); expect(first.released).toHaveBeenCalledOnce();
  });

  it.each(['input', 'read', 'callback'] as const)('releases import resources on %s failure and permits a later operation', async failure => {
    fixture.blockWorkerReads();
    const api = createWorkerApi(); const host = fixture.host(); const callback = progressProxy();
    if (failure === 'read') host.read.mockRejectedValue(new Error('Denied'));
    if (failure === 'callback') callback.progress.mockRejectedValue(new Error('Callback failed'));
    const file = failure === 'input' ? {} as File : ggufFile({ name: 'model.gguf', size: 128 });
    await expect(api.importModel({ file, generationId: 1 }, callback.progress, host.host)).rejects.toThrow();
    expect(host.released).toHaveBeenCalledOnce(); expect(callback.released).toHaveBeenCalledOnce();
    // A callback error can occur after publication; it is not a storage rollback.
    expect(await api.listModels(fixture.host().host)).toHaveLength(failure === 'callback' ? 1 : 0);
  });

  it('passes a fresh borrowed context into each generation without releasing resident native state', async () => {
    await putModel(); fixture.blockWorkerReads();
    const api = createWorkerApi(); const borrowed: BlobContext[] = [];
    native.generate.mockImplementation(async ({ blobs, signal, request: input }: Parameters<typeof generate>[0]) => {
      if (!blobs) throw new Error('Expected context'); borrowed.push(blobs);
      expect((await storedModelDirectory({ name: input.model, blobs, signal })).id).toBe(input.model);
      return completed();
    });
    for (const generationId of [1, 2]) {
      const host = fixture.host(); const callback = progressProxy();
      expect(await api.generate(request(generationId), callback.progress, callback.progress, undefined, host.host)).toEqual(completed());
      expect(host.released).toHaveBeenCalledOnce(); expect(host.read).toHaveBeenCalled();
      expect(callback.released).toHaveBeenCalledOnce();
      expect(() => borrowed.at(-1)!.fromNative({ blob: new Blob(['x']) })).toThrow();
    }
    expect(borrowed[0]).not.toBe(borrowed[1]); expect(native.release).not.toHaveBeenCalled();
  });

  it('cancels generation model resolution with its signal but leaves the API reusable', async () => {
    await putModel(); fixture.blockWorkerReads();
    const api = createWorkerApi(); const host = fixture.host();
    const late = Promise.withResolvers<Awaited<ReturnType<typeof host.read>>>();
    const waiting = Promise.withResolvers<void>();
    host.read.mockImplementation(() => {
      waiting.resolve(); return late.promise;
    });
    native.generate.mockImplementation(async ({ blobs, signal, request: input }: Parameters<typeof generate>[0]) => {
      await storedModelDirectory({ name: input.model, blobs, signal }); return completed();
    });
    const generating = api.generate(request(1), async () => {}, () => {}, undefined, host.host);
    const rejected = expect(generating).rejects.toThrow('aborted');
    await waiting.promise; await api.cancelGeneration({ generationId: 1 }); await rejected;
    expect(host.released).toHaveBeenCalledOnce(); late.reject(new Error('Late failure'));
    expect(await api.listModels(fixture.host().host)).toHaveLength(1);
  });

  it.each(['resolve', 'reject'] as const)('keeps diagnostic ownership until its late acknowledgement can %s', async outcome => {
    const api = createWorkerApi(); const host = fixture.host(); const diagnostic = progressProxy();
    const pending = Promise.withResolvers<void>(); diagnostic.progress.mockReturnValue(pending.promise);
    native.generate.mockImplementation(async () => {
      // Native checkpoints can be emitted without awaiting logOperation().
      logDiagnostic({ diagnostic: { event: 'operation-start', stage: 'model-resolve' } });
      return completed();
    });
    const generating = api.generate(request(1), async () => {}, () => {}, diagnostic.progress, host.host);
    await vi.waitFor(() => expect(diagnostic.progress).toHaveBeenCalledOnce());
    expect(diagnostic.released).not.toHaveBeenCalled(); expect(host.released).not.toHaveBeenCalled();
    await expect(api.release()).rejects.toThrow('busy');
    switch (outcome) {
    case 'resolve': pending.resolve(); break;
    case 'reject': pending.reject(new Error('Diagnostic receiver closed')); break;
    default: { const exhaustive: never = outcome; throw new Error(String(exhaustive)); }
    }
    expect(await generating).toEqual(completed());
    expect(diagnostic.released).toHaveBeenCalledOnce(); expect(host.released).toHaveBeenCalledOnce();
  });

  it('uses real Comlink host reads for discovery, delegated model resolution and deletion', async () => {
    await putModel(); fixture.blockWorkerReads();
    native.generate.mockImplementation(async ({ blobs, signal, request: input, onEvent, onProgress }: Parameters<typeof generate>[0]) => {
      await storedModelDirectory({ name: input.model, blobs, signal });
      onProgress({ progress: { phase: 'loading', completed: 1, total: 1 } }); await onEvent({ event: { type: 'text', text: 'ok' } });
      return completed();
    });
    const channel = new MessageChannel(); const api = createWorkerApi();
    exposeWorkerRemote<LlamaCppWorkerApi>({ api, endpoint: channel.port1 as unknown as MessagePort });
    const remote = wrapWorkerRemote<LlamaCppWorkerApi>({ endpoint: channel.port2 as unknown as MessagePort });
    const buffers: ArrayBuffer[] = []; const finalizers: ReturnType<typeof vi.fn>[] = [];
    function remoteHost() {
      const host = fixture.host(); const original = host.read.getMockImplementation()!; const finalized = vi.fn();
      host.read.mockImplementation(async args => {
        const bytes = await original(args); buffers.push(bytes.buffer); return bytes;
      });
      finalizers.push(finalized);
      Object.assign(host.host, { [Comlink.finalizer]: finalized });
      return workerProxy({ value: host.host });
    }
    try {
      const models = await remote.listModels(remoteHost()); expect(models).toHaveLength(1);
      const output: string[] = []; const chunkDone = vi.fn(); const progressDone = vi.fn();
      const chunk = Object.assign(async ({ event }: { event: GenerationEvent }) => {
        if (event.type !== 'text') throw new Error('Expected text event');
        output.push(event.text);
      }, { [Comlink.finalizer]: chunkDone });
      const progress = Object.assign(() => {}, { [Comlink.finalizer]: progressDone });
      expect(await remote.generate(request(1), workerProxy({ value: chunk }), workerProxy({ value: progress }), undefined, remoteHost())).toEqual(completed());
      expect(output).toEqual(['ok']);
      const directory = await fixture.directory({ path: 'models/user/model-GGUF' });
      const snapshot = await (await directory.getFileHandle('model.gguf')).getFile();
      expect(await remote.removeModel({ plan: { id: models[0]!.id, files: [{ path: 'model.gguf', size: snapshot.size, lastModified: snapshot.lastModified }] } }, remoteHost())).toBe('deleted');
      expect(buffers.length).toBeGreaterThan(2); expect(buffers.every(buffer => buffer.byteLength === 0)).toBe(true);
      await vi.waitFor(() => {
        for (const finalize of [...finalizers, chunkDone, progressDone]) expect(finalize).toHaveBeenCalledOnce();
      });
    } finally {
      releaseWorkerRemote({ remote }); channel.port1.close(); channel.port2.close();
    }
  });
});
