import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireHizoFSMaintenanceLease,
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
      instanceId: 'AAAAAAAAAAAAAAAAAAAAAA',
    })).rejects.toBe(failure);
  });

  it('rejects non-canonical identities before requesting a Web Lock', async () => {
    const request = vi.fn();
    vi.stubGlobal('navigator', { locks: { request } });

    await expect(acquireHizoFSResourceLease({
      instanceId: '../shared-maintenance-lock',
    })).rejects.toThrow('instanceId must be canonical Base64URL');
    await expect(acquireHizoFSSubvolumeRuntimePin({
      instanceId: 'AAAAAAAAAAAAAAAAAAAAAA',
      subvolumeId: '../shared-subvolume',
      subvolumeDescriptorObjectId: 'metadata/0/0',
    })).rejects.toThrow('subvolumeId must be canonical Base64URL');
    expect(request).not.toHaveBeenCalled();
  });

  it('removes an aborted exclusive waiter without blocking later foreground leases', async () => {
    vi.stubGlobal('navigator', {});
    const instanceId = 'AAAAAAAAAAAAAAAAAAAAAA';
    const activeResource = await acquireHizoFSResourceLease({ instanceId });
    const abortController = new AbortController();
    const maintenance = acquireHizoFSMaintenanceLease({
      instanceId,
      signal: abortController.signal,
    });
    abortController.abort(new DOMException('cancelled', 'AbortError'));
    await expect(maintenance).rejects.toMatchObject({ name: 'AbortError' });

    const laterResource = await acquireHizoFSResourceLease({ instanceId });
    await laterResource.release();
    await activeResource.release();
  });

  it('retains a subvolume while a shared runtime pin is active', async () => {
    vi.stubGlobal('navigator', {});
    const input = {
      instanceId: 'AAAAAAAAAAAAAAAAAAAAAA',
      subvolumeId: 'AQEBAQEBAQEBAQEBAQEBAQ',
      subvolumeDescriptorObjectId: 'metadata/0/0',
    } as const;
    const pin = await acquireHizoFSSubvolumeRuntimePin(input);
    try {
      await expect(listHizoFSActiveSubvolumeRuntimePins({
        instanceId: input.instanceId,
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
