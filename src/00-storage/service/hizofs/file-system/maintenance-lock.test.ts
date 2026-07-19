import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireHizoFSResourceLease,
  acquireHizoFSSubvolumeRuntimePin,
  listHizoFSActiveSubvolumeRuntimePins,
  tryAcquireHizoFSSubvolumeRuntimePinExclusively,
} from './maintenance-lock';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HizoFS maintenance lock', () => {
  it('rejects instead of waiting forever when Web Locks fails before acquisition', async () => {
    const failure = new Error('Web Locks unavailable');
    vi.stubGlobal('navigator', {
      locks: {
        request: vi.fn().mockRejectedValue(failure),
      },
    });

    await expect(acquireHizoFSResourceLease({
      fileSystemId: 'AAAAAAAAAAAAAAAAAAAAAA',
    })).rejects.toBe(failure);
  });

  it('retains a subvolume while a shared runtime pin is active', async () => {
    vi.stubGlobal('navigator', {});
    const input = {
      fileSystemId: 'AAAAAAAAAAAAAAAAAAAAAA',
      subvolumeId: 'BBBBBBBBBBBBBBBBBBBBBB',
      subvolumeDescriptorObjectId: 'metadata/0/0',
    } as const;
    const pin = await acquireHizoFSSubvolumeRuntimePin(input);
    try {
      await expect(listHizoFSActiveSubvolumeRuntimePins({
        fileSystemId: input.fileSystemId,
      })).resolves.toEqual([{
        subvolumeId: input.subvolumeId,
        subvolumeDescriptorObjectId: input.subvolumeDescriptorObjectId,
      }]);
      await expect(
        tryAcquireHizoFSSubvolumeRuntimePinExclusively(input),
      ).resolves.toBeUndefined();
    } finally {
      await pin.release();
    }

    const exclusivePin = await tryAcquireHizoFSSubvolumeRuntimePinExclusively(input);
    expect(exclusivePin).toBeDefined();
    await exclusivePin?.release();
  });
});
