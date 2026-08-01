import { describe, expect, it, vi } from 'vitest';
import { createBlobStorageBinaryObjectReadHandle } from '@/00-storage/service/binary-object-io';
import type { StorageFileHandle, StorageWritableFile } from './types';
import { writeStorageFileText, writeStorageReadableStream } from './io';

function createFileHandle({ writable }: {
  writable: StorageWritableFile;
}): StorageFileHandle {
  return {
    kind: 'file',
    name: 'value.bin',
    async stat() {
      return { size: 0, createdAt: undefined, modifiedAt: undefined };
    },
    async openReadable({ mimeType }) {
      return createBlobStorageBinaryObjectReadHandle({ blob: new Blob([]), mimeType });
    },
    async createWritable() {
      return writable;
    },
  };
}

function createWritable({ write, close, abort }: {
  write: StorageWritableFile['write'];
  close?: StorageWritableFile['close'];
  abort: StorageWritableFile['abort'];
}): StorageWritableFile {
  return {
    write,
    async truncate() {},
    close: close ?? (async () => {}),
    abort,
  };
}

describe('storage file-system write settlement', () => {
  it('preserves text write and writable abort failures in order', async () => {
    const writeFailure = new Error('text write failed');
    const abortFailure = new Error('text writable abort failed');
    const writable = createWritable({
      write: vi.fn(async () => {
        throw writeFailure;
      }),
      abort: vi.fn(async () => {
        throw abortFailure;
      }),
    });

    await expect(writeStorageFileText({
      fileHandle: createFileHandle({ writable }),
      value: 'value',
    })).rejects.toSatisfy((failure: unknown) => {
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([writeFailure, abortFailure]);
      return true;
    });
    expect(writable.abort).toHaveBeenCalledTimes(1);
  });

  it('preserves stream write, reader cancel, and writable abort failures in order', async () => {
    const writeFailure = new Error('stream write failed');
    const cancelFailure = new Error('source cancel failed');
    const abortFailure = new Error('stream writable abort failed');
    const writable = createWritable({
      write: vi.fn(async () => {
        throw writeFailure;
      }),
      abort: vi.fn(async () => {
        throw abortFailure;
      }),
    });
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        throw cancelFailure;
      },
    });

    await expect(writeStorageReadableStream({
      fileHandle: createFileHandle({ writable }),
      source,
      expectedSize: undefined,
      signal: undefined,
      onBytesWritten: undefined,
    })).rejects.toSatisfy((failure: unknown) => {
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([
        writeFailure,
        cancelFailure,
        abortFailure,
      ]);
      return true;
    });
    expect(writable.abort).toHaveBeenCalledTimes(1);
  });
});
