// @vitest-environment node
import { MessageChannel } from 'node:worker_threads';
import * as Comlink from 'comlink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { blobForTransport, createBlobContext, type BlobContext } from './blob-view';
import * as io from './blob-view-io';
import { createWorkerBlobContext, createWorkerBlobReadHost, TEST_ONLY, type WorkerBlobReadHost } from './worker-blob-context';
import { exposeWorkerRemote, releaseWorkerRemote, workerProxy, workerTransfer, wrapWorkerRemote, type WorkerProxy, type WorkerServerApi } from './worker-transport';

const nativeRead = io.readNativeBlobRange;
const contexts: BlobContext[] = [];

function createFixture() {
  const host = { read: vi.fn(async ({ blob, offset, length }: { blob: Blob, offset: number, length: number }) => {
    const bytes = await nativeRead({ blob, offset, length });
    return workerTransfer({ value: bytes, transferables: [bytes.buffer] });
  }) };
  const context = createWorkerBlobContext({ host });
  contexts.push(context);
  return { context, host };
}

afterEach(() => {
  for (const context of contexts.splice(0)) context.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Worker BlobView feature detection', () => {
  it('shares the controlled probe and reads directly without host RPC when supported', async () => {
    const direct = vi.spyOn(io, 'readNativeBlobRange');
    const nativeText = vi.spyOn(Blob.prototype, 'text');
    const { context, host } = createFixture();
    const view = context.fromNative({ blob: new Blob(['hello']) });
    const first = view.text();
    const second = view.text();
    expect(await first).toBe('hello');
    expect(await second).toBe('hello');
    expect(direct).toHaveBeenCalledOnce();
    expect(nativeText).toHaveBeenCalledTimes(2);
    expect(host.read).not.toHaveBeenCalled();
  });

  it('validates the actual reverse path and uses bounded host reads for binary data', async () => {
    const direct = vi.spyOn(io, 'readNativeBlobRange').mockRejectedValue(new DOMException('Opaque Worker', 'NotReadableError'));
    const { context, host } = createFixture();
    const bytes = new Uint8Array(io.BLOB_VIEW_CHUNK_SIZE + 5).map((_, index) => index % 251);
    const view = context.fromNative({ blob: new Blob([bytes]) });
    const result = await view.bytes();
    expect(result.byteLength).toBe(bytes.byteLength);
    expect(result.every((byte, index) => byte === bytes[index])).toBe(true);
    expect(direct).toHaveBeenCalledOnce();
    expect(host.read.mock.calls.map(([request]) => [request.offset, request.length])).toEqual([[1, 3], [0, io.BLOB_VIEW_CHUNK_SIZE], [io.BLOB_VIEW_CHUNK_SIZE, 5]]);
    expect(await view.slice({ start: -2 }).bytes()).toEqual(bytes.slice(-2));
    expect(direct).toHaveBeenCalledOnce();
  });

  it('caches file-specific recovery for nested and sibling slices, not unrelated files', async () => {
    vi.spyOn(Blob.prototype, 'text').mockRejectedValueOnce(new DOMException('Unreadable File', 'NotReadableError'));
    const direct = vi.spyOn(io, 'readNativeBlobRange')
      .mockImplementationOnce(nativeRead)
      .mockRejectedValueOnce(new DOMException('Unreadable File', 'NotReadableError'));
    const { context, host } = createFixture();
    const file = context.fromNative({ blob: new Blob(['file contents']) });
    expect(await file.slice({ start: 0, end: 4 }).text()).toBe('file');
    expect(await file.slice({ start: 5 }).slice({ end: 3 }).text()).toBe('con');
    expect(await context.fromNative({ blob: new Blob(['other']) }).text()).toBe('other');
    expect(direct).toHaveBeenCalledTimes(2);
    expect(host.read).toHaveBeenCalledTimes(2);
  });

  it.each(['NotAllowedError', 'SecurityError', 'AbortError'])('does not retry a real %s after a successful probe', async name => {
    const reason = new DOMException('File access failed', name);
    vi.spyOn(Blob.prototype, 'text').mockRejectedValueOnce(reason);
    const { context, host } = createFixture();
    await expect(context.fromNative({ blob: new Blob(['abc']) }).text()).rejects.toBe(reason);
    expect(host.read).not.toHaveBeenCalled();
  });

  it('requires correct probe content, not just method presence or a fulfilled promise', async () => {
    vi.spyOn(io, 'readNativeBlobRange').mockResolvedValue(new Uint8Array(3));
    const { context, host } = createFixture();
    expect(await context.fromNative({ blob: new Blob(['abc']) }).text()).toBe('abc');
    expect(host.read).toHaveBeenCalledTimes(2);
  });

  it('reports both path errors, and retries transient detection on a later operation', async () => {
    vi.spyOn(io, 'readNativeBlobRange').mockRejectedValue(new DOMException('Opaque', 'NotReadableError'));
    const { context, host } = createFixture();
    const hostError = new Error('Host unavailable');
    host.read.mockRejectedValueOnce(hostError);
    const view = context.fromNative({ blob: new Blob(['abc']) });
    await expect(view.text()).rejects.toMatchObject({ errors: [expect.objectContaining({ name: 'NotReadableError' }), hostError] });
    expect(await view.text()).toBe('abc');
  });

  it('bounds a stalled probe, but does not apply the short timeout to real file reads', async () => {
    vi.useFakeTimers();
    vi.spyOn(io, 'readNativeBlobRange').mockReturnValue(new Promise(() => {}));
    const { context, host } = createFixture();
    const reading = context.fromNative({ blob: new Blob(['abc']) }).text();
    await vi.advanceTimersByTimeAsync(TEST_ONLY.PROBE_TIMEOUT_MS);
    expect(await reading).toBe('abc');
    expect(host.read).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start the real read after cancellation while a shared probe is pending', async () => {
    const pending = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
    const direct = vi.spyOn(io, 'readNativeBlobRange').mockReturnValueOnce(pending.promise);
    const { context, host } = createFixture();
    const abort = new AbortController();
    const view = context.fromNative({ blob: new Blob(['abc']) });
    const reading = view.text({ signal: abort.signal });
    const rejected = expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(direct).toHaveBeenCalledOnce());
    abort.abort();
    await rejected;
    pending.resolve(new Uint8Array([78, 0, 255]));
    await Promise.resolve(); await Promise.resolve();
    expect(direct).toHaveBeenCalledOnce();
    expect(host.read).not.toHaveBeenCalled();
    expect(await view.text()).toBe('abc');
  });

  it('releases its host once and does not begin fallback after disposal', async () => {
    const pending = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
    const direct = vi.spyOn(io, 'readNativeBlobRange').mockReturnValue(pending.promise);
    const { context, host } = createFixture();
    const release = vi.fn();
    Object.assign(host, { [Comlink.releaseProxy]: release });
    const reading = context.fromNative({ blob: new Blob(['abc']) }).text();
    const rejected = expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(direct).toHaveBeenCalledOnce());
    context.dispose(); context.dispose();
    await rejected;
    pending.reject(new DOMException('Late read failure', 'NotReadableError'));
    await Promise.resolve();
    expect(release).toHaveBeenCalledOnce();
    expect(host.read).not.toHaveBeenCalled();
  });

  it('rejects malformed host payloads instead of treating them as complete bytes', async () => {
    vi.spyOn(io, 'readNativeBlobRange').mockRejectedValue(new DOMException('Opaque', 'NotReadableError'));
    const { context, host } = createFixture();
    host.read.mockImplementationOnce(async request => {
      const bytes = await nativeRead(request);
      return workerTransfer({ value: bytes, transferables: [bytes.buffer] });
    }).mockResolvedValueOnce(workerTransfer({ value: new Uint8Array(1), transferables: [] }));
    await expect(context.fromNative({ blob: new Blob(['abc']) }).bytes()).rejects.toThrow('exclusively owned');
  });
});

describe('host Blob read boundary', () => {
  it('reads only the requested range and validates the native Blob and bounded range', async () => {
    const owner = new AbortController();
    const host = createWorkerBlobReadHost({ signal: owner.signal });
    const blob = new Blob(['abcdef']);
    expect(await host.read({ blob, offset: 1, length: 3 })).toEqual(new Uint8Array([98, 99, 100]));
    await expect(host.read({ blob, offset: -1, length: 1 })).rejects.toThrow();
    await expect(host.read({ blob, offset: 0, length: io.BLOB_VIEW_CHUNK_SIZE + 1 })).rejects.toThrow();
    await expect(host.read({ blob, offset: 5, length: 2 })).rejects.toThrow();
    const fake = { [Symbol.toStringTag]: 'Blob', size: 1 } as unknown as Blob;
    await expect(host.read({ blob: fake, offset: 0, length: 1 })).rejects.toThrow();
    owner.abort();
    await expect(host.read({ blob, offset: 0, length: 1 })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it.each(['resolve', 'reject'] as const)('aborts logical waits without parallelizing pending physical IO with late %s', async outcome => {
    const pending = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
    const physical = vi.spyOn(io, 'readNativeBlobRange').mockReturnValue(pending.promise);
    const owner = new AbortController();
    const host = createWorkerBlobReadHost({ signal: owner.signal });
    const request = { blob: new Blob(['abc']), offset: 0, length: 3 };
    const first = host.read(request);
    const second = host.read(request);
    const reason = new Error('Owner disposed');
    const checkFirst = expect(first).rejects.toBe(reason);
    const checkSecond = expect(second).rejects.toBe(reason);
    await vi.waitFor(() => expect(physical).toHaveBeenCalledOnce());
    owner.abort(reason);
    await checkFirst; await checkSecond;
    if (outcome === 'resolve') pending.resolve(new Uint8Array(3));
    else pending.reject(new Error('Late physical error'));
    await Promise.resolve(); await Promise.resolve();
    expect(physical).toHaveBeenCalledOnce();
  });
});

describe('real Comlink clone, proxy and transfer', () => {
  it('transmits native slices, returns transferred bytes, and releases the shared reverse proxy', async () => {
    interface ProbeApi {
      prepare(host: WorkerProxy<WorkerBlobReadHost>): Promise<void>,
      text({ blob }: { blob: Blob }): Promise<string>,
      exportSlice({ blob }: { blob: Blob }): Promise<Blob>,
      dispose(): Promise<void>,
    }
    let context: BlobContext | undefined;
    const api: WorkerServerApi<ProbeApi> = {
      async prepare(host) {
        context = createWorkerBlobContext({ host });
      },
      async text({ blob }) {
        return context!.fromNative({ blob }).text();
      },
      async exportSlice({ blob }) {
        return blobForTransport({ blob: context!.fromNative({ blob }).slice({ start: 1, end: -1 }) });
      },
      async dispose() {
        context?.dispose();
      },
    };
    const channel = new MessageChannel();
    exposeWorkerRemote<ProbeApi>({ api, endpoint: channel.port1 as unknown as MessagePort });
    const remote = wrapWorkerRemote<ProbeApi>({ endpoint: channel.port2 as unknown as MessagePort });
    const sent: ArrayBuffer[] = [];
    const finalized = vi.fn();
    const host = {
      async read({ blob, offset, length }: { blob: Blob, offset: number, length: number }) {
        const bytes = await nativeRead({ blob, offset, length });
        sent.push(bytes.buffer);
        return workerTransfer({ value: bytes, transferables: [bytes.buffer] });
      },
      [Comlink.finalizer]: finalized,
    };
    vi.spyOn(io, 'readNativeBlobRange').mockRejectedValue(new DOMException('Opaque Worker simulated', 'NotReadableError'));
    try {
      await remote.prepare(workerProxy({ value: host }));
      const blob = new Blob(['<日本😀>']);
      expect(await remote.text({ blob })).toBe('<日本😀>');
      expect(sent).toHaveLength(2);
      expect(sent.every(buffer => buffer.byteLength === 0)).toBe(true);
      const returned = await remote.exportSlice({ blob });
      expect(returned).toBeInstanceOf(Blob);
      expect(await returned.text()).toBe('日本😀');
      expect(sent).toHaveLength(2); // export never consumes bytes
      const receivingContext = createBlobContext({ reader: { read: nativeRead }, release: undefined });
      try {
        expect(await receivingContext.fromNative({ blob: returned }).text()).toBe('日本😀');
      } finally {
        receivingContext.dispose();
      }
      await remote.dispose();
      await vi.waitFor(() => expect(finalized).toHaveBeenCalledOnce());
    } finally {
      context?.dispose();
      releaseWorkerRemote({ remote });
      channel.port1.close(); channel.port2.close();
    }
  });
});
