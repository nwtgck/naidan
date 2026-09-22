// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerRemote } from '@/utils/worker-transport';
import type { WorkerBlobReadHost } from '@/utils/worker-blob-context';
import { createLlamaCppWorkerSessionClient } from './client-session';
import type { LlamaCppWorkerApi } from './types';

const model = { id: 'user/model-GGUF', name: 'model-GGUF', size: 128, importedAt: 123 };
const result = { content: 'ok', reasoningContent: '', toolCalls: [], finishReason: 'stop' as const };
const clients: ReturnType<typeof createLlamaCppWorkerSessionClient>[] = [];
function setup() {
  const remote = {
    listModels: vi.fn(async () => [model]),
    importModel: vi.fn(async () => model),
    importDirectory: vi.fn(async () => model),
    removeModel: vi.fn(async () => 'deleted' as const),
    generate: vi.fn(async () => result),
    cancelGeneration: vi.fn(async () => {}),
  } as unknown as WorkerRemote<LlamaCppWorkerApi>;
  const worker = new EventTarget() as Worker;
  const disposeTransport = vi.fn();
  const client = createLlamaCppWorkerSessionClient({ worker, remote, disposeTransport, getAssetBaseURL: () => undefined });
  clients.push(client);
  return { client, remote, worker, disposeTransport };
}
function readRequest() {
  return { blob: new Blob(['abc']), offset: 1, length: 1 };
}
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose(); vi.restoreAllMocks();
});

describe('shared model client per-RPC Blob hosts', () => {
  it.each(['list', 'import', 'directory', 'remove', 'generate'] as const)('supplies a live top-level host to %s and closes it on completion', async operation => {
    const { client, remote, disposeTransport } = setup();
    const done = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<WorkerBlobReadHost>();
    const receive = async (host: WorkerBlobReadHost | undefined) => {
      if (!host) throw new Error('Missing host'); entered.resolve(host); await done.promise;
    };
    const file = new File(['payload'], 'model.gguf'); const onProgress = vi.fn();
    let pending: Promise<unknown>;
    switch (operation) {
    case 'list':
      vi.mocked(remote.listModels).mockImplementation(async host => {
        await receive(host); return [model];
      });
      pending = client.listModels({ signal: undefined }); break;
    case 'import':
      vi.mocked(remote.importModel).mockImplementation(async (_request, _progress, host) => {
        await receive(host); return model;
      });
      pending = client.importModel({ file, onProgress, signal: undefined }); break;
    case 'directory':
      vi.mocked(remote.importDirectory).mockImplementation(async (_request, _progress, host) => {
        await receive(host); return model;
      });
      pending = client.importDirectory({ directory: { name: 'model-GGUF', files: [{ path: file.name, file }] }, onProgress, signal: undefined }); break;
    case 'remove':
      vi.mocked(remote.removeModel).mockImplementation(async (_request, host) => {
        await receive(host); return 'deleted';
      });
      pending = client.removeModel({ plan: { id: model.id, files: [] }, signal: undefined }); break;
    case 'generate':
      vi.mocked(remote.generate).mockImplementation(async (_request, _chunk, _progress, _diagnostic, host) => {
        await receive(host); return result;
      });
      pending = client.generate({ request: { model: model.id, messages: [{ role: 'user', content: 'hi' }], options: { profile: 'cpu-wasm32' }, temperature: 0, topP: 1, maxTokens: 1, presencePenalty: 0, frequencyPenalty: 0, stop: [] }, onEvent: () => {}, onProgress, signal: undefined }); break;
    default: { const exhaustive: never = operation; throw new Error(String(exhaustive)); }
    }
    const host = await entered.promise;
    expect(new Uint8Array(await host.read(readRequest()))).toEqual(new Uint8Array([98]));
    done.resolve(); await pending;
    await expect(host.read(readRequest())).rejects.toMatchObject({ name: 'AbortError' });
    expect(disposeTransport).not.toHaveBeenCalled(); expect(client.canReuse()).toBe(true);
    await client.listModels({ signal: undefined });
    const next = vi.mocked(remote.listModels).mock.calls.at(-1)?.[0];
    expect(next).toBeDefined(); expect(next).not.toBe(host);
  });

  it('stops the host immediately on client disposal even when the model RPC is still pending', async () => {
    const { client, remote, disposeTransport } = setup();
    const pending = Promise.withResolvers<Awaited<ReturnType<LlamaCppWorkerApi['listModels']>>>();
    vi.mocked(remote.listModels).mockReturnValue(pending.promise);
    const operation = client.listModels({ signal: undefined });
    const rejected = expect(operation).rejects.toThrow('worker-failed');
    const host = vi.mocked(remote.listModels).mock.calls[0]![0]!;
    expect(await host.read(readRequest())).toHaveLength(1);
    client.dispose(); client.dispose(); await rejected;
    expect(disposeTransport).toHaveBeenCalledOnce();
    await expect(host.read(readRequest())).rejects.toMatchObject({ name: 'AbortError' });
    pending.resolve([model]);
    expect(client.canReuse()).toBe(false);
  });

  it('closes a failed operation host without poisoning the next independent operation', async () => {
    const { client, remote } = setup();
    vi.mocked(remote.listModels).mockRejectedValueOnce(new Error('worker-failed'));
    await expect(client.listModels({ signal: undefined })).rejects.toThrow();
    const failed = vi.mocked(remote.listModels).mock.calls[0]![0]!;
    await expect(failed.read(readRequest())).rejects.toMatchObject({ name: 'AbortError' });
    expect(await client.listModels({ signal: undefined })).toEqual([model]);
    expect(vi.mocked(remote.listModels).mock.calls[1]![0]).not.toBe(failed);
  });

  it.each(['importModel', 'importDirectory'] as const)('does not accept a late %s callback after its host lifetime has ended', async method => {
    const { client, remote } = setup(); const onProgress = vi.fn();
    const file = new File(['payload'], 'model.gguf');
    if (method === 'importModel') await client.importModel({ file, onProgress, signal: undefined });
    else await client.importDirectory({ directory: { name: 'model-GGUF', files: [{ path: file.name, file }] }, onProgress, signal: undefined });
    const callback = vi.mocked(remote[method]).mock.calls[0]![1];
    callback({ phase: 'importing', completed: 1, total: 1 });
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('keeps the host available for cooperative import cleanup, then closes it after the reply', async () => {
    const { client, remote, disposeTransport } = setup();
    const pending = Promise.withResolvers<typeof model>();
    vi.mocked(remote.importDirectory).mockReturnValue(pending.promise);
    const signal = new AbortController(); const file = new File(['data'], 'model.gguf');
    const importing = client.importDirectory({ directory: { name: 'model-GGUF', files: [{ path: file.name, file }] }, onProgress: () => {}, signal: signal.signal });
    const rejected = expect(importing).rejects.toThrow('aborted');
    const call = vi.mocked(remote.importDirectory).mock.calls[0]!; const host = call[2]!;
    signal.abort(); expect(remote.cancelGeneration).toHaveBeenCalledWith({ generationId: call[0].generationId });
    expect(await host.read(readRequest())).toHaveLength(1);
    pending.reject(new Error('llama.cpp browser: aborted')); await rejected;
    await expect(host.read(readRequest())).rejects.toMatchObject({ name: 'AbortError' });
    expect(disposeTransport).not.toHaveBeenCalled();
  });

  it('does not create or send a host for already cancelled or overlapping requests', async () => {
    const { client, remote } = setup();
    await expect(client.listModels({ signal: AbortSignal.abort() })).rejects.toThrow('aborted');
    expect(remote.listModels).not.toHaveBeenCalled();
    const pending = Promise.withResolvers<typeof model[]>(); vi.mocked(remote.listModels).mockReturnValueOnce(pending.promise);
    const listing = client.listModels({ signal: undefined });
    await expect(client.listModels({ signal: undefined })).rejects.toThrow('busy');
    expect(remote.listModels).toHaveBeenCalledOnce(); pending.resolve([]); await listing;
  });
});
