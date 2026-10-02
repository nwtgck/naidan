import { describe, expect, it, vi } from 'vitest';
import type { StorageBinaryObjectReadHandle } from './binary-object-io';
import type { StorageDirectoryHandle, StorageFileHandle } from './storage-file-system/types';
import {
  createDirectStorageDirectoryTransferTarget,
  createStorageFileSystemDirectoryTransferSource,
  createStorageFileSystemDirectoryTransferTarget,
} from './storage-directory-transfer';

async function openTransfer({ stream, close }: {
  stream: StorageBinaryObjectReadHandle['stream'];
  close: StorageBinaryObjectReadHandle['close'];
}): Promise<ReadableStream<Uint8Array>> {
  const unused = async (): Promise<never> => {
    throw new Error('unexpected fixture operation');
  };
  const file: StorageFileHandle = {
    kind: 'file',
    name: 'file',
    stat: async () => ({ size: 8, createdAt: undefined, modifiedAt: undefined }),
    createWritable: unused,
    openReadable: async ({ mimeType }) => ({
      backing: { type: 'reader_only' },
      size: 8,
      mimeType,
      read: unused,
      stream,
      close,
    }),
  };
  const root: StorageDirectoryHandle = {
    kind: 'directory',
    name: '',
    stat: unused,
    getFileHandle: unused,
    getDirectoryHandle: unused,
    getEntryHandle: unused,
    async *entries() {
      yield ['file', file] as const;
    },
    removeEntry: unused,
    createSymlink: unused,
    moveEntry: unused,
    cloneFile: unused,
  };
  const source = createStorageFileSystemDirectoryTransferSource({ root });
  for await (const entry of source.readDirectory({ path: '/' })) {
    if (entry.type === 'file') return await entry.open();
  }
  throw new Error('expected file entry');
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 32; index += 1) await Promise.resolve();
}

function createTargetFixture({ type }: { type: 'direct' | 'storage' }) {
  const unused = async (): Promise<never> => {
    throw new Error('unexpected fixture operation');
  };
  const write = vi.fn(async () => undefined);
  const abort = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  const createWritable = vi.fn(async () => ({ read: undefined, write, abort, close, truncate: unused }));
  const file: StorageFileHandle = {
    kind: 'file', name: 'file', stat: unused, openReadable: unused, createWritable,
  };
  const getFileHandle = vi.fn(async () => file);
  const getDirectoryHandle = vi.fn(async (): Promise<StorageDirectoryHandle> => root);
  const root: StorageDirectoryHandle = {
    kind: 'directory', name: '', stat: unused, getFileHandle, getDirectoryHandle,
    getEntryHandle: unused, async *entries() {
      yield* [];
    }, removeEntry: unused,
    createSymlink: unused, moveEntry: unused, cloneFile: unused,
  };
  // These lookup doubles ignore the native and storage APIs' different arguments.
  const target = type === 'direct'
    ? createDirectStorageDirectoryTransferTarget({ root: root as unknown as FileSystemDirectoryHandle })
    : createStorageFileSystemDirectoryTransferTarget({ root });
  return { target, getDirectoryHandle, getFileHandle, createWritable, write, abort, close };
}

describe('storage-directory transfer target setup', () => {
  it.each([
    ['direct', 'directory'], ['direct', 'file'], ['direct', 'writer'],
    ['storage', 'directory'], ['storage', 'file'], ['storage', 'writer'],
  ] as const)('releases the unread source after %s %s acquisition fails', async (type, phase) => {
    const failure = new Error(`${phase} failed`);
    const target = createTargetFixture({ type });
    switch (phase) {
    case 'directory': target.getDirectoryHandle.mockRejectedValue(failure); break;
    case 'file': target.getFileHandle.mockRejectedValue(failure); break;
    case 'writer': target.createWritable.mockRejectedValue(failure); break;
    default: phase satisfies never;
    }
    const cancel = vi.fn();
    const upstream = new ReadableStream<Uint8Array>({ cancel });
    const close = vi.fn(async () => undefined);
    const source = await openTransfer({ stream: () => upstream, close });

    await expect(target.target.writeFile({
      path: '/parent/file', size: 8, modifiedAt: 0, source, signal: undefined,
    })).rejects.toBe(failure);

    expect(cancel).toHaveBeenCalledExactlyOnceWith(failure);
    expect(close).toHaveBeenCalledOnce();
    expect(upstream.locked).toBe(false);
    expect(source.locked).toBe(false);
    expect(target.write).not.toHaveBeenCalled();
    expect(target.abort).not.toHaveBeenCalled();
  });

  it.each(['direct', 'storage'] as const)('cancels the source when a %s target rejects an empty file path', async type => {
    const target = createTargetFixture({ type });
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel });
    await expect(target.target.writeFile({
      path: '/', size: 0, modifiedAt: 0, source, signal: undefined,
    })).rejects.toThrow('name');
    expect(cancel).toHaveBeenCalledOnce();
    expect(target.getFileHandle).not.toHaveBeenCalled();
  });

  it.each(['direct', 'storage'] as const)('leaves a separately owned source reader alone after %s lookup fails', async type => {
    const target = createTargetFixture({ type });
    const failure = new Error('lookup failed');
    target.getFileHandle.mockRejectedValue(failure);
    const cancel = vi.fn();
    const bytes = Uint8Array.of(1);
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
      }, cancel,
    });
    const owner = source.getReader();
    try {
      await expect(target.target.writeFile({
        path: '/file', size: 1, modifiedAt: 0, source, signal: undefined,
      })).rejects.toBe(failure);
      expect(cancel).not.toHaveBeenCalled();
      expect(source.locked).toBe(true);
      await expect(owner.read()).resolves.toEqual({ done: false, value: bytes });
    } finally {
      owner.releaseLock();
    }
  });

  it.each([
    { primary: new Error('lookup failed'), cleanup: new Error('cancel failed') },
    { primary: undefined, cleanup: undefined },
  ])('retains setup and cancellation failures in order: $primary / $cleanup', async ({ primary, cleanup }) => {
    const target = createTargetFixture({ type: 'storage' });
    target.getFileHandle.mockRejectedValue(primary);
    const cancel = vi.fn(async () => {
      throw cleanup;
    });
    const upstream = new ReadableStream<Uint8Array>({ cancel });
    const close = vi.fn(async () => undefined);
    const source = await openTransfer({ stream: () => upstream, close });
    const [outcome] = await Promise.allSettled([target.target.writeFile({
      path: '/file', size: 8, modifiedAt: 0, source, signal: undefined,
    })]);
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') throw new Error('expected setup failure');
    expect(outcome.reason).toBeInstanceOf(AggregateError);
    expect((outcome.reason as AggregateError).errors).toEqual([primary, cleanup]);
    expect(close).toHaveBeenCalledOnce();
    expect(upstream.locked).toBe(false);
  });

  it('waits for read-handle cleanup before reporting setup failure', async () => {
    const target = createTargetFixture({ type: 'storage' });
    const failure = new Error('lookup failed');
    target.getFileHandle.mockRejectedValue(failure);
    const closeStarted = Promise.withResolvers<void>();
    const closeFinished = Promise.withResolvers<void>();
    const source = await openTransfer({
      stream: () => new ReadableStream<Uint8Array>(),
      close: async () => {
        closeStarted.resolve(); await closeFinished.promise;
      },
    });
    let settled = false;
    const result = target.target.writeFile({
      path: '/file', size: 8, modifiedAt: 0, source, signal: undefined,
    }).then(() => {
      settled = true;
    }, error => {
      settled = true; return error;
    });
    await Promise.race([closeStarted.promise, result]);
    try {
      expect(settled).toBe(false);
    } finally {
      closeFinished.resolve();
    }
    await expect(result).resolves.toBe(failure);
  });

  it('releases a direct target source when already aborted before writer acquisition', async () => {
    const target = createTargetFixture({ type: 'direct' });
    const reason = new Error('cancel before writer acquisition');
    const controller = new AbortController();
    controller.abort(reason);
    const cancel = vi.fn();
    const close = vi.fn(async () => undefined);
    const source = await openTransfer({ stream: () => new ReadableStream<Uint8Array>({ cancel }), close });
    await expect(target.target.writeFile({
      path: '/file', size: 8, modifiedAt: 0, source, signal: controller.signal,
    })).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
    expect(close).toHaveBeenCalledOnce();
    expect(target.createWritable).not.toHaveBeenCalled();
  });

  it.each(['direct', 'storage'] as const)('keeps the %s writer cleanup as the only owner after writing begins', async type => {
    const target = createTargetFixture({ type });
    const failure = new Error('write failed');
    target.write.mockRejectedValue(failure);
    const cancel = vi.fn();
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8));
      }, cancel,
    });
    const close = vi.fn(async () => undefined);
    const source = await openTransfer({ stream: () => upstream, close });
    await expect(target.target.writeFile({
      path: '/file', size: 8, modifiedAt: 0, source, signal: undefined,
    })).rejects.toBe(failure);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(failure);
    expect(close).toHaveBeenCalledOnce();
    expect(target.abort).toHaveBeenCalledOnce();
    expect(target.close).not.toHaveBeenCalled();
    expect(upstream.locked).toBe(false);
  });
});

describe('storage-directory transfer source', () => {
  it('preserves chunks without pumping an unconsumed file to EOF', async () => {
    const chunks = Array.from({ length: 8 }, (_, index) => Uint8Array.of(index));
    let produced = 0;
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[produced];
        if (chunk === undefined) controller.close();
        else {
          produced += 1;
          controller.enqueue(chunk);
        }
      },
    });
    const close = vi.fn(async () => undefined);
    const transferred = await openTransfer({ stream: () => upstream, close });
    await flushMicrotasks();
    expect(produced).toBeLessThanOrEqual(2);
    expect(close).not.toHaveBeenCalled();

    const reader = transferred.getReader();
    for (const chunk of chunks) {
      const result = await reader.read();
      expect(result.done).toBe(false);
      expect(result.value).toBe(chunk);
    }
    await expect(reader.read()).resolves.toMatchObject({ done: true });
    expect(close).toHaveBeenCalledOnce();
    expect(upstream.locked).toBe(false);
    reader.releaseLock();
  });

  it('cancels a pending read, releases its reader and waits for one handle cleanup', async () => {
    const readStarted = Promise.withResolvers<void>();
    const readGate = Promise.withResolvers<void>();
    const closeGate = Promise.withResolvers<void>();
    let upstreamCancelled = false;
    const cancel = vi.fn(async () => {
      upstreamCancelled = true;
    });
    const upstream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        readStarted.resolve();
        await readGate.promise;
        if (!upstreamCancelled) {
          controller.enqueue(Uint8Array.of(1));
          controller.close();
        }
      },
      cancel,
    });
    const close = vi.fn(async () => await closeGate.promise);
    const transferred = await openTransfer({ stream: () => upstream, close });
    await readStarted.promise;
    const reason = new Error('consumer cancelled');
    let settled = false;
    const cancellation = transferred.cancel(reason).then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
    expect(close).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    closeGate.resolve();
    await cancellation;
    expect(upstream.locked).toBe(false);
    readGate.resolve();
    await flushMicrotasks();
    expect(close).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not finish EOF before cleanup and shares cleanup with concurrent cancellation', async () => {
    const closeStarted = Promise.withResolvers<void>();
    const closeGate = Promise.withResolvers<void>();
    const upstream = new ReadableStream<Uint8Array>({ start: controller => controller.close() });
    const close = vi.fn(async () => {
      closeStarted.resolve();
      await closeGate.promise;
    });
    const transferred = await openTransfer({ stream: () => upstream, close });
    const reader = transferred.getReader();
    let eofSettled = false;
    const eof = reader.read().then(result => {
      eofSettled = true;
      return result;
    });
    await closeStarted.promise;
    await flushMicrotasks();
    expect(eofSettled).toBe(false);
    const cancellation = reader.cancel('cancel during cleanup');
    closeGate.resolve();
    await cancellation;
    await expect(eof).resolves.toMatchObject({ done: true });
    expect(close).toHaveBeenCalledOnce();
    expect(upstream.locked).toBe(false);
    reader.releaseLock();
  });

  it.each(['success', 'failure'] as const)('preserves source failure with cleanup %s', async cleanup => {
    const sourceFailure = new Error('source read failed');
    const closeFailure = new Error('read handle close failed');
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(sourceFailure);
      },
    });
    const close = vi.fn(async () => {
      if (cleanup === 'failure') throw closeFailure;
    });
    const transferred = await openTransfer({ stream: () => upstream, close });
    const reader = transferred.getReader();
    const [outcome] = await Promise.allSettled([reader.read()]);
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') throw new Error('expected source failure');
    if (cleanup === 'success') expect(outcome.reason).toBe(sourceFailure);
    else expect((outcome.reason as AggregateError).errors).toEqual([sourceFailure, closeFailure]);
    expect(close).toHaveBeenCalledOnce();
    expect(upstream.locked).toBe(false);
    reader.releaseLock();
  });

  it('surfaces EOF cleanup failure instead of reporting successful completion', async () => {
    const closeFailure = new Error('read handle close failed');
    const upstream = new ReadableStream<Uint8Array>({ start: controller => controller.close() });
    const close = vi.fn(async () => {
      throw closeFailure;
    });
    const transferred = await openTransfer({ stream: () => upstream, close });
    const reader = transferred.getReader();
    await expect(reader.read()).rejects.toBe(closeFailure);
    expect(close).toHaveBeenCalledOnce();
    expect(upstream.locked).toBe(false);
    reader.releaseLock();
  });

  it('attempts handle cleanup even when upstream cancellation fails', async () => {
    const cancelFailure = new Error('source cancel failed');
    const closeFailure = new Error('read handle close failed');
    const cancel = vi.fn(async () => {
      throw cancelFailure;
    });
    const upstream = new ReadableStream<Uint8Array>({ cancel });
    const close = vi.fn(async () => {
      throw closeFailure;
    });
    const transferred = await openTransfer({ stream: () => upstream, close });
    const [outcome] = await Promise.allSettled([transferred.cancel('stop')]);
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') throw new Error('expected cleanup failure');
    expect((outcome.reason as AggregateError).errors).toEqual([cancelFailure, closeFailure]);
    expect(cancel).toHaveBeenCalledExactlyOnceWith('stop');
    expect(close).toHaveBeenCalledOnce();
    expect(upstream.locked).toBe(false);
  });

  it('closes an acquired handle when stream setup fails', async () => {
    const sourceFailure = new Error('stream setup failed');
    const closeFailure = new Error('read handle close failed');
    const close = vi.fn(async () => {
      throw closeFailure;
    });
    const [outcome] = await Promise.allSettled([openTransfer({
      stream: () => {
        throw sourceFailure;
      },
      close,
    })]);
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') throw new Error('expected setup failure');
    expect((outcome.reason as AggregateError).errors).toEqual([sourceFailure, closeFailure]);
    expect(close).toHaveBeenCalledOnce();
  });
});
