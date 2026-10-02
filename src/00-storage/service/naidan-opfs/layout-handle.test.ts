import { Blob as NativeBlob, File as NativeFile } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageBinaryObjectReadBacking, StorageBinaryObjectReadHandle } from '@/00-storage/service/binary-object-io';
import type { StorageFileHandle } from '@/00-storage/service/storage-file-system/types';
import { NaidanOpfsLayoutFileHandle } from './layout-handle';

function fixture({ bytes, backing, modifiedAt }: {
  bytes: Uint8Array<ArrayBuffer>;
  backing: StorageBinaryObjectReadBacking;
  modifiedAt: number | undefined;
}) {
  const close = vi.fn(async () => {});
  const stream = vi.fn<StorageBinaryObjectReadHandle['stream']>(() => new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  }));
  const stat = vi.fn<StorageFileHandle['stat']>(async () => ({
    size: bytes.length, createdAt: undefined, modifiedAt,
  }));
  const openReadable = vi.fn<StorageFileHandle['openReadable']>(async () => ({
    size: bytes.length,
    mimeType: 'application/x-layout',
    backing,
    async read() {
      throw new Error('Unexpected positioned read');
    },
    stream,
    close,
  }));
  const handle: StorageFileHandle = {
    kind: 'file', name: 'value.bin', stat, openReadable,
    async createWritable() {
      throw new Error('Unexpected write');
    },
  };
  return { file: new NaidanOpfsLayoutFileHandle({ handle }), close, stream, stat, openReadable };
}

describe('Naidan OPFS layout File materialization', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(987654);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    { size: 0, modifiedAt: undefined },
    { size: 6, modifiedAt: 0 },
    { size: 6, modifiedAt: 1234 },
  ])('wraps a same-realm $size-byte reader Blob without another full arrayBuffer read ($modifiedAt)', async ({ size, modifiedAt }) => {
    // Response uses Node's Blob in this environment; use its matching File family locally.
    vi.stubGlobal('Blob', NativeBlob);
    vi.stubGlobal('File', NativeFile);
    const bytes = Uint8Array.of(0, 65, 255, 13, 10, 42).slice(0, size);
    const source = fixture({ bytes, backing: { type: 'reader_only' }, modifiedAt });
    const arrayBuffer = vi.spyOn(NativeBlob.prototype, 'arrayBuffer');
    const file = await source.file.getFile();
    expect(arrayBuffer).not.toHaveBeenCalled();
    arrayBuffer.mockRestore();

    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    expect(file).toMatchObject({ name: 'value.bin', type: 'application/x-layout', size, lastModified: modifiedAt ?? 987654 });
    expect(source.openReadable).toHaveBeenCalledExactlyOnceWith({ mimeType: 'application/octet-stream' });
    expect(source.stream).toHaveBeenCalledExactlyOnceWith({ start: 0, end: undefined, signal: undefined });
    expect(source.close).toHaveBeenCalledOnce();
  });

  it('wraps an already available same-realm Blob without reading its bytes again', async () => {
    const bytes = Uint8Array.of(0, 128, 255);
    const blob = new Blob([bytes], { type: 'application/x-direct' });
    const arrayBuffer = vi.spyOn(blob, 'arrayBuffer').mockRejectedValue(new Error('Do not rematerialize this Blob'));
    const source = fixture({ bytes, backing: { type: 'direct_blob', blob }, modifiedAt: 12 });
    const file = await source.file.getFile();
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    expect(file).toMatchObject({ name: 'value.bin', type: 'application/x-direct', lastModified: 12 });
    expect(source.stream).not.toHaveBeenCalled();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it('preserves bytes when Response and File use different Blob implementations', async () => {
    const bytes = Uint8Array.of(0, 65, 255);
    const source = fixture({ bytes, backing: { type: 'reader_only' }, modifiedAt: 1234 });
    const arrayBuffer = vi.spyOn(NativeBlob.prototype, 'arrayBuffer');
    const file = await source.file.getFile();
    expect(arrayBuffer).toHaveBeenCalledOnce();
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    expect(file).toMatchObject({ name: 'value.bin', type: 'application/x-layout', lastModified: 1234 });
    expect(source.close).toHaveBeenCalledOnce();
  });

  it('keeps the byte-conversion fallback when no global Blob constructor is available', async () => {
    vi.stubGlobal('Blob', undefined);
    const bytes = Uint8Array.of(0, 65, 255);
    const source = fixture({ bytes, backing: { type: 'reader_only' }, modifiedAt: 1234 });
    const file = await source.file.getFile();
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    expect(file).toMatchObject({ name: 'value.bin', type: 'application/x-layout', lastModified: 1234 });
    expect(source.close).toHaveBeenCalledOnce();
  });

  it.each(['value.bin', 'other.bin'])('preserves direct File bytes and metadata for %s', async name => {
    const bytes = Uint8Array.of(1, 2, 3);
    const blob = new File([bytes], name, { type: 'application/x-original', lastModified: 42 });
    const source = fixture({ bytes, backing: { type: 'direct_blob', blob }, modifiedAt: 1234 });
    const file = await source.file.getFile();
    expect(file === blob).toBe(name === 'value.bin');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    expect(file).toMatchObject({
      name: 'value.bin', type: 'application/x-original', lastModified: name === 'value.bin' ? 42 : 1234,
    });
    expect(source.stream).not.toHaveBeenCalled();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it.each(['read', 'stat', 'construction'] as const)('preserves %s and close failures in operation order', async stage => {
    const failure = new Error(`${stage} failed`);
    const closeFailure = new Error('close failed');
    const source = fixture({ bytes: Uint8Array.of(1), backing: { type: 'reader_only' }, modifiedAt: 1 });
    source.close.mockRejectedValue(closeFailure);
    switch (stage) {
    case 'read':
      source.stream.mockImplementation(() => new ReadableStream({
        start(controller) {
          controller.error(failure);
        },
      }));
      break;
    case 'stat':
      source.stat.mockRejectedValue(failure);
      break;
    case 'construction':
      vi.stubGlobal('File', class {
        constructor() {
          throw failure;
        }
      });
      break;
    default: {
      const _ex: never = stage;
      throw new Error(String(_ex));
    }
    }
    await expect(source.file.getFile()).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([failure, closeFailure]);
      return true;
    });
    expect(source.close).toHaveBeenCalledOnce();
  });

  it('rejects an otherwise successful materialization when closing its reader fails', async () => {
    const source = fixture({ bytes: Uint8Array.of(1), backing: { type: 'reader_only' }, modifiedAt: 1 });
    const failure = new Error('close failed');
    source.close.mockRejectedValue(failure);
    await expect(source.file.getFile()).rejects.toBe(failure);
    expect(source.close).toHaveBeenCalledOnce();
  });
});
