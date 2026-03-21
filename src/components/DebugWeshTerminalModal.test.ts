import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import DebugWeshTerminalModal from './DebugWeshTerminalModal.vue';

const mocks = vi.hoisted(() => ({
  execute: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
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
  Play: { template: '<span>Play</span>' },
  Plus: { template: '<span>Plus</span>' },
}));

describe('DebugWeshTerminalModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.showConfirm.mockResolvedValue(true);
    mocks.createClient.mockResolvedValue({
      execute: mocks.execute,
      interrupt: vi.fn(),
      dispose: mocks.dispose,
    });
    const globalRoot = {
      name: 'global-root',
      getDirectoryHandle: vi.fn(),
    } as unknown as FileSystemDirectoryHandle;
    const debugRoot = {
      name: 'naidan-debug-wesh',
      getDirectoryHandle: vi.fn().mockResolvedValue(globalRoot),
    } as unknown as FileSystemDirectoryHandle;
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

    expect(mocks.createClient).toHaveBeenCalledWith(expect.objectContaining({
      rootHandle: expect.any(Object),
      mounts: [
        {
          path: '/data',
          handle: expect.any(Object),
          readOnly: true,
        },
      ],
      user: 'debug',
      initialEnv: {},
      initialCwd: undefined,
    }));
    expect(wrapper.text()).toContain('Session 1');
    expect(wrapper.text()).toContain('New Session');
    expect(wrapper.text()).not.toContain('/naidan-debug-wesh/global');
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

  it('hides the next prompt while a command is running', async () => {
    let resolveExecute: ((value: { exitCode: number; stdout: string; stderr: string }) => void) | undefined;
    mocks.execute.mockImplementation(() => new Promise((resolve) => {
      resolveExecute = resolve;
    }));

    const wrapper = mount(DebugWeshTerminalModal, {
      props: { isOpen: true },
    });
    await flushPromises();

    const textarea = wrapper.get('textarea');
    await textarea.setValue('pwd');
    const runButton = wrapper.findAll('button').find(button => button.text() === 'Run');
    expect(runButton).toBeTruthy();
    await runButton!.trigger('click');

    expect(wrapper.text()).toContain('Running...');
    expect(wrapper.find('textarea').exists()).toBe(false);

    resolveExecute?.({ exitCode: 0, stdout: '', stderr: '' });
    await flushPromises();
    expect(wrapper.find('textarea').exists()).toBe(true);
  });
});
