import { describe, expect, it, vi } from 'vitest';
import type { WeshCommandContext, WeshFileHandle } from '@/services/wesh/types';
import {
  createWeshZipByteSink,
  createWeshZipCentralDirectoryStore,
  createWeshZipRandomAccessSource,
} from './zip-stream';

function createBaseHandle({
  read,
  write,
  size,
}: {
  read: WeshFileHandle['read'],
  write: WeshFileHandle['write'],
  size: number,
}): WeshFileHandle {
  return {
    read,
    write,
    close: vi.fn(async () => {}),
    stat: vi.fn(async () => ({
      size,
      mode: 0,
      type: 'file' as const,
      mtime: 0,
      ino: 0,
      uid: 0,
      gid: 0,
    })),
    truncate: vi.fn(async () => {}),
    ioctl: vi.fn(async () => ({ ret: 0 })),
  };
}

describe('Wesh ZIP adapters', () => {
  it('writes the original chunk directly while completing partial writes', async () => {
    const chunk = new Uint8Array([1, 2, 3, 4, 5]);
    const calls: Array<{ buffer: Uint8Array, offset: number, length: number }> = [];
    const handle = createBaseHandle({
      size: 0,
      read: vi.fn(async () => ({ bytesRead: 0 })),
      write: vi.fn(async ({ buffer, offset = 0, length = buffer.byteLength - offset }) => {
        calls.push({ buffer, offset, length });
        return { bytesWritten: Math.min(2, length) };
      }),
    });

    await createWeshZipByteSink({ handle }).write({ chunk });

    expect(calls.map(call => ({ offset: call.offset, length: call.length }))).toEqual([
      { offset: 0, length: 5 },
      { offset: 2, length: 3 },
      { offset: 4, length: 1 },
    ]);
    expect(calls.every(call => call.buffer === chunk)).toBe(true);
  });

  it('fills requested ranges across partial reads and closes the handle', async () => {
    const bytes = new Uint8Array([10, 11, 12, 13, 14, 15]);
    const handle = createBaseHandle({
      size: bytes.byteLength,
      write: vi.fn(async () => ({ bytesWritten: 0 })),
      read: vi.fn(async ({ buffer, offset = 0, length = buffer.byteLength - offset, position = 0 }) => {
        const bytesRead = Math.min(2, length, bytes.byteLength - position);
        buffer.set(bytes.subarray(position, position + bytesRead), offset);
        return { bytesRead };
      }),
    });

    const source = await createWeshZipRandomAccessSource({ handle });
    expect(await source.read({ offset: 1, length: 4 })).toEqual(new Uint8Array([11, 12, 13, 14]));
    await source.close();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it('rejects invalid partial-write and partial-read progress', async () => {
    for (const bytesWritten of [2, Number.NaN, 0.5]) {
      const handle = createBaseHandle({
        size: 0,
        read: vi.fn(async () => ({ bytesRead: 0 })),
        write: vi.fn(async () => ({ bytesWritten })),
      });
      await expect(createWeshZipByteSink({ handle }).write({
        chunk: new Uint8Array([1]),
      })).rejects.toThrow('invalid progress');
    }

    for (const bytesRead of [2, Number.NaN, 0.5]) {
      const handle = createBaseHandle({
        size: 1,
        read: vi.fn(async () => ({ bytesRead })),
        write: vi.fn(async () => ({ bytesWritten: 0 })),
      });
      const source = await createWeshZipRandomAccessSource({ handle });
      await expect(source.read({ offset: 0, length: 1 })).rejects.toThrow('invalid progress');
    }
  });

  it('closes the handle when source metadata cannot be read', async () => {
    const handle = createBaseHandle({
      size: 0,
      read: vi.fn(async () => ({ bytesRead: 0 })),
      write: vi.fn(async () => ({ bytesWritten: 0 })),
    });
    vi.mocked(handle.stat).mockRejectedValueOnce(new Error('stat failed'));

    await expect(createWeshZipRandomAccessSource({ handle })).rejects.toThrow('stat failed');
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it('continues central-directory cleanup and allows retry after close failure', async () => {
    const handle = createBaseHandle({
      size: 0,
      read: vi.fn(async () => ({ bytesRead: 0 })),
      write: vi.fn(async ({ length = 0 }) => ({ bytesWritten: length })),
    });
    vi.mocked(handle.close)
      .mockRejectedValueOnce(new Error('close failed'))
      .mockResolvedValueOnce();
    const unlink = vi.fn(async () => {});
    const files = { unlink } as unknown as WeshCommandContext['files'];
    const store = createWeshZipCentralDirectoryStore({
      files,
      path: '/tmp/central',
      handle,
    });

    await expect(store.dispose()).rejects.toThrow('close failed');
    expect(unlink).toHaveBeenCalledOnce();
    await expect(store.dispose()).resolves.toBeUndefined();
    expect(handle.close).toHaveBeenCalledTimes(2);
    expect(unlink).toHaveBeenCalledTimes(2);
  });

  it('rejects zero-progress writes and reads', async () => {
    const writeHandle = createBaseHandle({
      size: 0,
      read: vi.fn(async () => ({ bytesRead: 0 })),
      write: vi.fn(async () => ({ bytesWritten: 0 })),
    });
    await expect(createWeshZipByteSink({ handle: writeHandle }).write({
      chunk: new Uint8Array([1]),
    })).rejects.toThrow('invalid progress');

    const readHandle = createBaseHandle({
      size: 1,
      read: vi.fn(async () => ({ bytesRead: 0 })),
      write: vi.fn(async () => ({ bytesWritten: 0 })),
    });
    const source = await createWeshZipRandomAccessSource({ handle: readHandle });
    await expect(source.read({ offset: 0, length: 1 })).rejects.toThrow('invalid progress');
  });
});
