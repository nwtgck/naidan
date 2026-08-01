import { describe, expect, it, vi } from 'vitest';
import {
  createBrowserNaidanPersistenceControlExclusiveGate,
  TEST_ONLY,
} from '@/00-storage/service/naidan-opfs/persistence-control-exclusive-gate';

describe('Persistence Control exclusive gate', () => {
  it('runs under the fixed cross-realm authority lock', async () => {
    const operation = vi.fn(async () => 'completed');
    const request: LockManager['request'] = async <T>(
      name: string,
      optionsOrCallback: LockOptions | LockGrantedCallback<T>,
      callback?: LockGrantedCallback<T>,
    ): Promise<Awaited<T>> => {
      if (typeof optionsOrCallback === 'function' || callback === undefined) {
        throw new Error('Expected the options overload');
      }
      expect(name).toBe(TEST_ONLY.persistenceControlAuthorityLockName);
      expect(optionsOrCallback).toEqual({ mode: 'exclusive' });
      return await callback({ mode: 'exclusive', name } as Lock);
    };
    const gate = createBrowserNaidanPersistenceControlExclusiveGate({
      lockManager: { request },
    });

    await expect(gate.runExclusive({ operation })).resolves.toBe('completed');
    expect(operation).toHaveBeenCalledOnce();
  });

  it('does not run when the authority lock is not acquired', async () => {
    const operation = vi.fn(async () => undefined);
    const request: LockManager['request'] = async <T>(
      _name: string,
      optionsOrCallback: LockOptions | LockGrantedCallback<T>,
      callback?: LockGrantedCallback<T>,
    ): Promise<Awaited<T>> => {
      if (typeof optionsOrCallback === 'function' || callback === undefined) {
        throw new Error('Expected the options overload');
      }
      return await callback(null);
    };
    const gate = createBrowserNaidanPersistenceControlExclusiveGate({
      lockManager: { request },
    });

    await expect(gate.runExclusive({ operation })).rejects.toThrow(
      'Persistence Control authority lock was not acquired',
    );
    expect(operation).not.toHaveBeenCalled();
  });
});
