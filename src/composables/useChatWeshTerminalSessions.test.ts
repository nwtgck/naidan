import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';

const mocks = vi.hoisted(() => ({
  getVolumeDirectoryHandle: vi.fn(),
  createClient: vi.fn(),
  getDirectory: vi.fn(),
  ensureChatTmpDirectory: vi.fn(),
}));

vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref({
      mounts: [
        { type: 'volume', volumeId: 'global-vol-1', mountPath: '/home/user/global', readOnly: true },
      ],
    }),
  }),
}));

vi.mock('@/services/storage', () => ({
  storageService: {
    getVolumeDirectoryHandle: mocks.getVolumeDirectoryHandle,
  },
}));

vi.mock('@/services/wesh/worker/client', () => ({
  createFileProtocolCompatibleWeshWorkerClient: mocks.createClient,
}));

vi.mock('@/composables/useChat', () => ({
  useChat: () => ({
    ensureChatTmpDirectory: mocks.ensureChatTmpDirectory,
  }),
}));

describe('useChatWeshTerminalSessions', () => {
  const tmpHandle = { name: 'tmp' } as unknown as FileSystemDirectoryHandle;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getVolumeDirectoryHandle.mockResolvedValue({ kind: 'directory', name: 'dir' } as FileSystemDirectoryHandle);
    mocks.ensureChatTmpDirectory.mockResolvedValue({ handle: tmpHandle, mountPath: '/tmp' });
    mocks.createClient.mockResolvedValue({
      startExecution: vi.fn(),
      awaitExecution: vi.fn(),
      cancelExecution: vi.fn(),
      disposeExecution: vi.fn(),
      dispose: vi.fn(),
    });
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: mocks.getDirectory,
      },
    });
    const chatRoot = { getDirectoryHandle: vi.fn().mockResolvedValue({}) } as unknown as FileSystemDirectoryHandle;
    const terminalRoot = { getDirectoryHandle: vi.fn().mockResolvedValue(chatRoot) } as unknown as FileSystemDirectoryHandle;
    mocks.getDirectory.mockResolvedValue({
      getDirectoryHandle: vi.fn().mockResolvedValue(terminalRoot),
    });
  });

  describe('buildWorkerMountsForChat', () => {
    it('includes global settings mounts when chat has no mounts and no chatId', async () => {
      const { useChatWeshTerminalSessions } = await import('./useChatWeshTerminalSessions');
      const { TEST_ONLY } = useChatWeshTerminalSessions();

      const result = await TEST_ONLY.buildWorkerMountsForChat({ chatMounts: [], chatGroupMounts: undefined, chatId: undefined });

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ path: '/home/user/global', readOnly: true });
      expect(mocks.ensureChatTmpDirectory).not.toHaveBeenCalled();
    });

    it('includes /tmp as first mount when chatId is provided', async () => {
      const { useChatWeshTerminalSessions } = await import('./useChatWeshTerminalSessions');
      const { TEST_ONLY } = useChatWeshTerminalSessions();

      const result = await TEST_ONLY.buildWorkerMountsForChat({ chatMounts: [], chatGroupMounts: undefined, chatId: 'chat-1' });

      expect(mocks.ensureChatTmpDirectory).toHaveBeenCalledWith({ chatId: 'chat-1' });
      expect(result[0]).toMatchObject({ path: '/tmp', handle: tmpHandle, readOnly: false });
    });

    it('includes both global and chat mounts when paths differ', async () => {
      const { useChatWeshTerminalSessions } = await import('./useChatWeshTerminalSessions');
      const { TEST_ONLY } = useChatWeshTerminalSessions();

      const chatMounts = [
        { type: 'volume' as const, volumeId: 'chat-vol-1', mountPath: '/home/user/chat', readOnly: false },
      ];

      const result = await TEST_ONLY.buildWorkerMountsForChat({ chatMounts, chatGroupMounts: undefined, chatId: undefined });

      expect(result).toHaveLength(2);
      expect(result.some(m => m.path === '/home/user/global')).toBe(true);
      expect(result.some(m => m.path === '/home/user/chat')).toBe(true);
    });

    it('chat mount overrides global mount at the same path', async () => {
      const { useChatWeshTerminalSessions } = await import('./useChatWeshTerminalSessions');
      const { TEST_ONLY } = useChatWeshTerminalSessions();

      // Chat mount uses the same path as the global mount but different volumeId and readOnly
      const chatMounts = [
        { type: 'volume' as const, volumeId: 'chat-vol-override', mountPath: '/home/user/global', readOnly: false },
      ];

      const result = await TEST_ONLY.buildWorkerMountsForChat({ chatMounts, chatGroupMounts: undefined, chatId: undefined });

      // Only one mount at that path, and it should be the chat one (readOnly: false)
      expect(result.filter(m => m.path === '/home/user/global')).toHaveLength(1);
      expect(result.find(m => m.path === '/home/user/global')).toMatchObject({ readOnly: false });
      expect(mocks.getVolumeDirectoryHandle).toHaveBeenCalledWith({ volumeId: 'chat-vol-override' });
    });

    it('includes chat group mounts between global and chat mounts', async () => {
      const { useChatWeshTerminalSessions } = await import('./useChatWeshTerminalSessions');
      const { TEST_ONLY } = useChatWeshTerminalSessions();

      const chatGroupMounts = [
        { type: 'volume' as const, volumeId: 'group-vol-1', mountPath: '/home/user/group', readOnly: true },
      ];
      const chatMounts = [
        { type: 'volume' as const, volumeId: 'chat-vol-1', mountPath: '/home/user/chat', readOnly: false },
      ];

      const result = await TEST_ONLY.buildWorkerMountsForChat({ chatMounts, chatGroupMounts, chatId: undefined });

      expect(result).toHaveLength(3);
      expect(result.some(m => m.path === '/home/user/global')).toBe(true);
      expect(result.some(m => m.path === '/home/user/group')).toBe(true);
      expect(result.some(m => m.path === '/home/user/chat')).toBe(true);
    });

    it('chat group mount overrides global mount at the same path', async () => {
      const { useChatWeshTerminalSessions } = await import('./useChatWeshTerminalSessions');
      const { TEST_ONLY } = useChatWeshTerminalSessions();

      const chatGroupMounts = [
        { type: 'volume' as const, volumeId: 'group-vol-override', mountPath: '/home/user/global', readOnly: false },
      ];

      const result = await TEST_ONLY.buildWorkerMountsForChat({ chatMounts: [], chatGroupMounts, chatId: undefined });

      expect(result.filter(m => m.path === '/home/user/global')).toHaveLength(1);
      expect(result.find(m => m.path === '/home/user/global')).toMatchObject({ readOnly: false });
      expect(mocks.getVolumeDirectoryHandle).toHaveBeenCalledWith({ volumeId: 'group-vol-override' });
    });

    it('chat mount overrides chat group mount at the same path', async () => {
      const { useChatWeshTerminalSessions } = await import('./useChatWeshTerminalSessions');
      const { TEST_ONLY } = useChatWeshTerminalSessions();

      const chatGroupMounts = [
        { type: 'volume' as const, volumeId: 'group-vol-1', mountPath: '/home/user/shared', readOnly: true },
      ];
      const chatMounts = [
        { type: 'volume' as const, volumeId: 'chat-vol-override', mountPath: '/home/user/shared', readOnly: false },
      ];

      const result = await TEST_ONLY.buildWorkerMountsForChat({ chatMounts, chatGroupMounts, chatId: undefined });

      // Only one mount at the shared path, and it should be the chat one (readOnly: false)
      expect(result.filter(m => m.path === '/home/user/shared')).toHaveLength(1);
      expect(result.find(m => m.path === '/home/user/shared')).toMatchObject({ readOnly: false });
      expect(mocks.getVolumeDirectoryHandle).toHaveBeenCalledWith({ volumeId: 'chat-vol-override' });
    });

    it('works with only chat group mounts and no chat-level mounts', async () => {
      const { useChatWeshTerminalSessions } = await import('./useChatWeshTerminalSessions');
      const { TEST_ONLY } = useChatWeshTerminalSessions();

      const chatGroupMounts = [
        { type: 'volume' as const, volumeId: 'group-vol-1', mountPath: '/home/user/group-only', readOnly: false },
      ];

      const result = await TEST_ONLY.buildWorkerMountsForChat({ chatMounts: [], chatGroupMounts, chatId: undefined });

      expect(result).toHaveLength(2); // global + group
      expect(result.some(m => m.path === '/home/user/global')).toBe(true);
      expect(result.some(m => m.path === '/home/user/group-only')).toBe(true);
    });
  });
});
