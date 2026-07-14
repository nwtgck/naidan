import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageDirectoryHandle } from '@/00-storage/service/storage-file-system/types';
import { createWeshTerminalSessions } from './useWeshTerminalSessions';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  openOpfsSpecialFileSystemDirectory: vi.fn(),
}));

vi.mock('@/features/wesh/worker/client', () => ({
  createFileProtocolCompatibleWeshWorkerClient: mocks.createClient,
}));

vi.mock('@/00-storage/service', () => ({
  storageService: {
    openOpfsSpecialFileSystemDirectory: mocks.openOpfsSpecialFileSystemDirectory,
  },
}));

describe('createWeshTerminalSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockResolvedValue({
      getShellState: vi.fn().mockResolvedValue({ cwd: '/home/user', env: {} }),
      dispose: vi.fn(),
    });
  });

  it('uses a decrypted storage directory capability as the writable Wesh root', async () => {
    const decryptedRoot = {
      kind: 'directory',
      name: 'global',
    } as StorageDirectoryHandle;
    mocks.openOpfsSpecialFileSystemDirectory.mockResolvedValue({
      type: 'storage_directory',
      handle: decryptedRoot,
    });
    const sessions = createWeshTerminalSessions({
      fileSystemType: 'chat_wesh',
      user: 'user',
      initialEnv: { HOME: '/home/user', TMPDIR: '/tmp' },
      initialCwd: '/home/user',
      homeDirectory: '/home/user',
      tmpDirectory: '/tmp',
    });

    await sessions.createSession({ buildMounts: async () => [] });

    expect(mocks.openOpfsSpecialFileSystemDirectory).toHaveBeenCalledWith({
      type: 'chat_wesh',
      path: '/global/home/user',
      create: true,
    });
    expect(mocks.openOpfsSpecialFileSystemDirectory).toHaveBeenCalledWith({
      type: 'chat_wesh',
      path: '/global/tmp',
      create: true,
    });
    expect(mocks.createClient).toHaveBeenCalledWith({
      rootHandle: 'readonly',
      mounts: [{
        type: 'storage_directory',
        path: '/',
        handle: decryptedRoot,
        workerSource: undefined,
        readOnly: false,
      }],
      user: 'user',
      initialEnv: { HOME: '/home/user', TMPDIR: '/tmp' },
      initialCwd: '/home/user',
    });
  });
});
