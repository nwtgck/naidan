import { describe, expect, it, vi } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import {
  createEncryptionMaterial,
  deriveEncryptedStoreRuntimeKeys,
} from './encryption-key-manager';
import {
  EncryptedObjectTransactionCoordinator,
} from './encrypted-object-transaction-coordinator';
import { EncryptedObjectStore } from './encrypted-object-store';

const UTF8 = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

async function createContext(): Promise<{
  objectStore: EncryptedObjectStore,
  coordinator: EncryptedObjectTransactionCoordinator,
}> {
  const material = await createEncryptionMaterial({
    passphrase: 'transaction test',
    pbkdf2Iterations: 10,
  });
  const keys = await deriveEncryptedStoreRuntimeKeys({
    storeRootKey: material.storeRootKey,
    encryptedStoreId: 'transaction-store',
  });
  const objectStore = new EncryptedObjectStore({
    storeDirectory: new MockFileSystemDirectoryHandle({ name: 'transaction-store' }),
    keys,
    area: 'durable',
  });
  return {
    objectStore,
    coordinator: new EncryptedObjectTransactionCoordinator({
      objectStore,
      scopeId: 'test-scope',
      lockName: `transaction-test-${crypto.randomUUID()}`,
    }),
  };
}

describe('EncryptedObjectTransactionCoordinator', () => {
  it('acknowledges durable journal intent and replays it before exposing subsequent reads', async () => {
    const { objectStore, coordinator } = await createContext();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cleanupAfterCommit = vi.fn(async () => undefined);
    const originalWrite = objectStore.write.bind(objectStore);
    let injectedFailure = true;
    const writeSpy = vi.spyOn(objectStore, 'write').mockImplementation(async (args) => {
      if (
        injectedFailure
        && args.locator.namespace === 'test_data'
        && args.locator.key === 'second'
      ) {
        injectedFailure = false;
        throw new Error('injected write interruption');
      }
      await originalWrite(args);
    });

    await expect(coordinator.mutate({
      prepare: async () => ({
        operations: [
          {
            type: 'write',
            locator: { namespace: 'test_data', key: 'first' },
            plaintext: UTF8.encode('first value'),
          },
          {
            type: 'write',
            locator: { namespace: 'test_data', key: 'second' },
            plaintext: UTF8.encode('second value'),
          },
        ],
        cleanupAfterCommit,
      }),
      result: async () => 'committed',
    })).resolves.toBe('committed');

    expect(warn).toHaveBeenCalledWith(
      'Encrypted object mutation is committed and pending recovery',
      expect.objectContaining({ message: 'injected write interruption' }),
    );
    expect(cleanupAfterCommit).not.toHaveBeenCalled();
    await expect(objectStore.read({
      locator: { namespace: 'object_transaction_journal', key: 'test-scope' },
    })).resolves.toBeDefined();
    writeSpy.mockRestore();

    const recoveredCoordinator = new EncryptedObjectTransactionCoordinator({
      objectStore,
      scopeId: 'test-scope',
      lockName: `transaction-recovery-${crypto.randomUUID()}`,
    });
    const values = await recoveredCoordinator.read({
      run: async () => await Promise.all([
        objectStore.read({ locator: { namespace: 'test_data', key: 'first' } }),
        objectStore.read({ locator: { namespace: 'test_data', key: 'second' } }),
      ]),
    });

    expect(values.map(value => UTF8_DECODER.decode(value))).toEqual([
      'first value',
      'second value',
    ]);
    await expect(objectStore.read({
      locator: { namespace: 'object_transaction_journal', key: 'test-scope' },
    })).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it('serializes asynchronous mutations for the same lock name', async () => {
    const { objectStore } = await createContext();
    const lockName = `serialized-transaction-${crypto.randomUUID()}`;
    const firstCoordinator = new EncryptedObjectTransactionCoordinator({
      objectStore,
      scopeId: 'serialized-scope',
      lockName,
    });
    const secondCoordinator = new EncryptedObjectTransactionCoordinator({
      objectStore,
      scopeId: 'serialized-scope',
      lockName,
    });
    let releaseFirst: (() => void) | undefined;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];

    const first = firstCoordinator.mutate({
      prepare: async () => {
        order.push('first-started');
        await firstCanFinish;
        order.push('first-prepared');
        return { operations: [] };
      },
      result: async () => {
        order.push('first-finished');
      },
    });
    await vi.waitFor(() => {
      expect(order).toContain('first-started');
    });

    const second = secondCoordinator.mutate({
      prepare: async () => {
        order.push('second-started');
        return { operations: [] };
      },
      result: async () => {
        order.push('second-finished');
      },
    });
    await Promise.resolve();
    expect(order).toEqual(['first-started']);

    releaseFirst?.();
    await Promise.all([first, second]);

    expect(order).toEqual([
      'first-started',
      'first-prepared',
      'first-finished',
      'second-started',
      'second-finished',
    ]);
  });

  it('does not report a committed mutation as failed when orphan cleanup fails', async () => {
    const { objectStore, coordinator } = await createContext();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(coordinator.mutate({
      prepare: async () => ({
        operations: [{
          type: 'write',
          locator: { namespace: 'test_data', key: 'committed' },
          plaintext: UTF8.encode('committed value'),
        }],
        cleanupAfterCommit: async () => {
          throw new Error('injected cleanup failure');
        },
      }),
      result: async () => 'success',
    })).resolves.toBe('success');

    expect(warn).toHaveBeenCalledOnce();
    const bytes = await objectStore.read({
      locator: { namespace: 'test_data', key: 'committed' },
    });
    expect(UTF8_DECODER.decode(bytes)).toBe('committed value');
    warn.mockRestore();
  });

  it('completes a mutation when a journal close error follows a durable write', async () => {
    const { objectStore, coordinator } = await createContext();
    const originalWrite = objectStore.write.bind(objectStore);
    const cleanupAfterFailure = vi.fn(async () => undefined);
    let failAfterJournalCommit = true;
    const writeSpy = vi.spyOn(objectStore, 'write').mockImplementation(async (args) => {
      await originalWrite(args);
      if (
        failAfterJournalCommit
        && args.locator.namespace === 'object_transaction_journal'
      ) {
        failAfterJournalCommit = false;
        throw new Error('injected ambiguous journal close failure');
      }
    });

    await expect(coordinator.mutate({
      prepare: async () => ({
        operations: [{
          type: 'write',
          locator: { namespace: 'test_data', key: 'recoverable' },
          plaintext: UTF8.encode('recoverable value'),
        }],
        cleanupAfterFailure,
      }),
      result: async () => 'completed',
    })).resolves.toBe('completed');

    expect(cleanupAfterFailure).not.toHaveBeenCalled();
    writeSpy.mockRestore();

    const bytes = await objectStore.read({
      locator: { namespace: 'test_data', key: 'recoverable' },
    });
    expect(UTF8_DECODER.decode(bytes)).toBe('recoverable value');
    await expect(objectStore.read({
      locator: { namespace: 'object_transaction_journal', key: 'test-scope' },
    })).resolves.toBeUndefined();
  });
});
