import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { mount, flushPromises } from '@vue/test-utils';
import VolumeSettingsTab from './VolumeSettingsTab.vue';
import { storageService } from '@/00-storage/service';
import type { Volume, Mount } from '@/01-models/types';
import { toVolumeId } from '@/01-models/ids';
import { listLazyVolumeStates, publishLazyVolumeState, removeLazyVolumeState } from '@/00-storage/service/lazy-volume-state';

const mockShowConfirm = vi.hoisted(() => vi.fn());

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

// --- Mocks ---

vi.mock('@/utils/opfs-detection', () => ({
  checkOPFSSupport: vi.fn().mockResolvedValue(true),
  checkFileSystemAccessSupport: vi.fn().mockReturnValue(true),
}));

vi.mock('../composables/useToast', () => ({
  useToast: vi.fn(() => ({ addToast: vi.fn() })),
}));

vi.mock('../composables/useConfirm', () => ({
  useConfirm: vi.fn(() => ({ showConfirm: mockShowConfirm })),
}));

vi.mock('../00-storage/service', () => ({
  storageService: {
    listVolumes: vi.fn(),
    loadSettings: vi.fn(),
    renameVolume: vi.fn(),
    deleteVolume: vi.fn(),
    unmountVolume: vi.fn(),
    mountVolume: vi.fn(),
    createVolume: vi.fn(),
    createVolumeFromFiles: vi.fn(),
    getVolumeDirectoryHandle: vi.fn(),
    pauseLazyVolumeCopy: vi.fn(),
    retryLazyVolumeCopy: vi.fn(),
  },
}));

// --- Helpers ---

function makeVolume(overrides: Partial<Volume> = {}): Volume {
  return { id: toVolumeId({ raw: 'vol-1' }), name: 'My Docs', type: 'opfs', createdAt: 0, ...overrides };
}

function makeMount(volumeId: ReturnType<typeof toVolumeId>): Mount {
  return { type: 'volume', volumeId, mountPath: '/docs', readOnly: true };
}

function setupStorageMock(volumes: Volume[], mounts: Mount[]) {
  vi.mocked(storageService.listVolumes).mockReturnValue(
    (async function* () {
      yield* volumes;
    })(),
  );
  vi.mocked(storageService.loadSettings).mockResolvedValue({ mounts } as any);
}

const mountedWrappers: ReturnType<typeof mount>[] = [];

async function mountTab(volumes: Volume[], mounts: Mount[] = []) {
  setupStorageMock(volumes, mounts);
  const wrapper = mount(VolumeSettingsTab, { attachTo: document.body });
  mountedWrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

afterEach(() => {
  mountedWrappers.forEach(w => w.unmount());
  mountedWrappers.length = 0;
  for (const state of listLazyVolumeStates()) {
    removeLazyVolumeState({ volumeId: state.volume.id });
  }
});

// --- Tests ---

describe('VolumeSettingsTab - Lazy copies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adds a newly registered usable volume without reloading the lists on every progress update', async () => {
    const wrapper = await mountTab([], []);
    const volume = makeVolume({ id: toVolumeId({ raw: 'new-lazy-volume' }), name: 'New Project' });
    vi.mocked(storageService.listVolumes).mockImplementation(async function* () {
      yield volume;
    });
    const callsBeforeRegistration = vi.mocked(storageService.listVolumes).mock.calls.length;
    publishLazyVolumeState({ state: { volume, phase: 'copying', progress: { processed: 0, total: 2 }, error: undefined } });
    await flushPromises();
    const row = wrapper.get('[data-testid="volume-row-new-lazy-volume"]');
    expect(row.text()).toContain('New Project');
    expect(row.find('[data-testid="copy-progress"]').exists()).toBe(true);
    expect(row.text()).not.toContain('Copied Folder');
    expect(storageService.listVolumes).toHaveBeenCalledTimes(callsBeforeRegistration + 1);

    publishLazyVolumeState({ state: { volume, phase: 'copying', progress: { processed: 1, total: 2 }, error: undefined } });
    await flushPromises();
    expect(row.text()).toContain('1 / 2');
    expect(storageService.listVolumes).toHaveBeenCalledTimes(callsBeforeRegistration + 1);
  });

  it('keeps a newer registration visible when an older initial list request finishes late', async () => {
    const initial = Promise.withResolvers<void>();
    const stale = makeVolume({ id: toVolumeId({ raw: 'stale-volume' }), name: 'Old snapshot' });
    const current = makeVolume({ id: toVolumeId({ raw: 'current-volume' }), name: 'Current Project' });
    setupStorageMock([], []);
    vi.mocked(storageService.listVolumes)
      .mockImplementationOnce(async function* () {
        await initial.promise;
        yield stale;
      })
      .mockImplementation(async function* () {
        yield current;
      });
    const wrapper = mount(VolumeSettingsTab);
    mountedWrappers.push(wrapper);
    publishLazyVolumeState({ state: { volume: current, phase: 'copying', progress: { processed: 0, total: 2 }, error: undefined } });
    await flushPromises();
    expect(wrapper.text()).toContain('Current Project');
    initial.resolve();
    await flushPromises();
    expect(wrapper.text()).toContain('Current Project');
    expect(wrapper.text()).not.toContain('Old snapshot');
  });
});

describe('VolumeSettingsTab - Rename Volume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(storageService.renameVolume).mockResolvedValue(undefined);
  });

  describe('mounted volumes', () => {
    it('shows rename button for a mounted volume', async () => {
      const vol = makeVolume();
      const wrapper = await mountTab([vol], [makeMount(vol.id)]);
      expect(wrapper.find('[data-testid="volume-rename-btn"]').exists()).toBe(true);
    });

    it('clicking rename shows the name input pre-filled with the current name', async () => {
      const vol = makeVolume({ name: 'Old Name' });
      const wrapper = await mountTab([vol], [makeMount(vol.id)]);

      await wrapper.find('[data-testid="volume-rename-btn"]').trigger('click');
      await wrapper.vm.$nextTick();

      const input = wrapper.find<HTMLInputElement>('[data-testid="volume-name-input"]');
      expect(input.exists()).toBe(true);
      expect(input.element.value).toBe('Old Name');
    });

    it('save button calls renameVolume with the new name', async () => {
      const vol = makeVolume({ name: 'Old Name' });
      // Second call is for the reload after rename
      setupStorageMock([vol], [makeMount(vol.id)]);
      vi.mocked(storageService.listVolumes)
        .mockReturnValueOnce((async function* () {
          yield vol;
        })())
        .mockReturnValue((async function* () {
          yield vol;
        })());

      const wrapper = mount(VolumeSettingsTab);
      await flushPromises();

      await wrapper.find('[data-testid="volume-rename-btn"]').trigger('click');
      await wrapper.vm.$nextTick();

      await wrapper.find<HTMLInputElement>('[data-testid="volume-name-input"]').setValue('New Name');
      await wrapper.find('[data-testid="volume-name-save"]').trigger('click');
      await flushPromises();

      expect(storageService.renameVolume).toHaveBeenCalledWith({ volumeId: vol.id, name: 'New Name' });
    });

    it('pressing Enter saves the new name', async () => {
      const vol = makeVolume({ name: 'Old Name' });
      vi.mocked(storageService.listVolumes)
        .mockReturnValueOnce((async function* () {
          yield vol;
        })())
        .mockReturnValue((async function* () {
          yield vol;
        })());
      vi.mocked(storageService.loadSettings).mockResolvedValue({ mounts: [makeMount(vol.id)] } as any);

      const wrapper = mount(VolumeSettingsTab);
      await flushPromises();

      await wrapper.find('[data-testid="volume-rename-btn"]').trigger('click');
      await wrapper.vm.$nextTick();

      const input = wrapper.find<HTMLInputElement>('[data-testid="volume-name-input"]');
      await input.setValue('Enter Name');
      await input.trigger('keydown', { key: 'Enter' });
      await flushPromises();

      expect(storageService.renameVolume).toHaveBeenCalledWith({ volumeId: vol.id, name: 'Enter Name' });
    });

    it('cancel button dismisses the input without saving', async () => {
      const vol = makeVolume({ name: 'Old Name' });
      const wrapper = await mountTab([vol], [makeMount(vol.id)]);

      await wrapper.find('[data-testid="volume-rename-btn"]').trigger('click');
      await wrapper.vm.$nextTick();

      await wrapper.find('[data-testid="volume-name-cancel"]').trigger('click');
      await wrapper.vm.$nextTick();

      expect(wrapper.find('[data-testid="volume-name-input"]').exists()).toBe(false);
      expect(storageService.renameVolume).not.toHaveBeenCalled();
    });

    it('pressing Escape dismisses the input without saving', async () => {
      const vol = makeVolume({ name: 'Old Name' });
      const wrapper = await mountTab([vol], [makeMount(vol.id)]);

      await wrapper.find('[data-testid="volume-rename-btn"]').trigger('click');
      await wrapper.vm.$nextTick();

      await wrapper.find('[data-testid="volume-name-input"]').trigger('keydown', { key: 'Escape' });
      await wrapper.vm.$nextTick();

      expect(wrapper.find('[data-testid="volume-name-input"]').exists()).toBe(false);
      expect(storageService.renameVolume).not.toHaveBeenCalled();
    });

    it('shows a toast and does not save when name is blank', async () => {
      const { useToast } = await import('@/composables/useToast');
      const mockAddToast = vi.fn();
      vi.mocked(useToast).mockReturnValue({ addToast: mockAddToast } as any);

      const vol = makeVolume({ name: 'Old Name' });
      const wrapper = await mountTab([vol], [makeMount(vol.id)]);

      await wrapper.find('[data-testid="volume-rename-btn"]').trigger('click');
      await wrapper.vm.$nextTick();

      await wrapper.find<HTMLInputElement>('[data-testid="volume-name-input"]').setValue('   ');
      await wrapper.find('[data-testid="volume-name-save"]').trigger('click');
      await flushPromises();

      expect(storageService.renameVolume).not.toHaveBeenCalled();
      expect(mockAddToast).toHaveBeenCalledWith(expect.objectContaining({ message: 'Name cannot be empty' }));
    });
  });

  describe('unmounted volumes', () => {
    it('shows rename button for an unmounted volume', async () => {
      const wrapper = await mountTab([makeVolume()]);
      expect(wrapper.find('[data-testid="volume-rename-btn"]').exists()).toBe(true);
    });

    it('save button calls renameVolume for an unmounted volume', async () => {
      const vol = makeVolume({ name: 'Snapshot' });
      vi.mocked(storageService.listVolumes)
        .mockReturnValueOnce((async function* () {
          yield vol;
        })())
        .mockReturnValue((async function* () {
          yield vol;
        })());
      vi.mocked(storageService.loadSettings).mockResolvedValue({ mounts: [] } as any);

      const wrapper = mount(VolumeSettingsTab);
      await flushPromises();

      await wrapper.find('[data-testid="volume-rename-btn"]').trigger('click');
      await wrapper.vm.$nextTick();

      await wrapper.find<HTMLInputElement>('[data-testid="volume-name-input"]').setValue('Renamed Snapshot');
      await wrapper.find('[data-testid="volume-name-save"]').trigger('click');
      await flushPromises();

      expect(storageService.renameVolume).toHaveBeenCalledWith({ volumeId: vol.id, name: 'Renamed Snapshot' });
    });
  });
});

// --- Helpers for file input tests ---

function makeFileList(files: File[]): FileList {
  const fileList = Object.assign(
    { length: files.length, item: (i: number) => files[i] ?? null },
    files,
  );
  return fileList as unknown as FileList;
}

function makeFolderFile({ name, folderName }: { name: string, folderName: string }): File {
  const file = new File(['content'], name, { type: 'text/plain' });
  Object.defineProperty(file, 'webkitRelativePath', { value: `${folderName}/${name}` });
  return file;
}

describe('VolumeSettingsTab - Copy Folder / Copy File', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(storageService.mountVolume).mockResolvedValue(undefined as any);
    vi.mocked(storageService.listVolumes).mockReturnValue((async function* () {})());
    vi.mocked(storageService.loadSettings).mockResolvedValue({ mounts: [] } as any);
  });

  it('folder input has webkitdirectory, single-file input does not', async () => {
    const wrapper = await mountTab([]);
    const folderInput = wrapper.find<HTMLInputElement>('input[webkitdirectory]');
    const singleInput = wrapper.find<HTMLInputElement>('input:not([webkitdirectory])[type="file"]');
    expect(folderInput.exists()).toBe(true);
    expect(singleInput.exists()).toBe(true);
  });

  it('shows "Copying folder to browser..." label when copying a folder', async () => {
    let signalToUse: AbortSignal | undefined;
    vi.mocked(storageService.createVolumeFromFiles).mockImplementation(({ signal }) => {
      signalToUse = signal;
      return new Promise(() => {}); // never resolves
    });

    const wrapper = await mountTab([]);
    const folderInput = wrapper.find<HTMLInputElement>('input[webkitdirectory]');

    const file = makeFolderFile({ name: 'readme.md', folderName: 'my-docs' });
    Object.defineProperty(folderInput.element, 'files', { value: makeFileList([file]), configurable: true });
    await folderInput.trigger('change');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="copy-progress"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="copy-progress"]').text()).toContain('Copying folder to browser...');
    expect(signalToUse).toBeDefined();
  });

  it('shows "Copying file to browser..." label when copying a single file', async () => {
    vi.mocked(storageService.createVolumeFromFiles).mockImplementation(() => new Promise(() => {}));

    const wrapper = await mountTab([]);
    const singleInput = wrapper.find<HTMLInputElement>('input:not([webkitdirectory])[type="file"]');

    const file = new File(['content'], 'photo.jpg', { type: 'image/jpeg' });
    Object.defineProperty(singleInput.element, 'files', { value: makeFileList([file]), configurable: true });
    await singleInput.trigger('change');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="copy-progress"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="copy-progress"]').text()).toContain('Copying file to browser...');
  });

  it('cancel button aborts the copy and hides the progress UI', async () => {
    vi.mocked(storageService.createVolumeFromFiles).mockImplementation(({ signal }) => {
      return new Promise((_, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('Cancelled by user', 'AbortError'));
        });
      });
    });

    const wrapper = await mountTab([]);
    const folderInput = wrapper.find<HTMLInputElement>('input[webkitdirectory]');

    const file = makeFolderFile({ name: 'readme.md', folderName: 'my-docs' });
    Object.defineProperty(folderInput.element, 'files', { value: makeFileList([file]), configurable: true });
    await folderInput.trigger('change');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="copy-progress"]').exists()).toBe(true);

    await wrapper.find('[data-testid="copy-cancel-btn"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="copy-progress"]').exists()).toBe(false);
    expect(storageService.mountVolume).not.toHaveBeenCalled();
  });

  it('passes the abort signal to createVolumeFromFiles', async () => {
    let capturedSignal: AbortSignal | undefined;
    vi.mocked(storageService.createVolumeFromFiles).mockImplementation(({ signal }) => {
      capturedSignal = signal;
      return new Promise(() => {});
    });

    const wrapper = await mountTab([]);
    const folderInput = wrapper.find<HTMLInputElement>('input[webkitdirectory]');

    const file = makeFolderFile({ name: 'note.txt', folderName: 'notes' });
    Object.defineProperty(folderInput.element, 'files', { value: makeFileList([file]), configurable: true });
    await folderInput.trigger('change');
    await wrapper.vm.$nextTick();

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(false);

    await wrapper.find('[data-testid="copy-cancel-btn"]').trigger('click');

    expect(capturedSignal?.aborted).toBe(true);
  });

  it('passes entries (not FileList) to createVolumeFromFiles when copying a folder', async () => {
    let capturedEntries: Array<{ file: File, relativePath: string }> | undefined;
    vi.mocked(storageService.createVolumeFromFiles).mockImplementation(({ entries, signal }) => {
      capturedEntries = entries;
      return new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('', 'AbortError')));
      });
    });

    const wrapper = await mountTab([]);
    const folderInput = wrapper.find<HTMLInputElement>('input[webkitdirectory]');

    const file = makeFolderFile({ name: 'doc.txt', folderName: 'my-folder' });
    Object.defineProperty(folderInput.element, 'files', { value: makeFileList([file]), configurable: true });
    await folderInput.trigger('change');
    await wrapper.vm.$nextTick();

    expect(capturedEntries).toBeDefined();
    expect(capturedEntries![0]).toMatchObject({ relativePath: 'doc.txt' });
    expect(capturedEntries![0]!.file).toBe(file);
  });

  it('shows drag-over overlay on document dragenter and hides after matching dragleaves', async () => {
    const wrapper = await mountTab([]);
    expect(document.querySelector('[data-testid="drag-overlay"]')).toBeNull();

    document.dispatchEvent(new Event('dragenter'));
    await wrapper.vm.$nextTick();
    expect(document.querySelector('[data-testid="drag-overlay"]')).not.toBeNull();

    document.dispatchEvent(new Event('dragleave'));
    await wrapper.vm.$nextTick();
    expect(document.querySelector('[data-testid="drag-overlay"]')).toBeNull();
  });

  it('drag-over overlay stays visible when entering child elements (counter approach)', async () => {
    const wrapper = await mountTab([]);

    // Enter outer element, then inner child
    document.dispatchEvent(new Event('dragenter'));
    document.dispatchEvent(new Event('dragenter'));
    await wrapper.vm.$nextTick();
    expect(document.querySelector('[data-testid="drag-overlay"]')).not.toBeNull();

    // Leave child (counter goes 2→1, still visible)
    document.dispatchEvent(new Event('dragleave'));
    await wrapper.vm.$nextTick();
    expect(document.querySelector('[data-testid="drag-overlay"]')).not.toBeNull();

    // Leave outer (counter goes 1→0, now hidden)
    document.dispatchEvent(new Event('dragleave'));
    await wrapper.vm.$nextTick();
    expect(document.querySelector('[data-testid="drag-overlay"]')).toBeNull();
  });
});

describe('VolumeSettingsTab - Add Folder mode selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // @ts-expect-error: File System Access API mock
    window.showDirectoryPicker = vi.fn().mockResolvedValue({ name: 'TestFolder' });
    vi.mocked(storageService.listVolumes).mockReturnValue((async function* () {})());
    vi.mocked(storageService.loadSettings).mockResolvedValue({ mounts: [] } as any);
  });

  it('clicking Add Folder shows the mode selector panel', async () => {
    const wrapper = await mountTab([]);
    expect(document.querySelector('[data-testid="add-folder-mode-panel"]') !== null).toBe(false);

    await wrapper.find('[data-testid="add-folder-btn"]').trigger('click');
    await wrapper.vm.$nextTick();

    expect(document.querySelector('[data-testid="add-folder-mode-panel"]') !== null).toBe(true);
  });

  it('choosing Read Only calls showDirectoryPicker with mode read and mounts readOnly', async () => {
    const mockPicker = vi.fn().mockResolvedValue({ name: 'Documents' });
    // @ts-expect-error: File System Access API mock
    window.showDirectoryPicker = mockPicker;

    vi.mocked(storageService.createVolume).mockResolvedValue(makeVolume({ id: toVolumeId({ raw: 'new-vol' }), type: 'host' }));
    vi.mocked(storageService.mountVolume).mockResolvedValue(undefined as any);
    vi.mocked(storageService.listVolumes).mockReturnValue((async function* () {})());
    vi.mocked(storageService.loadSettings).mockResolvedValue({ mounts: [] } as any);

    const wrapper = await mountTab([]);
    await wrapper.find('[data-testid="add-folder-btn"]').trigger('click');
    await wrapper.vm.$nextTick();

    document.querySelector<HTMLButtonElement>('[data-testid="add-folder-read-only-btn"]')!.click();
    await flushPromises();

    expect(mockPicker).toHaveBeenCalledWith({ mode: 'read' });
    expect(storageService.mountVolume).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));
  });

  it('choosing Read & Write calls showDirectoryPicker with mode readwrite and mounts not readOnly', async () => {
    const mockPicker = vi.fn().mockResolvedValue({ name: 'Projects' });
    // @ts-expect-error: File System Access API mock
    window.showDirectoryPicker = mockPicker;

    vi.mocked(storageService.createVolume).mockResolvedValue(makeVolume({ id: toVolumeId({ raw: 'new-vol' }), type: 'host' }));
    vi.mocked(storageService.mountVolume).mockResolvedValue(undefined as any);
    vi.mocked(storageService.listVolumes).mockReturnValue((async function* () {})());
    vi.mocked(storageService.loadSettings).mockResolvedValue({ mounts: [] } as any);

    const wrapper = await mountTab([]);
    await wrapper.find('[data-testid="add-folder-btn"]').trigger('click');
    await wrapper.vm.$nextTick();

    document.querySelector<HTMLButtonElement>('[data-testid="add-folder-readwrite-btn"]')!.click();
    await flushPromises();

    expect(mockPicker).toHaveBeenCalledWith({ mode: 'readwrite' });
    expect(storageService.mountVolume).toHaveBeenCalledWith(expect.objectContaining({ readOnly: false }));
  });
});

describe('VolumeSettingsTab - Permission re-request on save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(storageService.unmountVolume).mockResolvedValue(undefined as any);
    vi.mocked(storageService.mountVolume).mockResolvedValue(undefined as any);
  });

  it('calls requestPermission for host volume when saving mount settings', async () => {
    const vol = makeVolume({ id: toVolumeId({ raw: 'vol-1' }), type: 'host' });
    const m = makeMount(vol.id);

    const queryPermission = vi.fn().mockResolvedValue('prompt');
    const requestPermission = vi.fn().mockResolvedValue('granted');
    const mockHandle = { queryPermission, requestPermission } as unknown as FileSystemDirectoryHandle;
    vi.mocked(storageService.getVolumeDirectoryHandle).mockResolvedValue(mockHandle);

    vi.mocked(storageService.listVolumes)
      .mockReturnValueOnce((async function* () {
        yield vol;
      })())
      .mockReturnValue((async function* () {
        yield vol;
      })());
    vi.mocked(storageService.loadSettings).mockResolvedValue({ mounts: [m] } as any);

    const wrapper = await mountTab([vol], [m]);

    await wrapper.find('[data-testid="volume-settings-btn"]').trigger('click');
    await wrapper.vm.$nextTick();
    await wrapper.find('[data-testid="mount-save-btn"]').trigger('click');
    await flushPromises();

    expect(storageService.getVolumeDirectoryHandle).toHaveBeenCalledWith({ volumeId: vol.id });
    expect(queryPermission).toHaveBeenCalledWith({ mode: 'read' });
    expect(requestPermission).toHaveBeenCalledWith({ mode: 'read' });
  });

  it('does not call requestPermission for opfs volumes', async () => {
    const vol = makeVolume({ id: toVolumeId({ raw: 'vol-1' }), type: 'opfs' });
    const m = makeMount(vol.id);

    vi.mocked(storageService.listVolumes)
      .mockReturnValueOnce((async function* () {
        yield vol;
      })())
      .mockReturnValue((async function* () {
        yield vol;
      })());
    vi.mocked(storageService.loadSettings).mockResolvedValue({ mounts: [m] } as any);

    const wrapper = await mountTab([vol], [m]);

    await wrapper.find('[data-testid="volume-settings-btn"]').trigger('click');
    await wrapper.vm.$nextTick();
    await wrapper.find('[data-testid="mount-save-btn"]').trigger('click');
    await flushPromises();

    expect(storageService.getVolumeDirectoryHandle).not.toHaveBeenCalled();
  });
});

describe('VolumeSettingsTab - Registered volume removal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockShowConfirm.mockReset().mockResolvedValue(true);
    vi.mocked(storageService.unmountVolume).mockResolvedValue(undefined);
    vi.mocked(storageService.deleteVolume).mockResolvedValue(undefined);
  });

  it.each(['host', 'opfs'] as const)('confirms registration removal before deleting a %s volume', async type => {
    const volume = makeVolume({ type });
    const wrapper = await mountTab([volume], [makeMount(volume.id)]);
    await wrapper.get('[data-testid="volume-delete-btn"]').trigger('click');
    await flushPromises();
    expect(mockShowConfirm).toHaveBeenCalledWith(expect.objectContaining({ confirmButtonVariant: 'danger' }));
    expect(storageService.unmountVolume).toHaveBeenCalledWith({ volumeId: volume.id });
    expect(storageService.deleteVolume).toHaveBeenCalledWith({ volumeId: volume.id });
  });

  it('keeps a registered volume and its mount when deletion is cancelled', async () => {
    mockShowConfirm.mockResolvedValue(false);
    const volume = makeVolume();
    const wrapper = await mountTab([volume], [makeMount(volume.id)]);
    await wrapper.get('[data-testid="volume-delete-btn"]').trigger('click');
    await flushPromises();
    expect(storageService.unmountVolume).not.toHaveBeenCalled();
    expect(storageService.deleteVolume).not.toHaveBeenCalled();
  });

  it('does not overwrite one registration confirmation by starting another', async () => {
    const approval = Promise.withResolvers<boolean>();
    mockShowConfirm.mockReturnValue(approval.promise);
    const first = makeVolume();
    const second = makeVolume({ id: toVolumeId({ raw: 'second-volume' }), name: 'Second' });
    const wrapper = await mountTab([first, second]);
    const buttons = wrapper.findAll('[data-testid="volume-delete-btn"]');
    expect(buttons).toHaveLength(2);
    await buttons[0]?.trigger('click');
    await flushPromises();
    expect(buttons[1]?.attributes('disabled')).toBeDefined();
    await buttons[1]?.trigger('click');
    expect(mockShowConfirm).toHaveBeenCalledTimes(1);
    approval.resolve(false);
    await flushPromises();
    expect(buttons.every(button => button.attributes('disabled') === undefined)).toBe(true);
    expect(storageService.deleteVolume).not.toHaveBeenCalled();
  });
});
