// @vitest-environment node
import { MessageChannel } from 'node:worker_threads';
import * as Comlink from 'comlink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryDirectory } from '@/features/llama-cpp-browser/hugging-face/test-opfs';
import { verifySharedStorage, verifyStorage } from '@/features/llama-cpp-browser/runtime/shared-storage-probe';
import * as io from '@/utils/blob-view-io';
import { exposeWorkerRemote, releaseWorkerRemote, workerProxy, workerTransfer, wrapWorkerRemote } from '@/utils/worker-transport';
import type { WorkerBlobReadHost } from '@/utils/worker-blob-context';
import type { LlamaCppWorkerApi } from './types';

const nativeRead = io.readNativeBlobRange;
const api = { verifyStorage };

let root: ReturnType<typeof memoryDirectory>;
let getDirectory: ReturnType<typeof vi.fn>;
const probeId = '0f2c073d-0600-4eb5-bc60-0469fa53ca1d';
const name = `.naidan-llama-shared-probe-${probeId}`;

async function writeNonce({ directory, fileName, content }: {
  directory: ReturnType<typeof memoryDirectory>, fileName: string, content: string,
}): Promise<void> {
  const file = await directory.getFileHandle(fileName, { create: true });
  const writer = await file.createWritable();
  await writer.write(content); await writer.close();
}

function createHost() {
  const release = vi.fn();
  const host = {
    read: vi.fn(async ({ blob, offset, length }: { blob: Blob, offset: number, length: number }) => {
      const bytes = await nativeRead({ blob, offset, length });
      return workerTransfer({ value: bytes, transferables: [bytes.buffer] });
    }),
    [Comlink.releaseProxy]: release,
  };
  return { host, release };
}

function breakWorkerReads() {
  vi.spyOn(Blob.prototype, 'text').mockRejectedValue(new DOMException('Worker Blob text failed', 'NotReadableError'));
  return vi.spyOn(io, 'readNativeBlobRange').mockRejectedValue(new DOMException('Opaque Worker', 'NotReadableError'));
}

beforeEach(() => {
  vi.clearAllMocks();
  root = memoryDirectory({ name: '' });
  getDirectory = vi.fn(async () => root);
  vi.stubGlobal('navigator', { storage: { getDirectory } });
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('llama storage probe through BlobView', () => {
  it('reads the Worker snapshot through the host and releases the short-lived proxy', async () => {
    await writeNonce({ directory: root, fileName: name, content: probeId });
    const read = breakWorkerReads();
    const { host, release } = createHost();
    expect(await api.verifyStorage({ probeId }, host)).toBe(true);
    expect(host.read.mock.calls.map(([request]) => [request.offset, request.length])).toEqual([[1, 3], [0, 36]]);
    expect(read).toHaveBeenCalledOnce();
    expect(getDirectory).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect([...root.children.keys()]).toEqual([name]);
  });

  it('uses direct reads when supported without calling or retaining the host', async () => {
    await writeNonce({ directory: root, fileName: name, content: probeId });
    const read = vi.spyOn(io, 'readNativeBlobRange');
    const { host, release } = createHost();
    expect(await api.verifyStorage({ probeId }, host)).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    expect(host.read).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
  });

  it('preserves a direct caller that does not supply a host', async () => {
    await writeNonce({ directory: root, fileName: name, content: probeId });
    const read = vi.spyOn(io, 'readNativeBlobRange');
    expect(await api.verifyStorage({ probeId })).toBe(true);
    expect(read).toHaveBeenCalledOnce();
  });

  it('recovers a File-specific failure even when the memory probe works', async () => {
    await writeNonce({ directory: root, fileName: name, content: probeId });
    vi.spyOn(io, 'readNativeBlobRange').mockImplementationOnce(nativeRead)
      .mockRejectedValueOnce(new DOMException('File read failed', 'NotReadableError'));
    const { host, release } = createHost();
    expect(await api.verifyStorage({ probeId }, host)).toBe(true);
    expect(host.read).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
    expect(host.read.mock.calls[0]?.[0].length).toBe(probeId.length);
  });

  it.each(['', 'x', 'x'.repeat(37)])('rejects size mismatch without reading bytes or invoking a probe: %j', async content => {
    await writeNonce({ directory: root, fileName: name, content });
    const read = breakWorkerReads();
    const { host, release } = createHost();
    expect(await api.verifyStorage({ probeId }, host)).toBe(false);
    expect(read).not.toHaveBeenCalled(); expect(host.read).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
  });

  it('rejects same-sized but incorrect contents returned from the Worker snapshot', async () => {
    await writeNonce({ directory: root, fileName: name, content: 'x'.repeat(probeId.length) });
    breakWorkerReads();
    const { host, release } = createHost();
    expect(await api.verifyStorage({ probeId }, host)).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it('rejects arbitrary paths before opening OPFS and still releases the host', async () => {
    const { host, release } = createHost();
    await expect(api.verifyStorage({ probeId: '../model.gguf' }, host)).rejects.toThrow();
    expect(getDirectory).not.toHaveBeenCalled(); expect(host.read).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
  });

  it.each(['root', 'file', 'snapshot'] as const)('propagates %s access failure rather than treating the host directory as shared', async stage => {
    const error = new DOMException('Worker storage denied', 'NotAllowedError');
    const file = await root.getFileHandle(name, { create: true });
    switch (stage) {
    case 'root': getDirectory.mockRejectedValue(error); break;
    case 'file': vi.spyOn(root, 'getFileHandle').mockRejectedValue(error); break;
    case 'snapshot': vi.spyOn(file, 'getFile').mockRejectedValue(error); break;
    default: { const _ex: never = stage; throw new Error(String(_ex)); }
    }
    const { host, release } = createHost();
    await expect(api.verifyStorage({ probeId }, host)).rejects.toBe(error);
    expect(host.read).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
  });

  it('fails closed if both byte-reading paths fail and can verify again with a new host', async () => {
    await writeNonce({ directory: root, fileName: name, content: probeId });
    breakWorkerReads();
    const first = createHost();
    first.host.read.mockRejectedValue(new Error('Host unavailable'));
    await expect(api.verifyStorage({ probeId }, first.host)).rejects.toBeInstanceOf(AggregateError);
    expect(first.release).toHaveBeenCalledOnce();
    const second = createHost();
    expect(await api.verifyStorage({ probeId }, second.host)).toBe(true);
    expect(second.release).toHaveBeenCalledOnce();
  });

  it('cleans up the caller-owned nonce and preserves model directories on failure', async () => {
    const directory = await root.getDirectoryHandle('models', { create: true });
    breakWorkerReads();
    const { host, release } = createHost();
    host.read.mockRejectedValue(new Error('Host unavailable'));
    await expect(verifySharedStorage({ verify: request => api.verifyStorage(request, host), signal: undefined })).rejects.toThrow('unavailable');
    expect([...root.children.keys()]).toEqual(['models']); expect(root.children.get('models')).toBe(directory);
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(['shared', 'isolated'] as const)('uses real Comlink for a %s storage key without reopening the path in the host', async mode => {
    const other = memoryDirectory({ name: 'different-origin' });
    getDirectory.mockResolvedValueOnce(root).mockResolvedValueOnce(mode === 'shared' ? root : other);
    breakWorkerReads();
    const finalized = vi.fn(); const sent: ArrayBuffer[] = [];
    const host: WorkerBlobReadHost = {
      async read({ blob, offset, length }) {
        const bytes = await nativeRead({ blob, offset, length });
        sent.push(bytes.buffer);
        return workerTransfer({ value: bytes, transferables: [bytes.buffer] });
      },
    };
    Object.assign(host, { [Comlink.finalizer]: finalized });
    const channel = new MessageChannel();
    exposeWorkerRemote<Pick<LlamaCppWorkerApi, 'verifyStorage'>>({ api, endpoint: channel.port1 as unknown as MessagePort });
    const remote = wrapWorkerRemote<Pick<LlamaCppWorkerApi, 'verifyStorage'>>({ endpoint: channel.port2 as unknown as MessagePort });
    try {
      const operation = verifySharedStorage({
        verify: request => remote.verifyStorage(request, workerProxy({ value: host })), signal: undefined,
      });
      switch (mode) {
      case 'shared':
        await operation;
        expect(sent).toHaveLength(2); expect(sent.every(buffer => buffer.byteLength === 0)).toBe(true);
        break;
      case 'isolated':
        await expect(operation).rejects.toThrow('unavailable'); expect(sent).toHaveLength(0);
        break;
      default: { const _ex: never = mode; throw new Error(String(_ex)); }
      }
      expect(getDirectory).toHaveBeenCalledTimes(2);
      expect(root.children.size).toBe(0); expect(other.children.size).toBe(0);
      await vi.waitFor(() => expect(finalized).toHaveBeenCalledOnce());
    } finally {
      releaseWorkerRemote({ remote }); channel.port1.close(); channel.port2.close();
    }
  });
});
