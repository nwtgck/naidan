// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeneratedTextFileHandle } from '@/features/wesh/naidan-sysfs/generated-text-file-handle';
import type { WeshFileHandle, WeshIVirtualFileSystem } from '@/features/wesh/types';
import { readVirtualFileBlob, readVirtualFileText, TEST_ONLY } from './virtual-file-content';

const chunkSize = TEST_ONLY.READ_CHUNK_SIZE;

function createInput({ size, bytes, shortRead }: {
  size: number,
  bytes: Uint8Array | undefined,
  shortRead: number | undefined,
}) {
  let position = 0;
  const read = vi.fn(async ({ buffer, offset, length }: { buffer: Uint8Array, offset?: number, length?: number }) => {
    const destination = offset ?? 0;
    const capacity = length ?? buffer.byteLength - destination;
    const count = Math.min(capacity, size - position, shortRead ?? capacity);
    if (bytes === undefined) buffer.fill(120, destination, destination + count);
    else buffer.set(bytes.subarray(position, position + count), destination);
    position += count;
    return { bytesRead: count };
  });
  const close = vi.fn(async (): Promise<void> => {});
  const stat = vi.fn(async () => ({ size: 2048, type: 'file' as const, mode: 0o444, mtime: 0, ino: 0, uid: 0, gid: 0 }));
  const handle: WeshFileHandle = {
    read, close, stat,
    write: async () => {
      throw new Error('Read only');
    },
    truncate: async () => {
      throw new Error('Read only');
    },
    ioctl: async () => ({ ret: 0 }),
  };
  const open = vi.fn(async () => handle);
  const files: Pick<WeshIVirtualFileSystem, 'open'> = { open };
  return { files, read, close, stat, open, handle, getPosition: () => position };
}

afterEach(() => vi.restoreAllMocks());

describe.each([
  { format: 'text', readContent: readVirtualFileText },
  { format: 'blob', readContent: readVirtualFileBlob },
])('virtual $format content', ({ readContent }) => {
  it.each([
    { size: 0, limit: 0, status: 'complete' },
    { size: 1, limit: 0, status: 'oversized' },
    { size: 4, limit: 5, status: 'complete' },
    { size: 5, limit: 5, status: 'complete' },
    { size: 6, limit: 5, status: 'oversized' },
    { size: chunkSize, limit: chunkSize, status: 'complete' },
    { size: Number.MAX_SAFE_INTEGER, limit: chunkSize, status: 'oversized' },
  ])('reads $size bytes with limit $limit as $status', async ({ size, limit, status }) => {
    const file = createInput({ size, bytes: undefined, shortRead: undefined });
    const result = await readContent({ files: file.files, path: '/file', byteLimit: limit, signal: undefined });
    expect(result.status).toBe(status);
    expect(file.getPosition()).toBe(Math.min(size, limit + 1));
    expect(file.read.mock.calls.every(([{ buffer }]) => buffer.byteLength <= chunkSize)).toBe(true);
    expect(file.stat).not.toHaveBeenCalled();
    expect(file.close).toHaveBeenCalledOnce();
    expect(file.open).toHaveBeenCalledWith({ path: '/file', mode: undefined,
      flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' } });
    if (status === 'oversized') expect(result).toEqual({ status: 'oversized' });
  });

  it('continues after positive short reads rather than treating them as EOF', async () => {
    const file = createInput({ size: 7, bytes: undefined, shortRead: 1 });
    expect((await readContent({ files: file.files, path: '/file', byteLimit: 7, signal: undefined })).status).toBe('complete');
    expect(file.read).toHaveBeenCalledTimes(8);
    expect(file.stat).not.toHaveBeenCalled();
    expect(file.close).toHaveBeenCalledOnce();
  });

  it('does not apply a chunk-sized whole-file limit to unbounded reads', async () => {
    const file = createInput({ size: chunkSize + 9, bytes: undefined, shortRead: undefined });
    expect((await readContent({ files: file.files, path: '/file', byteLimit: undefined, signal: undefined })).status).toBe('complete');
    expect(file.getPosition()).toBe(chunkSize + 9);
    expect(file.close).toHaveBeenCalledOnce();
  });

  it('does not allocate or overflow a MAX_SAFE_INTEGER byte limit', async () => {
    const file = createInput({ size: 2, bytes: undefined, shortRead: undefined });
    expect((await readContent({ files: file.files, path: '/file', byteLimit: Number.MAX_SAFE_INTEGER, signal: undefined })).status).toBe('complete');
    expect(file.read.mock.calls.every(([{ buffer }]) => buffer.byteLength <= chunkSize)).toBe(true);
  });

  it('rejects an already-cancelled request before opening any handle', async () => {
    const file = createInput({ size: 2, bytes: undefined, shortRead: undefined });
    const cancelled = new AbortController();
    cancelled.abort(new DOMException('Stopped', 'AbortError'));
    await expect(readContent({ files: file.files, path: '/file', byteLimit: undefined, signal: cancelled.signal })).rejects.toBe(cancelled.signal.reason);
    expect(file.open).not.toHaveBeenCalled();
    expect(file.close).not.toHaveBeenCalled();
  });

  it('closes a handle acquired after cancellation without reading it', async () => {
    const file = createInput({ size: 2, bytes: undefined, shortRead: undefined });
    const pending = Promise.withResolvers<WeshFileHandle>();
    const cancelled = new AbortController();
    file.open.mockReturnValueOnce(pending.promise);
    const operation = readContent({ files: file.files, path: '/file', byteLimit: undefined, signal: cancelled.signal });
    const rejection = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    cancelled.abort(new DOMException('Stopped', 'AbortError'));
    pending.resolve(file.handle);
    await rejection;
    expect(file.read).not.toHaveBeenCalled();
    expect(file.close).toHaveBeenCalledOnce();
  });

  it.each(['resolve', 'reject'] as const)('cancels a stalled read before a late %s and closes only its handle', async outcome => {
    const file = createInput({ size: 2, bytes: undefined, shortRead: undefined });
    const pending = Promise.withResolvers<{ bytesRead: number }>();
    const cancelled = new AbortController();
    file.read.mockReturnValueOnce(pending.promise);
    const operation = readContent({ files: file.files, path: '/file', byteLimit: undefined, signal: cancelled.signal });
    const rejection = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(file.read).toHaveBeenCalledOnce());
    cancelled.abort(new DOMException('Stopped', 'AbortError'));
    await rejection;
    expect(file.close).toHaveBeenCalledOnce();
    switch (outcome) {
    case 'resolve': file.read.mock.calls[0]![0].buffer.fill(255); pending.resolve({ bytesRead: 2 }); break;
    case 'reject': pending.reject(new Error('Late source failure')); break;
    default: { const _ex: never = outcome; throw new Error(`Unexpected outcome ${_ex}`); }
    }
    await Promise.resolve();
    expect(file.read).toHaveBeenCalledOnce();
    expect(file.close).toHaveBeenCalledOnce();
  });

  it('discards the final chunk when cancellation races with read completion', async () => {
    const file = createInput({ size: 2, bytes: undefined, shortRead: undefined });
    const cancelled = new AbortController();
    const reason = new DOMException('Stopped', 'AbortError');
    const read = file.read.getMockImplementation()!;
    file.read.mockImplementationOnce(async request => {
      const result = await read(request);
      cancelled.abort(reason);
      return result;
    });
    await expect(readContent({ files: file.files, path: '/file', byteLimit: undefined, signal: cancelled.signal })).rejects.toBe(reason);
    expect(file.read).toHaveBeenCalledOnce();
    expect(file.close).toHaveBeenCalledOnce();
  });

  it.each([0, undefined])('does not publish a result if cancelled while closing with limit %s', async byteLimit => {
    const file = createInput({ size: 2, bytes: undefined, shortRead: undefined });
    const pending = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const cancelled = new AbortController();
    file.close.mockImplementation(async () => {
      entered.resolve(); await pending.promise;
    });
    const operation = readContent({ files: file.files, path: '/file', byteLimit, signal: cancelled.signal });
    const rejection = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    await entered.promise;
    cancelled.abort(new DOMException('Stopped during close', 'AbortError'));
    pending.resolve();
    await rejection;
    expect(file.close).toHaveBeenCalledOnce();
  });
});

describe('virtual content validation and failures', () => {
  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid limit %s before opening', async byteLimit => {
    const file = createInput({ size: 2, bytes: undefined, shortRead: undefined });
    await expect(readVirtualFileText({ files: file.files, path: '/file', byteLimit, signal: undefined })).rejects.toBeInstanceOf(RangeError);
    expect(file.open).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5, NaN, Infinity, chunkSize + 1])('rejects invalid byte count %s', async bytesRead => {
    const file = createInput({ size: 2, bytes: undefined, shortRead: undefined });
    file.read.mockResolvedValue({ bytesRead });
    await expect(readVirtualFileBlob({ files: file.files, path: '/file', byteLimit: undefined, signal: undefined })).rejects.toThrow('Invalid virtual file byte count');
    expect(file.close).toHaveBeenCalledOnce();
  });

  it('propagates open failure without claiming ownership of a handle', async () => {
    const file = createInput({ size: 2, bytes: undefined, shortRead: undefined });
    const error = new DOMException('Denied', 'NotAllowedError');
    file.open.mockRejectedValue(error);
    await expect(readVirtualFileBlob({ files: file.files, path: '/file', byteLimit: undefined, signal: undefined })).rejects.toBe(error);
    expect(file.close).not.toHaveBeenCalled();
  });

  it('does not publish an exact-limit prefix when its EOF check fails', async () => {
    const file = createInput({ size: 5, bytes: undefined, shortRead: undefined });
    const original = file.read.getMockImplementation()!;
    const error = new Error('EOF check failed');
    file.read.mockImplementationOnce(original).mockRejectedValueOnce(error);
    await expect(readVirtualFileText({ files: file.files, path: '/file', byteLimit: 5, signal: undefined })).rejects.toBe(error);
    expect(file.read.mock.calls[1]?.[0]).toMatchObject({ offset: 5, length: 1 });
    expect(file.close).toHaveBeenCalledOnce();
  });

  it.each([0, undefined])('propagates close failure without publishing success or oversize for limit %s', async byteLimit => {
    const file = createInput({ size: 2, bytes: undefined, shortRead: undefined });
    const error = new Error('Close failed');
    file.close.mockRejectedValue(error);
    await expect(readVirtualFileBlob({ files: file.files, path: '/file', byteLimit, signal: undefined })).rejects.toBe(error);
    expect(file.close).toHaveBeenCalledOnce();
  });

  it('retains both read and cleanup failures', async () => {
    const file = createInput({ size: 2, bytes: undefined, shortRead: undefined });
    const error = new Error('Read failed'); const cleanupError = new Error('Close failed');
    file.read.mockRejectedValue(error); file.close.mockRejectedValue(cleanupError);
    await expect(readVirtualFileText({ files: file.files, path: '/file', byteLimit: undefined, signal: undefined })).rejects.toMatchObject({ errors: [error, cleanupError] });
    expect(file.close).toHaveBeenCalledOnce();
  });

  it('preserves a synchronous read exception and an undefined rejection cause', async () => {
    const file = createInput({ size: 2, bytes: undefined, shortRead: undefined });
    file.read.mockImplementation(() => {
      throw undefined;
    });
    await expect(readVirtualFileText({ files: file.files, path: '/file', byteLimit: undefined, signal: undefined })).rejects.toBeUndefined();
    expect(file.close).toHaveBeenCalledOnce();
  });
});

describe('virtual text and Blob assembly', () => {
  it('decodes split UTF-8 and BOM without reading a newly constructed Blob', async () => {
    const bytes = new Uint8Array([...new TextEncoder().encode('\uFEFF日\uFEFF😀'), 255, 195, 40, 226, 130]);
    const file = createInput({ size: bytes.byteLength, bytes, shortRead: 1 });
    const arrayBuffer = vi.spyOn(Blob.prototype, 'arrayBuffer').mockRejectedValue(new Error('Unsafe Blob read'));
    const text = vi.spyOn(Blob.prototype, 'text').mockRejectedValue(new Error('Unsafe Blob read'));
    expect(await readVirtualFileText({ files: file.files, path: '/file', byteLimit: bytes.byteLength, signal: undefined })).toEqual({ status: 'complete', value: new TextDecoder().decode(bytes) });
    expect(arrayBuffer).not.toHaveBeenCalled(); expect(text).not.toHaveBeenCalled();
  });

  it('counts encoded bytes, not decoded characters', async () => {
    const bytes = new TextEncoder().encode('日本語');
    const file = createInput({ size: bytes.byteLength, bytes, shortRead: 1 });
    expect(await readVirtualFileText({ files: file.files, path: '/file', byteLimit: 3, signal: undefined })).toEqual({ status: 'oversized' });
    expect(file.getPosition()).toBe(4);
  });

  it('coalesces small reads without a full-size input buffer allocation per tiny fragment', async () => {
    const bytes = Uint8Array.from({ length: chunkSize * 2 + 5 }, (_, i) => i % 256);
    const file = createInput({ size: bytes.byteLength, bytes, shortRead: 257 });
    const result = await readVirtualFileBlob({ files: file.files, path: '/file', byteLimit: undefined, signal: undefined });
    expect(new Set(file.read.mock.calls.map(([{ buffer }]) => buffer)).size).toBe(3);
    expect(file.read.mock.calls[1]?.[0].offset).toBe(257);
    switch (result.status) {
    case 'complete': expect(new Uint8Array(await result.value.arrayBuffer())).toEqual(bytes); break;
    case 'oversized': throw new Error('Expected complete content');
    default: { const _ex: never = result; throw new Error(`Unexpected result ${_ex}`); }
    }
  });

  it.each([1, undefined])('snapshots binary chunks without retaining mutable buffers or unused tails (short read %s)', async shortRead => {
    const bytes = Uint8Array.from({ length: shortRead === undefined ? chunkSize + 3 : 257 }, (_, i) => i % 256);
    const file = createInput({ size: bytes.byteLength, bytes, shortRead });
    const result = await readVirtualFileBlob({ files: file.files, path: '/file', byteLimit: undefined, signal: undefined });
    switch (result.status) {
    case 'complete':
      for (const [{ buffer }] of file.read.mock.calls) buffer.fill(0);
      expect(result.value.size).toBe(bytes.byteLength);
      expect(new Uint8Array(await result.value.arrayBuffer())).toEqual(bytes);
      break;
    case 'oversized': throw new Error('Unbounded read must complete');
    default: { const _ex: never = result; throw new Error(`Unexpected result ${_ex}`); }
    }
    expect(file.close).toHaveBeenCalledOnce();
  });
});


describe('virtual consumer with the generated-text producer', () => {
  it.each(['resolve', 'reject'] as const)('closes pending text generation before its late %s and never encodes its result', async outcome => {
    const pending = Promise.withResolvers<string>();
    const render = vi.fn(() => pending.promise);
    const handle = new GeneratedTextFileHandle({ estimatedSize: 4096, readText: render });
    const close = vi.spyOn(handle, 'close');
    const controller = new AbortController();
    const reason = new DOMException('Preview disposed', 'AbortError');
    const operation = readVirtualFileText({
      files: { open: async () => handle }, path: '/metadata.json', byteLimit: 16, signal: controller.signal,
    });
    const rejected = expect(operation).rejects.toBe(reason);
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    controller.abort(reason);
    await rejected;
    expect(close).toHaveBeenCalledOnce();
    if (outcome === 'resolve') pending.resolve('x'.repeat(4 * 1024 * 1024));
    else pending.reject(new Error('Late metadata failure'));
    await Promise.resolve(); await Promise.resolve();
    expect(encode).not.toHaveBeenCalled();
    await expect(handle.read({ buffer: new Uint8Array(1) })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not encode the rest of a large generated string after the preview limit', async () => {
    const handle = new GeneratedTextFileHandle({ estimatedSize: 1, readText: async () => '日'.repeat(1024 * 1024) });
    const close = vi.spyOn(handle, 'close');
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    expect(await readVirtualFileBlob({ files: { open: async () => handle }, path: '/data', byteLimit: 5, signal: undefined }))
      .toEqual({ status: 'oversized' });
    expect(encode).toHaveBeenCalledOnce();
    expect(encode.mock.calls[0]![0]!.length).toBeLessThanOrEqual(16 * 1024);
    expect(close).toHaveBeenCalledOnce();
    await expect(handle.stat()).rejects.toMatchObject({ name: 'AbortError' });
  });
});
