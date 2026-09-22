// @vitest-environment node
import { MessageChannel } from 'node:worker_threads';
import * as Comlink from 'comlink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as images from './blob-image';
import { createImageElementPlatform } from './blob-image-element.test-helpers';
import { createWorkerBlobImageDecoder, createWorkerBlobImageHost, TEST_ONLY, type WorkerBlobImageHost } from './worker-blob-image';
import { exposeWorkerRemote, releaseWorkerRemote, workerProxy, workerTransfer, wrapWorkerRemote, type WorkerProxy, type WorkerServerApi, type WorkerTransfer } from './worker-transport';

const limits = { maxBytes: 1024, maxPixels: 16 };
const nativeDecode = images.decodeNativeBlobImage;
const image = () => new Blob(['encoded image'], { type: 'image/png' });
const expected = () => ({ width: 2, height: 1, rgba: new Uint8Array([10, 20, 30, 255, 90, 80, 70, 0]) });
const cleanup: Array<() => void> = [];

function fixture({ completion }: { completion: 'decode' | 'events' }) {
  const platform = createImageElementPlatform({ completion });
  const lifetime = new AbortController();
  const host = createWorkerBlobImageHost({ limits, signal: lifetime.signal });
  const release = vi.fn(); Object.assign(host, { [Comlink.releaseProxy]: release });
  const calls = vi.spyOn(images, 'decodeNativeBlobImage').mockImplementation(request => {
    // Model the Worker lacking DOM; the host exercises the real native adapter
    // with a controlled image element/canvas, not a mocked pixel response.
    if (request.signal !== lifetime.signal) return Promise.reject(new DOMException('Opaque Worker decoder', 'NotSupportedError'));
    return nativeDecode(request);
  });
  const decoder = createWorkerBlobImageDecoder({ host, limits });
  cleanup.push(() => {
    decoder.dispose(); lifetime.abort(); platform.dispose();
  });
  return { platform, lifetime, host, decoder, release, calls };
}

afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('Worker image host with image-element fallback', () => {
  it.each(['decode', 'events'] as const)('runs the control probe and real input through host %s, revoking every URL before returning', async completion => {
    const env = fixture({ completion });
    const blob = image();
    expect(await env.decoder.decode({ blob, signal: undefined })).toEqual(expected());
    expect(env.platform.created.map(({ blob }) => blob.size)).toEqual([70, blob.size]);
    expect(env.platform.live.size).toBe(0);
    expect(env.platform.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(await env.decoder.decode({ blob, signal: undefined })).toEqual(expected());
    expect(env.platform.created.map(({ blob }) => blob.size)).toEqual([70, blob.size, blob.size]);
    expect(env.calls).toHaveBeenCalledTimes(4); // one Worker failure, three host calls
    env.decoder.dispose(); expect(env.release).toHaveBeenCalledOnce();
  });

  it('rejects a successful DOM load with incorrect control pixels, then allows a new probe', async () => {
    const env = fixture({ completion: 'decode' });
    const getPixels = env.platform.getImageData.getMockImplementation()!;
    env.platform.getImageData.mockImplementationOnce(() => ({ data: new Uint8ClampedArray(4) }));
    await expect(env.decoder.decode({ blob: image(), signal: undefined })).rejects.toThrow('both Worker and host');
    expect(env.platform.created).toHaveLength(1);
    expect(env.platform.live.size).toBe(0);
    env.platform.getImageData.mockImplementation(getPixels);
    expect(await env.decoder.decode({ blob: image(), signal: undefined })).toEqual(expected());
    expect(env.platform.created.map(({ blob }) => blob.size)).toEqual([70, 70, image().size]);
    expect(env.platform.live.size).toBe(0);
  });

  it('propagates a failed actual image without leaking its URL or poisoning the host', async () => {
    const env = fixture({ completion: 'decode' });
    env.platform.decoded.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new DOMException('Broken image', 'EncodingError'));
    await expect(env.decoder.decode({ blob: image(), signal: undefined })).rejects.toMatchObject({ name: 'EncodingError' });
    expect(env.platform.live.size).toBe(0);
    expect(await env.decoder.decode({ blob: image(), signal: undefined })).toEqual(expected());
    expect(env.platform.created).toHaveLength(3); // reuse host capability, not failed pixels
  });

  it('cancels a caller without revoking a URL that a still-owned host is reading', async () => {
    const env = fixture({ completion: 'decode' });
    await env.decoder.decode({ blob: image(), signal: undefined });
    const pending = Promise.withResolvers<void>();
    env.platform.decoded.mockReturnValueOnce(pending.promise);
    const controller = new AbortController();
    const request = env.decoder.decode({ blob: image(), signal: controller.signal });
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(env.platform.created).toHaveLength(3));
    controller.abort(); await rejected;
    // Per-request signal is deliberately not sent over RPC. Host keeps ownership
    // until its native operation completes (or its own lifetime is aborted).
    expect(env.platform.live.size).toBe(1);
    expect(env.release).not.toHaveBeenCalled();
    const next = env.decoder.decode({ blob: image(), signal: undefined });
    await Promise.resolve(); expect(env.platform.created).toHaveLength(3);
    pending.resolve();
    expect(await next).toEqual(expected());
    expect(env.platform.live.size).toBe(0); expect(env.platform.created).toHaveLength(4);
  });

  it('ends active and queued DOM operations when the host owner is aborted', async () => {
    const env = fixture({ completion: 'events' });
    env.platform.sourceAssigned.mockImplementation(() => {});
    const first = env.host.decode({ blob: image() });
    const second = env.host.decode({ blob: image() });
    const failures = Promise.all([expect(first).rejects.toMatchObject({ name: 'AbortError' }), expect(second).rejects.toMatchObject({ name: 'AbortError' })]);
    await vi.waitFor(() => expect(env.platform.elements).toHaveLength(1));
    env.lifetime.abort(); await failures;
    await vi.waitFor(() => expect(env.platform.live.size).toBe(0));
    expect(env.platform.createObjectURL).toHaveBeenCalledOnce();
    expect(env.platform.elements[0]!.removeEventListener).toHaveBeenCalledTimes(2);
    env.platform.elements[0]!.dispatchEvent(new Event('load'));
    expect(env.platform.drawImage).not.toHaveBeenCalled();
    await expect(env.host.decode({ blob: image() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(env.platform.createObjectURL).toHaveBeenCalledOnce();
  });

  it('times out a stalled host probe without claiming that the remote URL was already cleaned up', async () => {
    vi.useFakeTimers();
    const env = fixture({ completion: 'decode' });
    const pending = Promise.withResolvers<void>(); env.platform.decoded.mockReturnValue(pending.promise);
    const request = env.decoder.decode({ blob: image(), signal: undefined });
    const rejected = expect(request).rejects.toThrow('both Worker and host');
    await vi.advanceTimersByTimeAsync(0);
    expect(env.platform.live.size).toBe(1);
    await vi.advanceTimersByTimeAsync(TEST_ONLY.PROBE_TIMEOUT_MS);
    await rejected;
    expect(env.platform.live.size).toBe(1); // a logical deadline is not a remote abort
    env.lifetime.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(env.platform.live.size).toBe(0);
    pending.reject(new Error('Late decoder failure')); await vi.advanceTimersByTimeAsync(0);
    expect(env.platform.drawImage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('transfers actual adapter RGBA, not ImageBitmap or a DOM object, through real Comlink', async () => {
    const env = fixture({ completion: 'decode' });
    let decoder: images.BlobImageDecoder | undefined;
    interface TestWorker {
      start(host: WorkerProxy<WorkerBlobImageHost>): Promise<void>,
      read({ blob }: { blob: Blob }): Promise<WorkerTransfer<images.BlobImagePixels>>,
      dispose(): Promise<void>,
    }
    const api: WorkerServerApi<TestWorker> = {
      async start(host) {
        decoder = createWorkerBlobImageDecoder({ host, limits });
      },
      async read({ blob }) {
        const value = await decoder!.decode({ blob, signal: undefined });
        return workerTransfer({ value, transferables: [value.rgba.buffer] });
      },
      async dispose() {
        decoder?.dispose();
      },
    };
    const channel = new MessageChannel();
    exposeWorkerRemote<TestWorker>({ api, endpoint: channel.port1 as unknown as MessagePort });
    const remote = wrapWorkerRemote<TestWorker>({ endpoint: channel.port2 as unknown as MessagePort });
    const finalized = vi.fn(); Object.assign(env.host, { [Comlink.finalizer]: finalized });
    const buffers: ArrayBuffer[] = [];
    const original = env.host.decode;
    vi.spyOn(env.host, 'decode').mockImplementation(async request => {
      const result = await original(request); buffers.push(result.rgba.buffer); return result;
    });
    try {
      await remote.start(workerProxy({ value: env.host }));
      expect(await remote.read({ blob: image() })).toEqual(expected());
      expect(buffers).toHaveLength(2); expect(buffers.every(buffer => buffer.byteLength === 0)).toBe(true);
      expect(env.platform.created.every(({ blob }) => blob instanceof Blob)).toBe(true);
      expect(env.platform.live.size).toBe(0);
      expect(env.platform.revokeObjectURL).toHaveBeenCalledTimes(2);
      await remote.dispose(); await vi.waitFor(() => expect(finalized).toHaveBeenCalledOnce());
    } finally {
      decoder?.dispose(); releaseWorkerRemote({ remote }); channel.port1.close(); channel.port2.close();
    }
  });
});
