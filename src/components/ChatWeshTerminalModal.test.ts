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

vi.mock('lucide-vue-next', () => ({
  X: { template: '<span>X</span>' },
  Terminal: { template: '<span>Terminal</span>' },
  Plus: { template: '<span>Plus</span>' },
}));

describe('ChatWeshTerminalModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.showConfirm.mockResolvedValue(true);
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

  it('creates a session with combined global and chat mounts', async () => {
    const chatMounts = [
      { type: 'volume' as const, volumeId: 'chat-vol', mountPath: '/home/user/chat', readOnly: false },
    ];

    mount(ChatWeshTerminalModal, {
      props: { isOpen: true, chatMounts },
    });
    await flushPromises();

    expect(mocks.createClient).toHaveBeenCalledWith(expect.objectContaining({
      mounts: expect.arrayContaining([
        expect.objectContaining({ path: '/home/user/global', readOnly: true }),
        expect.objectContaining({ path: '/home/user/chat', readOnly: false }),
      ]),
      user: 'user',
      initialEnv: {},
      initialCwd: undefined,
    }));
  });

  it('shows session tab and new session button when open with no chat mounts', async () => {
    const wrapper = mount(ChatWeshTerminalModal, {
      props: { isOpen: true, chatMounts: [] },
    });
    await flushPromises();

    // The terminal should display at least one session tab
    expect(wrapper.text()).toMatch(/Session \d+/);
    expect(wrapper.find('[data-testid="new-session-button"]').exists()).toBe(true);
  });

  it('asks for confirmation before closing a session', async () => {
    const wrapper = mount(ChatWeshTerminalModal, {
      props: { isOpen: true, chatMounts: [] },
    });
    await flushPromises();

    await wrapper.get('button[aria-label="Close session"]').trigger('click');
    await flushPromises();

    expect(mocks.showConfirm).toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });
});
