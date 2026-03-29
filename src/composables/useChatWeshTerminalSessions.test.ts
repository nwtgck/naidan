import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';

const mocks = vi.hoisted(() => ({
  getVolumeDirectoryHandle: vi.fn(),
  createClient: vi.fn(),
  getDirectory: vi.fn(),
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

vi.mock('@/services/wesh-worker-client', () => ({
  createFileProtocolCompatibleWeshWorkerClient: mocks.createClient,
}));

describe('useChatWeshTerminalSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getVolumeDirectoryHandle.mockResolvedValue({ kind: 'directory', name: 'dir' } as FileSystemDirectoryHandle);
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
    it('includes global settings mounts when chat has no mounts', async () => {
      const { useChatWeshTerminalSessions } = await import('./useChatWeshTerminalSessions');
      const { __testOnly } = useChatWeshTerminalSessions();

      const result = await __testOnly.buildWorkerMountsForChat({ chatMounts: [] });

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ path: '/home/user/global', readOnly: true });
      expect(mocks.getVolumeDirectoryHandle).toHaveBeenCalledWith({ volumeId: 'global-vol-1' });
    });

    it('includes both global and chat mounts when paths differ', async () => {
      const { useChatWeshTerminalSessions } = await import('./useChatWeshTerminalSessions');
      const { __testOnly } = useChatWeshTerminalSessions();

      const chatMounts = [
        { type: 'volume' as const, volumeId: 'chat-vol-1', mountPath: '/home/user/chat', readOnly: false },
      ];

      const result = await __testOnly.buildWorkerMountsForChat({ chatMounts });

      expect(result).toHaveLength(2);
      expect(result.some(m => m.path === '/home/user/global')).toBe(true);
      expect(result.some(m => m.path === '/home/user/chat')).toBe(true);
    });

    it('chat mount overrides global mount at the same path', async () => {
      const { useChatWeshTerminalSessions } = await import('./useChatWeshTerminalSessions');
      const { __testOnly } = useChatWeshTerminalSessions();

      // Chat mount uses the same path as the global mount but different volumeId and readOnly
      const chatMounts = [
        { type: 'volume' as const, volumeId: 'chat-vol-override', mountPath: '/home/user/global', readOnly: false },
      ];

      const result = await __testOnly.buildWorkerMountsForChat({ chatMounts });

      // Only one mount at that path, and it should be the chat one (readOnly: false)
      expect(result.filter(m => m.path === '/home/user/global')).toHaveLength(1);
      expect(result.find(m => m.path === '/home/user/global')).toMatchObject({ readOnly: false });
      expect(mocks.getVolumeDirectoryHandle).toHaveBeenCalledWith({ volumeId: 'chat-vol-override' });
    });
  });
});
