import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageDirectoryHandle } from '@/00-storage/service/storage-file-system/types';
import type { HizoFSAuthenticatedInspectionSession } from '@/00-storage/service/hizofs/inspection';
import { TEST_ONLY as RUNTIME_CONTRACT_TEST_ONLY } from '@/00-storage/service/naidan-opfs/persistence-runtime-contract';
import {
  installActiveAuthenticatedHizoFSContainerLocation,
  openActiveAuthenticatedHizoFSContainerLocationLease,
  openActiveAuthenticatedHizoFSDecryptedSnapshotLease,
  openActiveAuthenticatedHizoFSInspectionSessionLease,
  TEST_ONLY,
} from '@/00-storage/service/naidan-opfs/active-hizofs-container-location';
import { naidanOpfsContainerOriginRelativePathComponents } from '@/00-storage/service/naidan-opfs/opfs-storage-location';

function fileSystemId({ value }: { value: string }) {
  return RUNTIME_CONTRACT_TEST_ONLY.createEncryptedInspection({ fileSystemId: value }).mode.activeFileSystemId;
}

function authenticatedInspectionSession(): HizoFSAuthenticatedInspectionSession {
  return {
    inspectContainer: vi.fn(),
    inspectHomeRecord: vi.fn(),
    inspectNamespacePath: vi.fn(),
    inspectRecord: vi.fn(),
    inspectRecordFrame: vi.fn(),
  } as unknown as HizoFSAuthenticatedInspectionSession;
}

function installActive({ value, openReadSnapshot = async () => ({
  close: async () => undefined,
  root: { kind: 'directory', name: 'snapshot-root' } as StorageDirectoryHandle,
}) }: {
  value: string;
  openReadSnapshot?: () => Promise<{
    close(): Promise<void>;
    readonly root: StorageDirectoryHandle;
  }>;
}) {
  return installActiveAuthenticatedHizoFSContainerLocation({
    fileSystemId: fileSystemId({ value }),
    openAuthenticatedInspectionSession: async () => ({
      close: async () => undefined,
      session: authenticatedInspectionSession(),
    }),
    openReadSnapshot,
  });
}

describe('active authenticated HizoFS container location', () => {
  beforeEach(() => {
    TEST_ONLY.reset();
  });

  it('leases a detached canonical path only while its provider generation is active', async () => {
    const activeFileSystemId = fileSystemId({ value: '0123456789_ABCDEFGHIJ' });
    const uninstall = installActive({ value: '0123456789_ABCDEFGHIJ' });
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
    const uninstallFirst = installActive({ value: 'ABCDEFGHIJ_0123456789' });
    const firstLease = await openActiveAuthenticatedHizoFSContainerLocationLease();
    const uninstallSecond = installActive({ value: 'ZYXWVUTSRQ_9876543210' });
    const secondLease = await openActiveAuthenticatedHizoFSContainerLocationLease();

    expect(() => firstLease.assertCurrent()).toThrow('no longer current');
    expect(() => secondLease.assertCurrent()).not.toThrow();
    uninstallFirst();
    expect(() => secondLease.assertCurrent()).not.toThrow();

    uninstallSecond();
    expect(() => secondLease.assertCurrent()).toThrow('no longer current');
  });


  it('leases a secret-free authenticated inspection session for the active provider generation', async () => {
    const session = authenticatedInspectionSession();
    const close = vi.fn(async () => undefined);
    const uninstall = installActiveAuthenticatedHizoFSContainerLocation({
      fileSystemId: fileSystemId({ value: 'INSPECT001_1234567890' }),
      openAuthenticatedInspectionSession: async () => ({ close, session }),
      openReadSnapshot: async () => ({
        close: async () => undefined,
        root: { kind: 'directory', name: 'snapshot-root' } as StorageDirectoryHandle,
      }),
    });

    const lease = await openActiveAuthenticatedHizoFSInspectionSessionLease();
    if (lease === undefined) throw new Error('expected authenticated inspection session lease');
    expect(lease.session).not.toBe(session);
    await lease.session.inspectContainer();
    expect(session.inspectContainer).toHaveBeenCalledOnce();
    expect(() => lease.assertCurrent()).not.toThrow();

    await lease.dispose();
    expect(close).toHaveBeenCalledOnce();
    expect(() => lease.assertCurrent()).toThrow('lease is disposed');
    uninstall();
  });

  it('closes an inspection session opened across a provider cutover before rejecting it', async () => {
    const session = authenticatedInspectionSession();
    const close = vi.fn(async () => undefined);
    let resolveInspectionSession: ((value: {
      close(): Promise<void>;
      readonly session: HizoFSAuthenticatedInspectionSession;
    }) => void) | undefined;
    const uninstallFirst = installActiveAuthenticatedHizoFSContainerLocation({
      fileSystemId: fileSystemId({ value: 'INSPECT005_1234567890' }),
      openAuthenticatedInspectionSession: async () => await new Promise(resolve => {
        resolveInspectionSession = resolve;
      }),
      openReadSnapshot: async () => ({
        close: async () => undefined,
        root: { kind: 'directory', name: 'snapshot-root' } as StorageDirectoryHandle,
      }),
    });
    const opening = openActiveAuthenticatedHizoFSInspectionSessionLease();
    const uninstallSecond = installActive({ value: 'INSPECT006_1234567890' });
    resolveInspectionSession?.({ close, session });

    await expect(opening).rejects.toThrow('no longer current');
    expect(close).toHaveBeenCalledOnce();
    uninstallFirst();
    uninstallSecond();
  });

  it('waits for in-flight inspection reads before closing the provider-owned session', async () => {
    const session = authenticatedInspectionSession();
    const close = vi.fn(async () => undefined);
    let releaseInspection: (() => void) | undefined;
    const inspectionGate = new Promise<void>(resolve => {
      releaseInspection = resolve;
    });
    vi.mocked(session.inspectContainer).mockImplementation(async () => {
      await inspectionGate;
      return undefined as never;
    });
    const uninstall = installActiveAuthenticatedHizoFSContainerLocation({
      fileSystemId: fileSystemId({ value: 'INSPECT007_1234567890' }),
      openAuthenticatedInspectionSession: async () => ({ close, session }),
      openReadSnapshot: async () => ({
        close: async () => undefined,
        root: { kind: 'directory', name: 'snapshot-root' } as StorageDirectoryHandle,
      }),
    });
    const lease = await openActiveAuthenticatedHizoFSInspectionSessionLease();
    if (lease === undefined) throw new Error('expected authenticated inspection session lease');

    const reading = lease.session.inspectContainer();
    const disposing = lease.dispose();
    const duplicateDispose = lease.dispose();
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();

    releaseInspection?.();
    await expect(reading).rejects.toThrow('lease is disposed');
    await disposing;
    await duplicateDispose;
    expect(close).toHaveBeenCalledOnce();
    uninstall();
  });

  it('keeps inspection-session cleanup retryable after close failure without re-enabling reads', async () => {
    const session = authenticatedInspectionSession();
    const close = vi.fn()
      .mockRejectedValueOnce(new Error('inspection close blocked'))
      .mockResolvedValueOnce(undefined);
    const uninstall = installActiveAuthenticatedHizoFSContainerLocation({
      fileSystemId: fileSystemId({ value: 'INSPECT008_1234567890' }),
      openAuthenticatedInspectionSession: async () => ({ close, session }),
      openReadSnapshot: async () => ({
        close: async () => undefined,
        root: { kind: 'directory', name: 'snapshot-root' } as StorageDirectoryHandle,
      }),
    });
    const lease = await openActiveAuthenticatedHizoFSInspectionSessionLease();
    if (lease === undefined) throw new Error('expected authenticated inspection session lease');

    await expect(lease.dispose()).rejects.toThrow('inspection close blocked');
    expect(() => lease.assertCurrent()).toThrow('lease is disposed');
    await expect(lease.session.inspectContainer()).rejects.toThrow('lease is disposed');
    expect(session.inspectContainer).not.toHaveBeenCalled();

    await expect(lease.dispose()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
    uninstall();
  });

  it('rejects every inspection read after its provider generation becomes stale', async () => {
    const session = authenticatedInspectionSession();
    const uninstallFirst = installActiveAuthenticatedHizoFSContainerLocation({
      fileSystemId: fileSystemId({ value: 'INSPECT002_1234567890' }),
      openAuthenticatedInspectionSession: async () => ({
        close: async () => undefined,
        session,
      }),
      openReadSnapshot: async () => ({
        close: async () => undefined,
        root: { kind: 'directory', name: 'snapshot-root' } as StorageDirectoryHandle,
      }),
    });
    const lease = await openActiveAuthenticatedHizoFSInspectionSessionLease();
    if (lease === undefined) throw new Error('expected authenticated inspection session lease');
    const uninstallSecond = installActive({ value: 'INSPECT003_1234567890' });

    await expect(lease.session.inspectContainer()).rejects.toThrow('no longer current');
    await expect(lease.session.inspectRecordFrame({ request: {} as never })).rejects.toThrow('no longer current');
    expect(session.inspectContainer).not.toHaveBeenCalled();
    expect(session.inspectRecordFrame).not.toHaveBeenCalled();

    await lease.dispose();
    uninstallFirst();
    uninstallSecond();
  });

  it('keeps decrypted snapshot access available before the provider exposes authenticated inspection', async () => {
    const snapshotRoot = { kind: 'directory', name: 'snapshot-root' } as StorageDirectoryHandle;
    const uninstall = installActiveAuthenticatedHizoFSContainerLocation({
      fileSystemId: fileSystemId({ value: 'INSPECT004_1234567890' }),
      openAuthenticatedInspectionSession: undefined,
      openReadSnapshot: async () => ({
        close: async () => undefined,
        root: snapshotRoot,
      }),
    });

    await expect(openActiveAuthenticatedHizoFSInspectionSessionLease()).resolves.toBeUndefined();
    const snapshotLease = await openActiveAuthenticatedHizoFSDecryptedSnapshotLease();
    if (snapshotLease === undefined) throw new Error('expected decrypted snapshot lease');
    expect(snapshotLease.root).toBe(snapshotRoot);

    await snapshotLease.dispose();
    uninstall();
  });

  it('reports an absent active provider as an unavailable decrypted capability', async () => {
    await expect(openActiveAuthenticatedHizoFSDecryptedSnapshotLease()).resolves.toBeUndefined();
  });

  it('leases a pinned decrypted snapshot without exposing the live writable root', async () => {
    const close = vi.fn(async () => undefined);
    const snapshotRoot = { kind: 'directory', name: 'snapshot-root' } as StorageDirectoryHandle;
    const openReadSnapshot = vi.fn(async () => ({ close, root: snapshotRoot }));
    const uninstall = installActive({
      value: 'SNAPSHOT01_1234567890',
      openReadSnapshot,
    });

    const lease = await openActiveAuthenticatedHizoFSDecryptedSnapshotLease();
    if (lease === undefined) throw new Error('expected decrypted snapshot lease');
    expect(lease.root).toBe(snapshotRoot);
    expect(openReadSnapshot).toHaveBeenCalledOnce();
    expect(() => lease.assertCurrent()).not.toThrow();

    await lease.dispose();
    expect(close).toHaveBeenCalledOnce();
    expect(() => lease.assertCurrent()).toThrow('lease is disposed');
    uninstall();
  });

  it('closes a snapshot opened across a provider cutover before rejecting it', async () => {
    const close = vi.fn(async () => undefined);
    let resolveSnapshot: ((value: { close(): Promise<void>; readonly root: StorageDirectoryHandle }) => void) | undefined;
    const openReadSnapshot = vi.fn(async () => await new Promise<{
      close(): Promise<void>;
      readonly root: StorageDirectoryHandle;
        }>(resolve => {
          resolveSnapshot = resolve;
        }));
    const uninstallFirst = installActive({
      value: 'SNAPSHOT02_1234567890',
      openReadSnapshot,
    });
    const opening = openActiveAuthenticatedHizoFSDecryptedSnapshotLease();
    const uninstallSecond = installActive({ value: 'SNAPSHOT03_1234567890' });
    resolveSnapshot?.({
      close,
      root: { kind: 'directory', name: 'stale-root' } as StorageDirectoryHandle,
    });

    await expect(opening).rejects.toThrow('no longer current');
    expect(close).toHaveBeenCalledOnce();
    uninstallFirst();
    uninstallSecond();
  });

  it('keeps decrypted-snapshot cleanup retryable after close failure without re-enabling access', async () => {
    const close = vi.fn()
      .mockRejectedValueOnce(new Error('snapshot close blocked'))
      .mockResolvedValueOnce(undefined);
    const uninstall = installActive({
      value: 'SNAPSHOT04_1234567890',
      openReadSnapshot: async () => ({
        close,
        root: { kind: 'directory', name: 'retry-root' } as StorageDirectoryHandle,
      }),
    });
    const lease = await openActiveAuthenticatedHizoFSDecryptedSnapshotLease();
    if (lease === undefined) throw new Error('expected decrypted snapshot lease');

    await expect(lease.dispose()).rejects.toThrow('snapshot close blocked');
    expect(() => lease.assertCurrent()).toThrow('lease is disposed');

    await expect(lease.dispose()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
    uninstall();
  });

  it('rejects use after the caller disposes its lease', async () => {
    installActive({ value: 'LMNOPQRSTU_1234567890' });
    const lease = await openActiveAuthenticatedHizoFSContainerLocationLease();
    await lease.dispose();
    expect(() => lease.assertCurrent()).toThrow('lease is disposed');
  });
});
