// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBlobContext, createNativeBlobContext, type BlobContext } from './blob-view';
import { BLOB_VIEW_CHUNK_SIZE, readNativeBlobRange } from './blob-view-io';
import { BlobViewZipReadError, createBlobViewZipSource } from './blob-view-zip-source';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function fixture({ size }: { size: number }) {
  const bytes = Uint8Array.from({ length: size }, (_, index) => index % 256);
  const read = vi.fn(readNativeBlobRange);
  const context = createBlobContext({ reader: { read }, release: undefined });
  cleanup.push(() => context.dispose());
  const blob = context.fromNative({ blob: new Blob([bytes]) });
  const controller = new AbortController();
  const source = createBlobViewZipSource({ blob, signal: controller.signal });
  cleanup.push(() => source.close());
  return { source, blob, context, controller, read, bytes };
}

describe('ZIP random access through BlobView', () => {
  it('is lazy, preserves binary ranges and makes independent reads', async () => {
    const { source, read, bytes } = fixture({ size: 517 });
    expect(source.size).toBe(517);
    expect(read).not.toHaveBeenCalled();
    expect(await source.read({ offset: 255, length: 4 })).toEqual(bytes.slice(255, 259));
    expect(await source.read({ offset: 0, length: 3 })).toEqual(bytes.slice(0, 3));
    expect(await source.read({ offset: 517, length: 0 })).toHaveLength(0);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('bounds physical reads even for a large ZIP request', async () => {
    const { source, read, bytes } = fixture({ size: BLOB_VIEW_CHUNK_SIZE * 2 + 13 });
    const result = await source.read({ offset: 2, length: bytes.byteLength - 2 });
    expect(result.byteLength).toBe(bytes.byteLength - 2);
    expect(result.every((value, index) => value === bytes[index + 2])).toBe(true);
    expect(read.mock.calls.map(([request]) => request.length)).toEqual([BLOB_VIEW_CHUNK_SIZE, BLOB_VIEW_CHUNK_SIZE, 11]);
  });

  it.each([
    { offset: -1, length: 1 }, { offset: 1.5, length: 1 }, { offset: Infinity, length: 0 },
    { offset: 0, length: -1 }, { offset: 0, length: NaN }, { offset: 1, length: 4 },
    { offset: 5, length: 0 }, { offset: Number.MAX_SAFE_INTEGER + 1, length: 0 },
  ])('rejects invalid ranges rather than clamping them: %j', async ({ offset, length }) => {
    const { source, read } = fixture({ size: 4 });
    await expect(source.read({ offset, length })).rejects.toBeInstanceOf(RangeError);
    expect(read).not.toHaveBeenCalled();
  });

  it('distinguishes a byte failure from a malformed archive and retains its cause', async () => {
    const { source, read } = fixture({ size: 4 });
    const cause = new DOMException('Unreadable snapshot', 'NotReadableError');
    read.mockRejectedValue(cause);
    await expect(source.read({ offset: 0, length: 4 })).rejects.toMatchObject({ name: 'BlobViewZipReadError', cause });
  });

  it('does not return a truncated range as successful data', async () => {
    const { source, read } = fixture({ size: 4 });
    read.mockResolvedValue(new Uint8Array(3));
    await expect(source.read({ offset: 0, length: 4 })).rejects.toBeInstanceOf(BlobViewZipReadError);
  });

  it.each(['close', 'abort'] as const)('ends an outstanding wait on %s without disposing the shared context', async mode => {
    const { source, blob, read, controller } = fixture({ size: 4 });
    const late = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
    read.mockReturnValueOnce(late.promise);
    const reading = source.read({ offset: 0, length: 4 });
    const rejected = expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    switch (mode) {
    case 'close':
      await source.close();
      break;
    case 'abort':
      controller.abort(new DOMException('Cancelled', 'AbortError'));
      break;
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled mode: ${String(_ex)}`);
    }
    }
    await rejected;
    expect(await blob.bytes()).toEqual(new Uint8Array([0, 1, 2, 3]));
    late.reject(new Error('Late native read failure'));
    await expect(source.read({ offset: 0, length: 0 })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('closes independently from other sources of the same view and removes its signal listener', async () => {
    const { source, blob, controller, read } = fixture({ size: 4 });
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const other = createBlobViewZipSource({ blob, signal: undefined });
    cleanup.push(() => other.close());
    await source.close();
    await source.close();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(await other.read({ offset: 0, length: 4 })).toEqual(new Uint8Array([0, 1, 2, 3]));
    expect(read).toHaveBeenCalledOnce();
  });

  it('does no IO when the owning operation was cancelled before creating the source', async () => {
    const context: BlobContext = createNativeBlobContext();
    cleanup.push(() => context.dispose());
    const controller = new AbortController();
    controller.abort(new Error('Stopped'));
    const blob = context.fromNative({ blob: new Blob(['data']) });
    const slice = vi.fn(blob.slice);
    const source = createBlobViewZipSource({ blob: { ...blob, slice }, signal: controller.signal });
    cleanup.push(() => source.close());
    await expect(source.read({ offset: 0, length: 4 })).rejects.toBe(controller.signal.reason);
    expect(slice).not.toHaveBeenCalled();
  });
});
