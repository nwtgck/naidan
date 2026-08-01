import { describe, expect, it, vi } from 'vitest';
import {
  createBlobStorageBinaryObjectReadHandle,
  runWithStorageBinaryObjectReadHandleClose,
} from './binary-object-io';

function createReadable({ close }: {
  close: () => Promise<void>;
}) {
  return {
    ...createBlobStorageBinaryObjectReadHandle({
      blob: new Blob([], { type: 'application/octet-stream' }),
      mimeType: 'application/octet-stream',
    }),
    close,
  };
}

describe('storage binary object read-handle settlement', () => {
  it('preserves operation and close failures in order', async () => {
    const operationFailure = new Error('read operation failed');
    const closeFailure = new Error('read handle close failed');
    const handle = createReadable({
      close: vi.fn(async () => {
        throw closeFailure;
      }),
    });

    await expect(runWithStorageBinaryObjectReadHandleClose({
      handle,
      operation: async () => {
        throw operationFailure;
      },
    })).rejects.toSatisfy((failure: unknown) => {
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([operationFailure, closeFailure]);
      return true;
    });
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it('preserves a single operation failure identity', async () => {
    const operationFailure = new Error('read operation failed');
    const handle = createReadable({ close: vi.fn(async () => {}) });

    await expect(runWithStorageBinaryObjectReadHandleClose({
      handle,
      operation: async () => {
        throw operationFailure;
      },
    })).rejects.toBe(operationFailure);
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it('rejects a close failure after a successful operation', async () => {
    const closeFailure = new Error('read handle close failed');
    const handle = createReadable({
      close: vi.fn(async () => {
        throw closeFailure;
      }),
    });

    await expect(runWithStorageBinaryObjectReadHandleClose({
      handle,
      operation: async () => 'value',
    })).rejects.toBe(closeFailure);
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it('returns the operation value after successful cleanup', async () => {
    const handle = createReadable({ close: vi.fn(async () => {}) });

    await expect(runWithStorageBinaryObjectReadHandleClose({
      handle,
      operation: async () => 'value',
    })).resolves.toBe('value');
    expect(handle.close).toHaveBeenCalledTimes(1);
  });
});
