import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import DebugWeshTerminalModal from './DebugWeshTerminalModal.vue';

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
        { type: 'volume', volumeId: 'vol-1', mountPath: '/data', readOnly: true },
      ],
    }),
  }),
}));

vi.mock('@/00-storage/service', () => ({
  storageService: {
    getVolumeDirectoryHandle: mocks.getVolumeDirectoryHandle,
  },
}));

vi.mock('@/features/wesh/worker/client', () => ({
  createFileProtocolCompatibleWeshWorkerClient: mocks.createClient,
}));

vi.mock('@/composables/useConfirm', () => ({
  useConfirm: () => ({
    showConfirm: mocks.showConfirm,
  }),
}));

vi.mock('lucide-vue-next', () => ({
  XIcon: { template: '<span>X</span>' },
  TerminalIcon: { template: '<span>Terminal</span>' },
  PlusIcon: { template: '<span>Plus</span>' },
}));

function createDirectoryHandleMock({ name }: { name: string }): FileSystemDirectoryHandle {
  const handle = {
    name,
    getDirectoryHandle: vi.fn(async (childName: string) => createDirectoryHandleMock({ name: childName })),
  } as unknown as FileSystemDirectoryHandle;
  return handle;
}

describe('DebugWeshTerminalModal', () => {
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
    const globalRoot = createDirectoryHandleMock({ name: 'global-root' });
    const debugRoot = createDirectoryHandleMock({ name: 'naidan-debug-wesh' });
    vi.mocked(debugRoot.getDirectoryHandle).mockResolvedValue(globalRoot);
    mocks.getDirectory.mockResolvedValue({
      getDirectoryHandle: vi.fn().mockResolvedValue(debugRoot),
    });
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: mocks.getDirectory,
      },
    });
  });

  it('initializes the worker terminal under /global and mounts configured volumes', async () => {
    const wrapper = mount(DebugWeshTerminalModal, {
      props: { isOpen: true },
    });
    await flushPromises();

    await vi.waitFor(() => {
      expect(mocks.createClient).toHaveBeenCalledWith(expect.objectContaining({
        rootHandle: expect.any(Object),
        mounts: [
          {
            type: 'directory',
            path: '/data',
            handle: expect.any(Object),
            readOnly: true,
          },
        ],
        user: 'debug',
        initialEnv: { HOME: '/home/debug', TMPDIR: '/tmp' },
        initialCwd: '/home/debug',
      }));
    });
    expect(wrapper.text()).toContain('Session 1');
    expect(wrapper.find('[data-testid="new-session-button"]').exists()).toBe(true);
  });

  it('asks for confirmation before closing a session', async () => {
    const wrapper = mount(DebugWeshTerminalModal, {
      props: { isOpen: true },
    });
    await flushPromises();

    await wrapper.get('button[aria-label="Close session"]').trigger('click');
    await flushPromises();

    expect(mocks.showConfirm).toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });

  it('shows input as readonly while a command is running, then writable again', async () => {
    let resolveAwaitExecution: ((value: { exitCode: number }) => void) | undefined;
    mocks.startExecution.mockResolvedValue({ executionId: 'exec-1' });
    mocks.awaitExecution.mockImplementation(
      () => new Promise((resolve) => {
        resolveAwaitExecution = resolve;
      }),
    );

    const wrapper = mount(DebugWeshTerminalModal, {
      props: { isOpen: true },
    });
    await flushPromises();

    const textarea = wrapper.get('[data-testid="terminal-input"]');
    await textarea.setValue('pwd');

    // Trigger Enter keydown to submit
    await textarea.trigger('keydown', { key: 'Enter', shiftKey: false });
    await flushPromises();

    // Textarea still exists but is readonly while running
    expect(wrapper.find('[data-testid="terminal-input"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="terminal-input"]').attributes('readonly')).toBeDefined();

    // Resolve the command
    resolveAwaitExecution?.({ exitCode: 0 });
    await flushPromises();

    // Textarea is no longer readonly
    expect(wrapper.get('[data-testid="terminal-input"]').attributes('readonly')).toBeUndefined();
  });
});
