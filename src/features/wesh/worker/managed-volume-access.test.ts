import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toVolumeId } from '@/01-models/ids';
import type { RemoteDirectoryAccess } from '@/utils/remote-directory-handle';
import { createManagedVolumeRemoteAccess, observeManagedVolumeWorker } from './managed-volume-access';

const mocks = vi.hoisted(() => ({ createAccess: vi.fn() }));
vi.mock('@/00-storage/service', () => ({
  storageService: { createManagedVolumeAccess: mocks.createAccess },
}));

function createConnection({ id }: { id: string }) {
  return {
    root: { id, kind: 'directory' as const, name: id },
    access: {
      request: vi.fn<RemoteDirectoryAccess['request']>().mockResolvedValue({ status: 'ok', result: { kind: 'entries', entries: [] } }),
    },
    dispose: vi.fn(async () => {}),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('managed volume worker connections', () => {
  it('keeps grants separate for the same volume at writable and read-only paths', async () => {
    const writable = createConnection({ id: 'writable-root' });
    const readOnly = createConnection({ id: 'read-only-root' });
    const reference = { volumeId: toVolumeId({ raw: 'shared-volume' }) };
    mocks.createAccess.mockResolvedValueOnce(writable).mockResolvedValueOnce(readOnly);

    const connection = await createManagedVolumeRemoteAccess({
      mounts: [
        { type: 'managed_directory', path: '/work', reference, readOnly: false },
        { type: 'managed_directory', path: '/reference', reference, readOnly: true },
      ],
    });
    try {
      expect(mocks.createAccess).toHaveBeenNthCalledWith(1, { reference, readOnly: false });
      expect(mocks.createAccess).toHaveBeenNthCalledWith(2, { reference, readOnly: true });
      expect(await connection.remote!.getRoot({ path: '/reference' })).toEqual(readOnly.root);
      await connection.remote!.request({ path: '/work', request: { type: 'list', id: writable.root.id } });
      expect(writable.access.request).toHaveBeenCalledWith({ request: { type: 'list', id: writable.root.id } });
      expect(readOnly.access.request).not.toHaveBeenCalled();
      await expect(connection.remote!.getRoot({ path: '/unmounted' })).rejects.toMatchObject({ name: 'NotAllowedError' });
      await expect(connection.remote!.request({ path: '/work', request: { type: 'list', id: '' } })).rejects.toThrow();
      expect(writable.access.request).toHaveBeenCalledTimes(1);
    } finally {
      await connection.dispose();
    }
    expect(writable.dispose).toHaveBeenCalledOnce();
    expect(readOnly.dispose).toHaveBeenCalledOnce();
    await expect(connection.remote!.getRoot({ path: '/work' })).rejects.toMatchObject({ name: 'InvalidStateError' });
  });

  it('releases opened grants when another mount fails to connect', async () => {
    const opened = createConnection({ id: 'first' });
    const error = new Error('second volume missing');
    mocks.createAccess.mockResolvedValueOnce(opened).mockRejectedValueOnce(error);
    await expect(createManagedVolumeRemoteAccess({
      mounts: [
        { type: 'managed_directory', path: '/first', reference: { volumeId: toVolumeId({ raw: 'first' }) }, readOnly: false },
        { type: 'managed_directory', path: '/second', reference: { volumeId: toVolumeId({ raw: 'second' }) }, readOnly: true },
      ],
    })).rejects.toBe(error);
    expect(opened.dispose).toHaveBeenCalledOnce();
  });

  it('does not grant a managed source overridden by a native mount at the same normalized path', async () => {
    const connection = await createManagedVolumeRemoteAccess({
      mounts: [
        { type: 'managed_directory', path: '/work/../documents/', reference: { volumeId: toVolumeId({ raw: 'hidden' }) }, readOnly: false },
        { type: 'directory', path: '/documents', handle: { kind: 'directory', name: 'visible' } as FileSystemDirectoryHandle, readOnly: true },
      ],
    });
    expect(connection.remote).toBeUndefined();
    expect(mocks.createAccess).not.toHaveBeenCalled();
    await connection.dispose();
  });

  it('disposes shared runtime grants on a worker failure and waits for the same cleanup', async () => {
    let release: (() => void) | undefined;
    const opened = createConnection({ id: 'root' });
    opened.dispose.mockImplementation(() => new Promise<void>(resolve => {
      release = resolve;
    }));
    mocks.createAccess.mockResolvedValueOnce(opened);
    const connection = await createManagedVolumeRemoteAccess({
      mounts: [
        { type: 'managed_directory', path: '/work', reference: { volumeId: toVolumeId({ raw: 'work' }) }, readOnly: false },
      ],
    });
    const worker = new EventTarget() as Worker;
    const stopObserving = observeManagedVolumeWorker({ worker, connection });
    worker.dispatchEvent(new Event('error'));
    await Promise.resolve();
    const pending = connection.dispose();
    expect(connection.dispose()).toBe(pending);
    expect(opened.dispose).toHaveBeenCalledOnce();
    await expect(connection.remote!.getRoot({ path: '/work' })).rejects.toMatchObject({ name: 'InvalidStateError' });
    release!();
    await pending;
    stopObserving();
    worker.dispatchEvent(new Event('messageerror'));
    expect(opened.dispose).toHaveBeenCalledOnce();
  });

  it('does not load storage grants or subscribe to worker events for native-only mounts', async () => {
    const connection = await createManagedVolumeRemoteAccess({ mounts: [] });
    const worker = { addEventListener: vi.fn() } as unknown as Worker;
    const stopObserving = observeManagedVolumeWorker({ worker, connection });
    expect(connection.remote).toBeUndefined();
    expect(mocks.createAccess).not.toHaveBeenCalled();
    expect(worker.addEventListener).not.toHaveBeenCalled();
    stopObserving();
    await connection.dispose();
  });
});
