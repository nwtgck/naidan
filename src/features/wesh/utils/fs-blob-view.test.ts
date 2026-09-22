// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlobViewShellFixture } from './blob-view.test-helpers';
import { readAllFileBytes, readAllFileText, openFileReadStream } from './fs';
import * as io from '@/utils/blob-view-io';
import { WESH_EFFICIENT_BLOB_READ_FALLBACK_REQUIRED } from '@/features/wesh/types';

let fixture: Awaited<ReturnType<typeof createBlobViewShellFixture>>;
beforeEach(async () => {
  fixture = await createBlobViewShellFixture();
});
afterEach(() => {
  fixture?.dispose(); vi.restoreAllMocks();
});

describe('Wesh safe efficient BlobView capability', () => {
  it('gets metadata without I/O and uses each captured snapshot without reopening a file handle', async () => {
    const file = await fixture.writeFile({ path: '/input.txt', data: '日本語\0😀' });
    fixture.blockNativeReads();
    const open = vi.spyOn(fixture.wesh.vfs, 'open');
    const source = await fixture.wesh.vfs.tryReadBlobEfficiently({ path: '/input.txt' });
    expect(source.kind).toBe('blob_view');
    if (source.kind !== 'blob_view') throw new Error('Expected a view');
    expect(fixture.read).not.toHaveBeenCalled();
    file.content = new TextEncoder().encode('replacement');
    expect(await source.blob.text()).toBe('日本語\0😀');
    expect(await readAllFileText({ files: fixture.wesh.vfs, path: '/input.txt' })).toBe('replacement');
    expect(await readAllFileBytes({ files: fixture.wesh.vfs, path: '/input.txt' })).toEqual(new TextEncoder().encode('replacement'));
    expect(await new Response(await openFileReadStream({ files: fixture.wesh.vfs, path: '/input.txt' })).text()).toBe('replacement');
    expect(open).not.toHaveBeenCalled();
  });

  it('does not perform a host call in a normally readable context', async () => {
    await fixture.writeFile({ path: '/data.bin', data: new Uint8Array([0, 255, 128]) });
    const open = vi.spyOn(fixture.wesh.vfs, 'open');
    expect(await readAllFileBytes({ files: fixture.wesh.vfs, path: '/data.bin' })).toEqual(new Uint8Array([0, 255, 128]));
    expect(fixture.read).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  });

  it('keeps independent streaming cursors and does not cancel siblings or the context', async () => {
    const bytes = new Uint8Array(io.BLOB_VIEW_CHUNK_SIZE + 9).fill(255);
    await fixture.writeFile({ path: '/data.bin', data: bytes });
    fixture.blockNativeReads();
    const first = (await openFileReadStream({ files: fixture.wesh.vfs, path: '/data.bin' })).getReader();
    const second = (await openFileReadStream({ files: fixture.wesh.vfs, path: '/data.bin' })).getReader();
    try {
      expect((await first.read()).value?.byteLength).toBe(io.BLOB_VIEW_CHUNK_SIZE);
      await first.cancel();
      expect((await second.read()).value?.byteLength).toBe(io.BLOB_VIEW_CHUNK_SIZE);
      expect((await second.read()).value).toEqual(bytes.subarray(io.BLOB_VIEW_CHUNK_SIZE));
      expect((await second.read()).done).toBe(true);
      expect((await readAllFileBytes({ files: fixture.wesh.vfs, path: '/data.bin' })).byteLength).toBe(bytes.byteLength);
    } finally {
      await first.cancel(); await second.cancel(); first.releaseLock(); second.releaseLock();
    }
    expect(fixture.read.mock.calls.every(([request]) => request.length <= io.BLOB_VIEW_CHUNK_SIZE)).toBe(true);
  });

  it('does not retry failed efficient reads through a file handle or report empty content', async () => {
    await fixture.writeFile({ path: '/data.txt', data: 'cannot read' });
    fixture.blockNativeReads();
    fixture.read.mockRejectedValue(new Error('Host read failed'));
    const open = vi.spyOn(fixture.wesh.vfs, 'open');
    await expect(readAllFileText({ files: fixture.wesh.vfs, path: '/data.txt' })).rejects.toThrow();
    await expect(readAllFileBytes({ files: fixture.wesh.vfs, path: '/data.txt' })).rejects.toThrow();
    const reader = (await openFileReadStream({ files: fixture.wesh.vfs, path: '/data.txt' })).getReader();
    try {
      await expect(reader.read()).rejects.toThrow();
    } finally {
      await reader.cancel().catch(() => undefined); reader.releaseLock();
    }
    expect(open).not.toHaveBeenCalled();
  });

  it('propagates snapshot acquisition errors without reopening a different snapshot', async () => {
    const file = await fixture.writeFile({ path: '/data.txt', data: 'x' });
    const error = new DOMException('Snapshot failed', 'NotReadableError');
    vi.mocked((file as unknown as FileSystemFileHandle).getFile).mockRejectedValue(error);
    const open = vi.spyOn(fixture.wesh.vfs, 'open');
    await expect(readAllFileText({ files: fixture.wesh.vfs, path: '/data.txt' })).rejects.toBe(error);
    expect(open).not.toHaveBeenCalled(); expect(fixture.read).not.toHaveBeenCalled();
  });

  it('disposes pending view reads but does not consume a late response', async () => {
    await fixture.writeFile({ path: '/data.txt', data: 'payload' });
    fixture.blockNativeReads();
    await fixture.blobs.fromNative({ blob: new Blob(['warm']) }).text();
    const late = Promise.withResolvers<Awaited<ReturnType<typeof fixture.read>>>();
    const previous = fixture.read.mock.calls.length;
    fixture.read.mockReturnValueOnce(late.promise);
    const operation = readAllFileBytes({ files: fixture.wesh.vfs, path: '/data.txt' });
    const rejected = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(fixture.read).toHaveBeenCalledTimes(previous + 1));
    fixture.dispose(); await rejected;
    late.reject(new Error('Late host failure'));
  });

  it('copies a rename fallback through the view and removes the source only after close', async () => {
    const bytes = new Uint8Array(io.BLOB_VIEW_CHUNK_SIZE + 13).fill(255);
    await fixture.writeFile({ path: '/source.bin', data: bytes });
    fixture.blockNativeReads();
    await fixture.wesh.vfs.rename({ oldPath: '/source.bin', newPath: '/target.bin' });
    expect((await fixture.root.getFileHandle('target.bin')).content).toEqual(bytes);
    await expect(fixture.root.getFileHandle('source.bin')).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(fixture.read).toHaveBeenCalled();
  });

  it('preserves the rename source and aborts its target when range reading fails', async () => {
    const bytes = new Uint8Array([0, 255, 128]);
    await fixture.writeFile({ path: '/source.bin', data: bytes });
    fixture.blockNativeReads(); fixture.read.mockRejectedValue(new Error('Unavailable host'));
    await expect(fixture.wesh.vfs.rename({ oldPath: '/source.bin', newPath: '/target.bin' })).rejects.toThrow();
    expect((await fixture.root.getFileHandle('source.bin')).content).toEqual(bytes);
    expect((await fixture.root.getFileHandle('target.bin')).content).toHaveLength(0);
  });

  it('does not delete a rename source when its context ends during a host read', async () => {
    const bytes = new Uint8Array([0, 255, 128]);
    await fixture.writeFile({ path: '/source.bin', data: bytes });
    fixture.blockNativeReads();
    await fixture.blobs.fromNative({ blob: new Blob(['warm']) }).text();
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof fixture.read>>>();
    const previous = fixture.read.mock.calls.length;
    fixture.read.mockReturnValueOnce(pending.promise);
    const operation = fixture.wesh.vfs.rename({ oldPath: '/source.bin', newPath: '/target.bin' });
    const rejected = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(fixture.read).toHaveBeenCalledTimes(previous + 1));
    fixture.dispose(); await rejected;
    expect((await fixture.root.getFileHandle('source.bin')).content).toEqual(bytes);
    pending.reject(new Error('Late read failure'));
  });

  it('still offers handle fallback for virtual files and rejects missing/native directories', async () => {
    const vfs = fixture.wesh.vfs;
    await expect(vfs.tryReadBlobEfficiently({ path: '/' })).rejects.toThrow();
    await expect(vfs.tryReadBlobEfficiently({ path: '/missing' })).rejects.toThrow();
    // Devices have no whole immutable Blob snapshot.
    expect(await vfs.tryReadBlobEfficiently({ path: '/dev/null' })).toEqual({
      kind: 'fallback_required', reason: WESH_EFFICIENT_BLOB_READ_FALLBACK_REQUIRED,
    });
  });
});
