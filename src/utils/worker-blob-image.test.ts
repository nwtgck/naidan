// @vitest-environment node
import { MessageChannel } from 'node:worker_threads';
import { inflateSync } from 'node:zlib';
import * as Comlink from 'comlink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as native from './blob-image';
import { createNativeBlobContext } from './blob-view';
import { createWorkerBlobImageDecoder, createWorkerBlobImageHost, TEST_ONLY, type WorkerBlobImageHost } from './worker-blob-image';
import { exposeWorkerRemote, releaseWorkerRemote, workerProxy, workerTransfer, wrapWorkerRemote, type WorkerProxy, type WorkerServerApi } from './worker-transport';

const limits = { maxBytes: 1024, maxPixels: 16 };
const pixels = () => ({ width: 1, height: 1, rgba: new Uint8Array([255, 0, 0, 255]) });
const image = () => new Blob(['encoded image'], { type: 'image/png' });
const owners: native.BlobImageDecoder[] = [];
function fixture() {
  const release = vi.fn();
  const host = {
    decode: vi.fn(async (_request: { blob: Blob }) => {
      const value = pixels();
      return workerTransfer({ value, transferables: [value.rgba.buffer] });
    }),
    [Comlink.releaseProxy]: release,
  };
  const decoder = createWorkerBlobImageDecoder({ host, limits });
  owners.push(decoder);
  return { host, decoder, release };
}
const decode = ({ decoder, blob }: { decoder: native.BlobImageDecoder, blob: Blob }) => decoder.decode({ blob, signal: undefined });
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.restoreAllMocks(); vi.useRealTimers();
});

describe('Worker image operation capability', () => {
  it('uses a complete PNG with a known nonzero pixel, not a fake image or byte-read probe', () => {
    const bytes = Buffer.from(TEST_ONLY.PROBE_PNG, 'base64');
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(bytes.readUInt32BE(16)).toBe(1); expect(bytes.readUInt32BE(20)).toBe(1);
    const data: Buffer[] = [];
    for (let offset = 8; offset < bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT') data.push(bytes.subarray(offset + 8, offset + 8 + length));
      offset += length + 12;
    }
    expect([...inflateSync(Buffer.concat(data))]).toEqual([0, 255, 0, 0, 255]);
  });

  it('shares one pixel probe and does not call the host when the Worker can decode', async () => {
    const direct = vi.spyOn(native, 'decodeNativeBlobImage').mockImplementation(async () => pixels());
    const { host, decoder } = fixture();
    expect(await Promise.all([decode({ decoder, blob: image() }), decode({ decoder, blob: image() })])).toEqual([pixels(), pixels()]);
    expect(direct).toHaveBeenCalledTimes(3);
    expect(host.decode).not.toHaveBeenCalled();
  });

  it('validates the actual reverse pixel path and caches it separately from byte-reader capability', async () => {
    const direct = vi.spyOn(native, 'decodeNativeBlobImage').mockRejectedValue(new DOMException('Opaque worker', 'InvalidStateError'));
    const { host, decoder } = fixture();
    const blobs = createNativeBlobContext();
    try {
      // The byte reader remains entirely unused even though the image decoder fails.
      const view = blobs.fromNative({ blob: image() });
      expect(await decoder.decode({ blob: view, signal: undefined })).toEqual(pixels());
      expect(await decoder.decode({ blob: view, signal: undefined })).toEqual(pixels());
      expect(direct).toHaveBeenCalledOnce();
      expect(host.decode.mock.calls.map(([request]) => request.blob.size)).toEqual([70, view.size, view.size]);
    } finally {
      blobs.dispose();
    }
  });

  it('requires correct pixels, not merely the existence or successful resolution of an API', async () => {
    vi.spyOn(native, 'decodeNativeBlobImage').mockResolvedValue({ width: 1, height: 1, rgba: new Uint8Array(4) });
    const { host, decoder } = fixture();
    expect(await decode({ decoder, blob: image() })).toEqual(pixels());
    expect(host.decode).toHaveBeenCalledTimes(2);
  });

  it.each(['NotReadableError', 'InvalidStateError', 'EncodingError', 'NotSupportedError'])('recovers a File/format-specific %s without marking all images unsupported', async name => {
    const error = new DOMException('Specific image failed', name);
    const direct = vi.spyOn(native, 'decodeNativeBlobImage').mockImplementation(async () => pixels()).mockResolvedValueOnce(pixels()).mockRejectedValueOnce(error);
    const { host, decoder } = fixture();
    const special = image();
    expect(await decode({ decoder, blob: special })).toEqual(pixels());
    expect(await decode({ decoder, blob: special })).toEqual(pixels());
    expect(await decode({ decoder, blob: image() })).toEqual(pixels());
    expect(direct).toHaveBeenCalledTimes(3);
    expect(host.decode).toHaveBeenCalledTimes(2);
    expect(host.decode.mock.calls.every(([request]) => request.blob === special)).toBe(true);
  });

  it.each(['SecurityError', 'NotAllowedError', 'AbortError', 'RangeError'])('does not retry a %s on a real image after the controlled probe succeeds', async name => {
    const error = name === 'RangeError' ? new RangeError('Pixel limit') : new DOMException('Denied', name);
    vi.spyOn(native, 'decodeNativeBlobImage').mockResolvedValueOnce(pixels()).mockRejectedValueOnce(error);
    const { host, decoder } = fixture();
    await expect(decode({ decoder, blob: image() })).rejects.toBe(error);
    expect(host.decode).not.toHaveBeenCalled();
  });

  it('does not cache a failed two-path probe and can recover in a later operation', async () => {
    const directError = new DOMException('Opaque', 'InvalidStateError');
    vi.spyOn(native, 'decodeNativeBlobImage').mockRejectedValue(directError);
    const { host, decoder } = fixture();
    const hostError = new Error('Host unavailable'); host.decode.mockRejectedValueOnce(hostError);
    await expect(decode({ decoder, blob: image() })).rejects.toMatchObject({ errors: [directError, hostError] });
    expect(await decode({ decoder, blob: image() })).toEqual(pixels());
    expect(host.decode).toHaveBeenCalledTimes(3);
  });

  it('does not cache a failed individual image retry as successful host recovery', async () => {
    const error = new DOMException('File unavailable', 'NotReadableError');
    const direct = vi.spyOn(native, 'decodeNativeBlobImage').mockResolvedValueOnce(pixels()).mockRejectedValue(error);
    const { host, decoder } = fixture();
    host.decode.mockRejectedValue(new Error('Corrupted image'));
    const file = image();
    for (let index = 0; index < 2; index++) await expect(decode({ decoder, blob: file })).rejects.toThrow('both Worker and host');
    expect(direct).toHaveBeenCalledTimes(3); expect(host.decode).toHaveBeenCalledTimes(2);
  });

  it('rejects empty, non-image, and oversized requests before probing or communicating', async () => {
    const direct = vi.spyOn(native, 'decodeNativeBlobImage');
    const { host, decoder } = fixture();
    for (const blob of [new Blob([], { type: 'image/png' }), new Blob(['hi'], { type: 'text/plain' }), new Blob([new Uint8Array(1025)], { type: 'image/png' })]) {
      await expect(decode({ decoder, blob })).rejects.toThrow();
    }
    expect(direct).not.toHaveBeenCalled(); expect(host.decode).not.toHaveBeenCalled();
  });

  it('does not read a control PNG larger than the configured input limit', async () => {
    const direct = vi.spyOn(native, 'decodeNativeBlobImage').mockRejectedValue(new DOMException('Opaque', 'InvalidStateError'));
    const { host } = fixture();
    const decoder = createWorkerBlobImageDecoder({ host, limits: { ...limits, maxBytes: 50 } }); owners.push(decoder);
    expect(await decode({ decoder, blob: image() })).toEqual(pixels());
    expect(direct).toHaveBeenCalledOnce(); expect(host.decode).toHaveBeenCalledOnce();
    expect(host.decode.mock.calls[0]?.[0].blob.size).toBe(image().size);
  });

  it('retains native-only behavior when no reverse host was supplied', async () => {
    const direct = vi.spyOn(native, 'decodeNativeBlobImage').mockResolvedValue(pixels());
    const decoder = createWorkerBlobImageDecoder({ host: undefined, limits }); owners.push(decoder);
    expect(await decode({ decoder, blob: image() })).toEqual(pixels());
    expect(direct).toHaveBeenCalledOnce();
  });

  it('checks actual response dimensions, ownership and byte count, not just the probe', async () => {
    vi.spyOn(native, 'decodeNativeBlobImage').mockRejectedValue(new DOMException('Opaque', 'InvalidStateError'));
    const { host, decoder } = fixture();
    const bad = { width: 2, height: 1, rgba: new Uint8Array(4) };
    host.decode.mockResolvedValueOnce(workerTransfer({ value: pixels(), transferables: [] })).mockResolvedValueOnce(workerTransfer({ value: bad, transferables: [] }));
    await expect(decode({ decoder, blob: image() })).rejects.toThrow('exact');
  });

  it('cancels only one waiting image, shares a pending probe and starts no image after its cancellation', async () => {
    const pending = Promise.withResolvers<native.BlobImagePixels>();
    const direct = vi.spyOn(native, 'decodeNativeBlobImage').mockResolvedValue(pixels()).mockReturnValueOnce(pending.promise);
    const { decoder, host } = fixture();
    const signal = new AbortController();
    const first = decoder.decode({ blob: image(), signal: signal.signal });
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(direct).toHaveBeenCalledOnce());
    const second = decode({ decoder, blob: image() });
    signal.abort(); await rejected; pending.resolve(pixels());
    expect(await second).toEqual(pixels());
    expect(direct).toHaveBeenCalledTimes(2); expect(host.decode).not.toHaveBeenCalled();
  });

  it('bounds probe waiting and aborts its native decoder without imposing a timeout on real images', async () => {
    vi.useFakeTimers();
    const direct = vi.spyOn(native, 'decodeNativeBlobImage').mockReturnValue(new Promise(() => {}));
    const { host, decoder } = fixture();
    const first = decode({ decoder, blob: image() });
    await vi.advanceTimersByTimeAsync(TEST_ONLY.PROBE_TIMEOUT_MS);
    expect(await first).toEqual(pixels());
    expect(direct.mock.calls[0]?.[0].signal.aborted).toBe(true);
    const pending = Promise.withResolvers<Awaited<ReturnType<WorkerBlobImageHost['decode']>>>();
    host.decode.mockReturnValueOnce(pending.promise);
    let completed = false;
    const slow = decode({ decoder, blob: image() }).then(value => {
      completed = true; return value;
    });
    await vi.advanceTimersByTimeAsync(TEST_ONLY.PROBE_TIMEOUT_MS * 2);
    expect(completed).toBe(false);
    const value = pixels(); pending.resolve(workerTransfer({ value, transferables: [value.rgba.buffer] }));
    expect(await slow).toEqual(pixels());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start a host probe after disposal while the native probe is pending', async () => {
    const pending = Promise.withResolvers<native.BlobImagePixels>();
    const direct = vi.spyOn(native, 'decodeNativeBlobImage').mockReturnValue(pending.promise);
    const { host, decoder, release } = fixture();
    const reading = decode({ decoder, blob: image() });
    const rejected = expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(direct).toHaveBeenCalledOnce());
    decoder.dispose(); await rejected;
    pending.reject(new DOMException('Late probe failure', 'InvalidStateError'));
    await Promise.resolve(); await Promise.resolve();
    expect(host.decode).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
    expect(direct.mock.calls[0]?.[0].signal.aborted).toBe(true);
  });

  it('rejects an already-aborted operation and releases a decoder only once', async () => {
    const direct = vi.spyOn(native, 'decodeNativeBlobImage');
    const { decoder, release, host } = fixture();
    const controller = new AbortController(); controller.abort();
    await expect(decoder.decode({ blob: image(), signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    decoder.dispose(); decoder.dispose();
    await expect(decode({ decoder, blob: image() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(release).toHaveBeenCalledOnce(); expect(direct).not.toHaveBeenCalled(); expect(host.decode).not.toHaveBeenCalled();
  });
});

describe('host image boundary and real reverse RPC', () => {
  it('serializes pending decodes and stops queued requests when the host owner ends', async () => {
    const controller = new AbortController();
    const pending = Promise.withResolvers<native.BlobImagePixels>();
    const direct = vi.spyOn(native, 'decodeNativeBlobImage').mockReturnValue(pending.promise);
    const host = createWorkerBlobImageHost({ signal: controller.signal, limits });
    const first = host.decode({ blob: image() }); const second = host.decode({ blob: image() });
    const failed = Promise.all([expect(first).rejects.toMatchObject({ name: 'AbortError' }), expect(second).rejects.toMatchObject({ name: 'AbortError' })]);
    await vi.waitFor(() => expect(direct).toHaveBeenCalledOnce());
    controller.abort(); await failed;
    pending.resolve(pixels()); await Promise.resolve(); await Promise.resolve();
    expect(direct).toHaveBeenCalledOnce();
  });

  it('rejects spoofed Blob requests at the host before native decoding', async () => {
    const controller = new AbortController();
    const direct = vi.spyOn(native, 'decodeNativeBlobImage');
    const host = createWorkerBlobImageHost({ signal: controller.signal, limits });
    await expect(host.decode({ blob: { size: 1, type: 'image/png', [Symbol.toStringTag]: 'Blob' } as unknown as Blob })).rejects.toThrow();
    expect(direct).not.toHaveBeenCalled(); controller.abort();
  });

  it('clones a real Blob, transfers an exact RGBA buffer, and finalizes the reverse proxy', async () => {
    interface TestWorker {
      start(host: WorkerProxy<WorkerBlobImageHost>): Promise<void>,
      read({ blob }: { blob: Blob }): Promise<string>,
      dispose(): Promise<void>,
    }
    let decoder: native.BlobImageDecoder | undefined;
    const api: WorkerServerApi<TestWorker> = {
      async start(host) {
        decoder = createWorkerBlobImageDecoder({ host, limits });
      },
      async read({ blob }) {
        return Array.from((await decoder!.decode({ blob, signal: undefined })).rgba).join(',');
      },
      async dispose() {
        decoder?.dispose();
      },
    };
    const channel = new MessageChannel();
    exposeWorkerRemote<TestWorker>({ api, endpoint: channel.port1 as unknown as MessagePort });
    const remote = wrapWorkerRemote<TestWorker>({ endpoint: channel.port2 as unknown as MessagePort });
    const controller = new AbortController();
    const sent: ArrayBuffer[] = []; const seen: Blob[] = [];
    vi.spyOn(native, 'decodeNativeBlobImage').mockImplementation(async ({ blob, signal }) => {
      if (signal !== controller.signal) throw new DOMException('Worker image decode unavailable', 'InvalidStateError');
      const result = pixels(); sent.push(result.rgba.buffer); seen.push(blob); return result;
    });
    const host = createWorkerBlobImageHost({ signal: controller.signal, limits });
    const finalized = vi.fn(); Object.assign(host, { [Comlink.finalizer]: finalized });
    try {
      await remote.start(workerProxy({ value: host }));
      expect(await remote.read({ blob: image() })).toBe('255,0,0,255');
      expect(sent).toHaveLength(2); expect(sent.every(buffer => buffer.byteLength === 0)).toBe(true);
      expect(seen.every(blob => blob instanceof Blob)).toBe(true);
      expect(seen.map(blob => blob.size)).toEqual([70, image().size]);
      await remote.dispose(); await vi.waitFor(() => expect(finalized).toHaveBeenCalledOnce());
    } finally {
      controller.abort(); decoder?.dispose(); releaseWorkerRemote({ remote }); channel.port1.close(); channel.port2.close();
    }
  });
});
