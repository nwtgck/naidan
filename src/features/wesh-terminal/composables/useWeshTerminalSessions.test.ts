import { beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('uses an encrypted directory capability as the writable Wesh root', async () => {
    const encryptedRoot = {
      type: 'encrypted_directory' as const,
      storeDirectory: { name: 'encrypted-store' } as FileSystemDirectoryHandle,
      rootDirectoryId: 'encrypted-global-root',
      objectEncryptionKey: {} as CryptoKey,
      objectAddressKey: {} as CryptoKey,
    };
    mocks.openOpfsSpecialFileSystemDirectory.mockResolvedValue(encryptedRoot);
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
        type: 'encrypted_directory',
        path: '/',
        storeDirectory: encryptedRoot.storeDirectory,
        rootDirectoryId: encryptedRoot.rootDirectoryId,
        objectEncryptionKey: encryptedRoot.objectEncryptionKey,
        objectAddressKey: encryptedRoot.objectAddressKey,
        readOnly: false,
      }],
      user: 'user',
      initialEnv: { HOME: '/home/user', TMPDIR: '/tmp' },
      initialCwd: '/home/user',
    });
  });
});
