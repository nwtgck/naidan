import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import ChatWeshTerminalModal from './ChatWeshTerminalModal.vue';

const mocks = vi.hoisted(() => ({
  startExecution: vi.fn().mockResolvedValue({ executionId: 'exec-1' }),
  awaitExecution: vi.fn().mockResolvedValue({ exitCode: 0 }),
  cancelExecution: vi.fn().mockResolvedValue(true),
  disposeExecution: vi.fn().mockResolvedValue(undefined),
  dispose: vi.fn().mockResolvedValue(undefined),
  createClient: vi.fn(),
  getVolumeDirectoryHandle: vi.fn().mockResolvedValue({} as FileSystemDirectoryHandle),
  getDirectory: vi.fn(),
  showConfirm: vi.fn(),
  ensureChatTmpDirectory: vi.fn(),
}));

vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref({
      mounts: [
        { type: 'volume', volumeId: 'global-vol', mountPath: '/home/user/global', readOnly: true },
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

vi.mock('@/composables/useConfirm', () => ({
  useConfirm: () => ({
    showConfirm: mocks.showConfirm,
  }),
}));

vi.mock('@/composables/useChat', () => ({
  useChat: () => ({
    ensureChatTmpDirectory: mocks.ensureChatTmpDirectory,
  }),
}));

vi.mock('lucide-vue-next', () => ({
  X: { template: '<span>X</span>' },
  Terminal: { template: '<span>Terminal</span>' },
  Plus: { template: '<span>Plus</span>' },
}));

describe('ChatWeshTerminalModal', () => {
  const tmpHandle = { name: 'tmp' } as unknown as FileSystemDirectoryHandle;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.showConfirm.mockResolvedValue(true);
    mocks.ensureChatTmpDirectory.mockResolvedValue({ handle: tmpHandle, mountPath: '/tmp' });
    mocks.createClient.mockResolvedValue({
      startExecution: mocks.startExecution,
      awaitExecution: mocks.awaitExecution,
      cancelExecution: mocks.cancelExecution,
      disposeExecution: mocks.disposeExecution,
      dispose: mocks.dispose,
    });
    const globalRoot = {
      name: 'global-root',
      getDirectoryHandle: vi.fn(),
    } as unknown as FileSystemDirectoryHandle;
    const terminalRoot = {
      name: 'naidan-chat-wesh',
      getDirectoryHandle: vi.fn().mockResolvedValue(globalRoot),
    } as unknown as FileSystemDirectoryHandle;
    mocks.getDirectory.mockResolvedValue({
      getDirectoryHandle: vi.fn().mockResolvedValue(terminalRoot),
    });
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: mocks.getDirectory,
      },
    });
  });

  it('creates a session with /tmp, global, and chat mounts', async () => {
    const chatMounts = [
      { type: 'volume' as const, volumeId: 'chat-vol', mountPath: '/home/user/chat', readOnly: false },
    ];

    mount(ChatWeshTerminalModal, {
      props: { isOpen: true, chatMounts, chatId: 'chat-1' },
    });
    await flushPromises();

    expect(mocks.ensureChatTmpDirectory).toHaveBeenCalledWith({ chatId: 'chat-1' });
    expect(mocks.createClient).toHaveBeenCalledWith(expect.objectContaining({
      mounts: expect.arrayContaining([
        expect.objectContaining({ path: '/tmp', handle: tmpHandle, readOnly: false }),
        expect.objectContaining({ path: '/home/user/global', readOnly: true }),
        expect.objectContaining({ path: '/home/user/chat', readOnly: false }),
      ]),
      user: 'user',
      initialEnv: { HOME: '/home/user' },
      initialCwd: '/home/user',
    }));
  });

  it('does not call ensureChatTmpDirectory when chatId is undefined', async () => {
    mount(ChatWeshTerminalModal, {
      props: { isOpen: true, chatMounts: [], chatId: undefined },
    });
    await flushPromises();

    expect(mocks.ensureChatTmpDirectory).not.toHaveBeenCalled();
  });

  it('shows session tab and new session button when open with no chat mounts', async () => {
    const wrapper = mount(ChatWeshTerminalModal, {
      props: { isOpen: true, chatMounts: [], chatId: undefined },
    });
    await flushPromises();

    // The terminal should display at least one session tab
    expect(wrapper.text()).toMatch(/Session \d+/);
    expect(wrapper.find('[data-testid="new-session-button"]').exists()).toBe(true);
  });

  it('asks for confirmation before closing a session', async () => {
    const wrapper = mount(ChatWeshTerminalModal, {
      props: { isOpen: true, chatMounts: [], chatId: undefined },
    });
    await flushPromises();

    await wrapper.get('button[aria-label="Close session"]').trigger('click');
    await flushPromises();

    expect(mocks.showConfirm).toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });
});
