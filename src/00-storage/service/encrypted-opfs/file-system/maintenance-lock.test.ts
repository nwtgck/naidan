import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireEncryptedOpfsSessionLease } from './maintenance-lock';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('EncryptedOpfs maintenance lock', () => {
  it('rejects instead of waiting forever when Web Locks fails before acquisition', async () => {
    const failure = new Error('Web Locks unavailable');
    vi.stubGlobal('navigator', {
      locks: {
        request: vi.fn().mockRejectedValue(failure),
      },
    });

    await expect(acquireEncryptedOpfsSessionLease({
      fileSystemId: 'AAAAAAAAAAAAAAAAAAAAAA',
    })).rejects.toBe(failure);
  });
});
