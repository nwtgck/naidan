// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { promiseAllKeyed } from '@/utils/promise';
import { createBlobContext } from '@/utils/blob-view';
import { BLOB_VIEW_CHUNK_SIZE, readNativeBlobRange } from '@/utils/blob-view-io';
import { BlobFileHandle } from './blob-file-handle';

const contexts: Array<ReturnType<typeof createBlobContext>> = [];
afterEach(() => {
  for (const context of contexts.splice(0)) context.dispose();
});
function fixture({ size }: { size: number }) {
  const bytes = Uint8Array.from({ length: size }, (_, index) => index % 256);
  const read = vi.fn(readNativeBlobRange);
  const release = vi.fn();
  const context = createBlobContext({ reader: { read }, release });
  contexts.push(context);
  const blob = context.fromNative({ blob: new Blob([bytes]) });
  const metadata = { id: 'binary-1', name: 'data.bin', size, createdAt: 123, mimeType: 'application/octet-stream' };
  return { read, release, context, blob, bytes, handle: new BlobFileHandle({ blob, metadata }), metadata };
}

describe('sysfs BlobView file handle', () => {
  it('copies binary ranges and advances only by bytes that fit the destination', async () => {
    const { handle, read, bytes } = fixture({ size: 260 });
    const buffer = new Uint8Array(5).fill(42);
    expect(await handle.read({ buffer, offset: 1, length: 99 })).toEqual({ bytesRead: 4 });
    expect(buffer).toEqual(new Uint8Array([42, 0, 1, 2, 3]));
    expect(await handle.read({ buffer, position: 254, length: 4 })).toEqual({ bytesRead: 4 });
    expect(buffer.subarray(0, 4)).toEqual(new Uint8Array([254, 255, 0, 1]));
    expect(await handle.read({ buffer, length: 2 })).toEqual({ bytesRead: 2 });
    expect(buffer.subarray(0, 2)).toEqual(bytes.subarray(4, 6));
    expect(read).toHaveBeenCalledTimes(3);
    await handle.close();
  });

  it('bounds each file-handle request even when the destination is larger', async () => {
    const { handle, read, bytes } = fixture({ size: BLOB_VIEW_CHUNK_SIZE + 5 });
    const buffer = new Uint8Array(bytes.length);
    expect(await handle.read({ buffer })).toEqual({ bytesRead: BLOB_VIEW_CHUNK_SIZE });
    expect(await handle.read({ buffer, offset: BLOB_VIEW_CHUNK_SIZE })).toEqual({ bytesRead: 5 });
    expect(buffer).toEqual(bytes);
    expect(read.mock.calls.map(([request]) => request.length)).toEqual([BLOB_VIEW_CHUNK_SIZE, 5]);
    await handle.close();
  });

  it.each([{ offset: -1 }, { offset: 3 }, { offset: 0.5 }, { length: -1 }, { length: NaN }, { position: -1 }, { position: Infinity }])('rejects invalid ranges before reading: %j', async options => {
    const { handle, read } = fixture({ size: 3 });
    await expect(handle.read({ buffer: new Uint8Array(2), ...options })).rejects.toBeInstanceOf(RangeError);
    expect(read).not.toHaveBeenCalled();
    await handle.close();
  });

  it('does not perform IO for empty requests or EOF and keeps the cursor after positional EOF', async () => {
    const { handle, read } = fixture({ size: 1 });
    expect(await handle.read({ buffer: new Uint8Array(0) })).toEqual({ bytesRead: 0 });
    expect(await handle.read({ buffer: new Uint8Array(1), position: 8 })).toEqual({ bytesRead: 0 });
    expect(read).not.toHaveBeenCalled();
    expect(await handle.read({ buffer: new Uint8Array(1) })).toEqual({ bytesRead: 1 });
    expect(await handle.read({ buffer: new Uint8Array(1) })).toEqual({ bytesRead: 0 });
    expect(read).toHaveBeenCalledOnce();
    await handle.close();
  });

  it('preserves buffer and cursor if the view read fails', async () => {
    const { handle, read } = fixture({ size: 5 });
    const error = new Error('Read unavailable');
    read.mockRejectedValueOnce(error);
    const buffer = new Uint8Array(2).fill(77);
    await expect(handle.read({ buffer })).rejects.toBe(error);
    expect(buffer).toEqual(new Uint8Array([77, 77]));
    expect(await handle.read({ buffer })).toEqual({ bytesRead: 2 });
    expect(buffer).toEqual(new Uint8Array([0, 1]));
    await handle.close();
  });

  it('ends a pending read on close without disposing a shared context or accepting late bytes', async () => {
    const { handle, read, context, release } = fixture({ size: 2 });
    const pending = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
    read.mockReturnValueOnce(pending.promise);
    const buffer = new Uint8Array(2).fill(77);
    const operation = handle.read({ buffer });
    const rejected = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    await handle.close(); await handle.close();
    await rejected;
    pending.resolve(new Uint8Array([1, 2]));
    await Promise.resolve();
    expect(buffer).toEqual(new Uint8Array([77, 77]));
    expect(release).not.toHaveBeenCalled();
    expect(await context.fromNative({ blob: new Blob(['other']) }).text()).toBe('other');
    await expect(handle.read({ buffer })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(handle.stat()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps metadata and read-only behavior without consuming bytes', async () => {
    const { handle, read } = fixture({ size: 4 });
    expect(await handle.stat()).toMatchObject({ size: 4, mtime: 123, mode: 0o444, type: 'file' });
    await expect(handle.write()).rejects.toThrow('read-only');
    await expect(handle.truncate({ size: 0 })).rejects.toThrow('read-only');
    expect(read).not.toHaveBeenCalled();
    await handle.close();
  });
  it('assigns disjoint implicit positions while the host is pending', async () => {
    const { handle, read } = fixture({ size: 6 });
    const pending = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
    read.mockReturnValueOnce(pending.promise);
    const first = new Uint8Array(2), second = new Uint8Array(2), third = new Uint8Array(2);
    const all = promiseAllKeyed({ first: handle.read({ buffer: first }), second: handle.read({ buffer: second }), third: handle.read({ buffer: third }) });
    try {
      await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    } finally {
      pending.resolve(new Uint8Array([0, 1]));
    }
    expect(await all).toEqual({ first: { bytesRead: 2 }, second: { bytesRead: 2 }, third: { bytesRead: 2 } });
    expect(first).toEqual(new Uint8Array([0, 1]));
    expect(second).toEqual(new Uint8Array([2, 3]));
    expect(third).toEqual(new Uint8Array([4, 5]));
    expect(await handle.read({ buffer: first })).toEqual({ bytesRead: 0 });
    await handle.close();
  });

  it('does not move the cursor for a positional read between queued implicit reads', async () => {
    const { handle } = fixture({ size: 6 });
    const first = new Uint8Array(2), positioned = new Uint8Array(2), second = new Uint8Array(2);
    await promiseAllKeyed({ first: handle.read({ buffer: first }), positioned: handle.read({ buffer: positioned, position: 4 }), second: handle.read({ buffer: second }) });
    expect(first).toEqual(new Uint8Array([0, 1]));
    expect(positioned).toEqual(new Uint8Array([4, 5]));
    expect(second).toEqual(new Uint8Array([2, 3]));
    await handle.close();
  });

  it('allows queued reads to proceed from the old position after a failed read', async () => {
    const { handle, read } = fixture({ size: 6 });
    const pending = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
    read.mockReturnValueOnce(pending.promise);
    const first = new Uint8Array(2).fill(77), second = new Uint8Array(2);
    const failed = handle.read({ buffer: first });
    const error = new Error('Host rejected');
    const rejected = expect(failed).rejects.toBe(error);
    const next = handle.read({ buffer: second });
    pending.reject(error);
    await rejected;
    expect(await next).toEqual({ bytesRead: 2 });
    expect(first).toEqual(new Uint8Array([77, 77]));
    expect(second).toEqual(new Uint8Array([0, 1]));
    await handle.close();
  });

  it('rejects queued reads on close without starting more host requests', async () => {
    const { handle, read, context, release } = fixture({ size: 6 });
    const pending = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
    read.mockReturnValueOnce(pending.promise);
    const first = new Uint8Array(2).fill(77), second = first.slice();
    const active = handle.read({ buffer: first });
    const activeRejected = expect(active).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    const queued = handle.read({ buffer: second });
    const queuedRejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    await handle.close();
    await activeRejected; await queuedRejected;
    expect(read).toHaveBeenCalledOnce();
    expect(first).toEqual(new Uint8Array([77, 77]));
    expect(second).toEqual(first);
    expect(release).not.toHaveBeenCalled();
    pending.reject(new Error('Late host error'));
    expect(await context.fromNative({ blob: new Blob(['sibling']) }).text()).toBe('sibling');
  });

});
