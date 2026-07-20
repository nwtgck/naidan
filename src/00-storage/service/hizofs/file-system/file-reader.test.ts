import { describe, expect, it, vi } from 'vitest';
import { HizoFSFileReader } from './file-reader';
import type { HizoFSExtentIndex } from './extent-index';
import type { HizoFSFileChunkStore } from './file-chunk-store';
import type { HizoFSMaintenanceLease } from './maintenance-lock';
import type { LoadedHizoFSFile } from './node-service';

function createBlockedExtentReader() {
  const chunkReadStarted = Promise.withResolvers<void>();
  const chunkRead = Promise.withResolvers<Uint8Array>();
  const release = vi.fn(async () => undefined);
  const onSettled = vi.fn();
  const extentIndex = {
    getWithLeafCache: vi.fn(async () => ({
      chunkIndex: 0,
      chunkObjectId: 'chunk-object',
    })),
  } as unknown as HizoFSExtentIndex;
  const chunkStore = {
    readRange: vi.fn(() => {
      chunkReadStarted.resolve();
      return chunkRead.promise;
    }),
  } as unknown as HizoFSFileChunkStore;
  const file: LoadedHizoFSFile = {
    inodeObjectId: 'inode-object',
    inode: {
      nodeId: 'node-id',
      revision: 1,
      createdAt: null,
      modifiedAt: null,
      size: 4,
      storage: {
        type: 'extents',
        chunkSize: 4,
        extentIndexRootObjectId: 'extent-root',
      },
    },
    binaryPayload: new Uint8Array(),
  };
  const reader = new HizoFSFileReader({
    file,
    extentIndex,
    chunkStore,
    mimeType: 'application/octet-stream',
    streamChunkSize: 4,
    prefetchConcurrency: 1,
    maintenanceLease: { release } satisfies HizoFSMaintenanceLease,
    diagnostics: undefined,
    onSettled,
  });
  return {
    reader,
    chunkReadStarted: chunkReadStarted.promise,
    chunkRead,
    release,
    onSettled,
  };
}

describe('HizoFSFileReader lifecycle regressions', () => {
  it('keeps its maintenance lease until an active read settles after close', async () => {
    const { reader, chunkReadStarted, chunkRead, release, onSettled } =
      createBlockedExtentReader();
    const destination = new Uint8Array(4).fill(17);
    const read = reader.read({
      buffer: destination,
      offset: 0,
      length: destination.byteLength,
      position: 0,
      signal: undefined,
    });
    await chunkReadStarted;

    const close = reader.close();
    await Promise.resolve();
    expect(release).not.toHaveBeenCalled();

    const plaintext = new Uint8Array([1, 2, 3, 4]);
    chunkRead.resolve(plaintext);
    await expect(read).rejects.toThrow('closed');
    await close;

    expect(destination).toEqual(new Uint8Array(4).fill(17));
    expect(plaintext).toEqual(new Uint8Array(4));
    expect(release).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it('rejects an aborted read without exposing late plaintext and tracks cleanup', async () => {
    const { reader, chunkReadStarted, chunkRead, release } =
      createBlockedExtentReader();
    const destination = new Uint8Array(4).fill(29);
    const abortController = new AbortController();
    const read = reader.read({
      buffer: destination,
      offset: 0,
      length: destination.byteLength,
      position: 0,
      signal: abortController.signal,
    });
    await chunkReadStarted;

    abortController.abort(new DOMException('cancelled', 'AbortError'));
    await expect(read).rejects.toMatchObject({ name: 'AbortError' });
    expect(destination).toEqual(new Uint8Array(4).fill(29));

    const close = reader.close();
    await Promise.resolve();
    expect(release).not.toHaveBeenCalled();

    const plaintext = new Uint8Array([5, 6, 7, 8]);
    chunkRead.resolve(plaintext);
    await close;
    expect(plaintext).toEqual(new Uint8Array(4));
    expect(destination).toEqual(new Uint8Array(4).fill(29));
    expect(release).toHaveBeenCalledOnce();
  });

  it('cancels an in-flight stream read without releasing its lease early', async () => {
    const { reader, chunkReadStarted, chunkRead, release } =
      createBlockedExtentReader();
    const streamReader = reader.stream({
      start: 0,
      end: undefined,
      signal: undefined,
    }).getReader();
    const pendingRead = streamReader.read();
    await chunkReadStarted;

    await streamReader.cancel();
    await expect(pendingRead).resolves.toEqual({ done: true, value: undefined });
    const close = reader.close();
    await Promise.resolve();
    expect(release).not.toHaveBeenCalled();

    const plaintext = new Uint8Array([9, 10, 11, 12]);
    chunkRead.resolve(plaintext);
    await close;
    expect(plaintext).toEqual(new Uint8Array(4));
    expect(release).toHaveBeenCalledOnce();
  });
});

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
