import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import DebugWeshTerminalModal from './DebugWeshTerminalModal.vue';
import type { WeshWorkerExecutionOutcome } from '@/features/wesh/worker/types';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';

const mocks = vi.hoisted(() => ({
  startExecution: vi.fn(() => ({ completion: Promise.resolve<WeshWorkerExecutionOutcome>({ status: 'exited', exitCode: 0, shellState: { cwd: '/saved', env: {} } }), cancel: vi.fn() })),
  dispose: vi.fn().mockResolvedValue(undefined),
  getShellState: vi.fn().mockResolvedValue({ cwd: '/saved', env: {} }),
  createClient: vi.fn(),
  resolveVolumeAccess: vi.fn(async ({ volumeId }: { volumeId: import('@/01-models/ids').VolumeId }) => ({
    kind: 'native',
    volume: { id: volumeId, name: 'Files', type: 'opfs', createdAt: 0 },
    handle: {} as FileSystemDirectoryHandle,
  })),
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
    resolveVolumeAccess: mocks.resolveVolumeAccess,
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

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

describe('DebugWeshTerminalModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.showConfirm.mockResolvedValue(true);
    mocks.createClient.mockResolvedValue({
      startExecution: mocks.startExecution,
      getShellState: mocks.getShellState,
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
    const completion = Promise.withResolvers<WeshWorkerExecutionOutcome>();
    mocks.startExecution.mockReturnValueOnce({ completion: completion.promise, cancel: vi.fn() });

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
    completion.resolve({ status: 'exited', exitCode: 0, shellState: { cwd: '/saved', env: {} } });
    await flushPromises();

    // Textarea is no longer readonly
    expect(wrapper.get('[data-testid="terminal-input"]').attributes('readonly')).toBeUndefined();
  });

  it.each(['exited', 'terminated'] as const)('sends one Ctrl-C and restores input when the execution is %s', async status => {
    const completion = Promise.withResolvers<WeshWorkerExecutionOutcome>();
    const cancel = vi.fn();
    mocks.startExecution.mockReturnValueOnce({ completion: completion.promise, cancel });
    const wrapper = mount(DebugWeshTerminalModal, { props: { isOpen: true } });
    using _wrapper = { [Symbol.dispose]: () => wrapper.unmount() };
    await flushPromises();
    await wrapper.get('[data-testid="new-session-button"]').trigger('click');
    await flushPromises();
    const readsBeforeRun = mocks.getShellState.mock.calls.length;
    expect(wrapper.text()).toContain('/saved $');
    using _restoreShellState = {
      [Symbol.dispose]: () => {
        mocks.getShellState.mockReset().mockResolvedValue({ cwd: '/saved', env: {} });
      },
    };
    mocks.getShellState.mockReturnValueOnce(new Promise(() => {}));
    const textarea = wrapper.get('[data-testid="terminal-input"]');
    await textarea.setValue('sleep 60');
    await textarea.trigger('keydown', { key: 'Enter' });
    await textarea.trigger('keydown', { key: 'c', ctrlKey: true });
    expect(cancel).toHaveBeenCalledOnce();

    completion.resolve(status === 'exited' ? { status, exitCode: 130, shellState: { cwd: '/after', env: {} } } : { status });
    await flushPromises();

    expect(mocks.startExecution).toHaveBeenCalledWith(expect.objectContaining({ request: { script: 'sleep 60', includeShellState: true } }));
    expect(textarea.attributes('readonly')).toBeUndefined();
    expect(wrapper.text()).toContain('^C');
    expect(mocks.getShellState).toHaveBeenCalledTimes(readsBeforeRun);
    if (status === 'exited') {
      expect(wrapper.text()).toContain('/after $');
    } else {
      expect(wrapper.text()).not.toContain('/saved $');
    }
  });

  it.each(['directory', 'worker init'] as const)('closes the session during %s and ignores the late result', async phase => {
    const wrapper = mount(DebugWeshTerminalModal, { props: { isOpen: true } });
    using _wrapper = { [Symbol.dispose]: () => wrapper.unmount() };
    await flushPromises();
    const pendingDirectory = Promise.withResolvers<FileSystemDirectoryHandle>();
    const pendingShell = Promise.withResolvers<{ cwd: string, env: Record<string, string> }>();
    if (phase === 'directory') {
      mocks.getDirectory.mockReturnValueOnce(pendingDirectory.promise);
    } else {
      mocks.getShellState.mockReturnValueOnce(pendingShell.promise);
    }
    const alreadyCreated = mocks.createClient.mock.calls.length;
    await wrapper.get('[data-testid="new-session-button"]').trigger('click');
    await flushPromises();
    const close = wrapper.findAll('button[aria-label="Close session"]').at(-1)!;
    await close.trigger('click');
    await flushPromises();

    const getDirectoryHandle = vi.fn();
    if (phase === 'directory') {
      pendingDirectory.resolve({ getDirectoryHandle } as unknown as FileSystemDirectoryHandle);
    } else {
      pendingShell.reject(new DOMException('closed', 'AbortError'));
    }
    await flushPromises();
    expect(getDirectoryHandle).not.toHaveBeenCalled();
    expect(mocks.createClient).toHaveBeenCalledTimes(alreadyCreated + (phase === 'worker init' ? 1 : 0));
    expect(mocks.dispose).toHaveBeenCalledTimes(phase === 'worker init' ? 1 : 0);
    expect(wrapper.text()).not.toContain('closed');
  });

  it('clears the prompt after a Worker failure while keeping it after a command error', async () => {
    const wrapper = mount(DebugWeshTerminalModal, { props: { isOpen: true } });
    using _wrapper = { [Symbol.dispose]: () => wrapper.unmount() };
    await flushPromises();
    await wrapper.get('[data-testid="new-session-button"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('/saved $');

    mocks.startExecution.mockImplementationOnce(() => ({
      completion: Promise.reject(new Error('command failed')),
      cancel: vi.fn(),
    }));
    const textarea = wrapper.get('[data-testid="terminal-input"]');
    await textarea.setValue('pwd');
    await textarea.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(wrapper.text()).toContain('command failed');
    expect(wrapper.text()).toContain('/saved $');

    const { onRuntimeFailure } = mocks.createClient.mock.calls.at(-1)?.[0] as { onRuntimeFailure: () => void };
    onRuntimeFailure();
    await flushPromises();
    expect(wrapper.text()).not.toContain('/saved $');
  });
});
