import { beforeEach, describe, expect, it } from 'vitest';
import { TEST_ONLY as RUNTIME_CONTRACT_TEST_ONLY } from '@/00-storage/service/naidan-opfs/persistence-runtime-contract';
import {
  installActiveAuthenticatedHizoFSContainerLocation,
  openActiveAuthenticatedHizoFSContainerLocationLease,
  TEST_ONLY,
} from '@/00-storage/service/naidan-opfs/active-hizofs-container-location';
import { naidanOpfsContainerOriginRelativePathComponents } from '@/00-storage/service/naidan-opfs/opfs-storage-location';

function fileSystemId({ value }: { value: string }) {
  return RUNTIME_CONTRACT_TEST_ONLY.createEncryptedInspection({ fileSystemId: value }).mode.activeFileSystemId;
}

describe('active authenticated HizoFS container location', () => {
  beforeEach(() => {
    TEST_ONLY.reset();
  });

  it('leases a detached canonical path only while its provider generation is active', async () => {
    const activeFileSystemId = fileSystemId({ value: '0123456789_ABCDEFGHIJ' });
    const uninstall = installActiveAuthenticatedHizoFSContainerLocation({ fileSystemId: activeFileSystemId });
    const lease = await openActiveAuthenticatedHizoFSContainerLocationLease();

    expect(lease.physicalPath).toEqual(
      naidanOpfsContainerOriginRelativePathComponents({ fileSystemId: activeFileSystemId }),
    );
    expect(() => lease.assertCurrent()).not.toThrow();

    uninstall();
    expect(() => lease.assertCurrent()).toThrow('no longer current');
    await expect(openActiveAuthenticatedHizoFSContainerLocationLease()).rejects.toThrow('unavailable');
  });

  it('invalidates an old lease without letting late cleanup remove a newer generation', async () => {
    const first = fileSystemId({ value: 'ABCDEFGHIJ_0123456789' });
    const second = fileSystemId({ value: 'ZYXWVUTSRQ_9876543210' });
    const uninstallFirst = installActiveAuthenticatedHizoFSContainerLocation({ fileSystemId: first });
    const firstLease = await openActiveAuthenticatedHizoFSContainerLocationLease();
    const uninstallSecond = installActiveAuthenticatedHizoFSContainerLocation({ fileSystemId: second });
    const secondLease = await openActiveAuthenticatedHizoFSContainerLocationLease();

    expect(() => firstLease.assertCurrent()).toThrow('no longer current');
    expect(() => secondLease.assertCurrent()).not.toThrow();
    uninstallFirst();
    expect(() => secondLease.assertCurrent()).not.toThrow();

    uninstallSecond();
    expect(() => secondLease.assertCurrent()).toThrow('no longer current');
  });

  it('rejects use after the caller disposes its lease', async () => {
    installActiveAuthenticatedHizoFSContainerLocation({
      fileSystemId: fileSystemId({ value: 'LMNOPQRSTU_1234567890' }),
    });
    const lease = await openActiveAuthenticatedHizoFSContainerLocationLease();
    await lease.dispose();
    expect(() => lease.assertCurrent()).toThrow('lease is disposed');
  });
});
