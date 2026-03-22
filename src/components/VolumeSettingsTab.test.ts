import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import VolumeSettingsTab from './VolumeSettingsTab.vue';
import { storageService } from '@/services/storage';
import type { Volume, Mount } from '@/models/types';

// --- Mocks ---

vi.mock('@/services/storage/opfs-detection', () => ({
  checkOPFSSupport: vi.fn().mockResolvedValue(true),
  checkFileSystemAccessSupport: vi.fn().mockReturnValue(true),
}));

vi.mock('../composables/useToast', () => ({
  useToast: vi.fn(() => ({ addToast: vi.fn() })),
}));

vi.mock('../composables/useConfirm', () => ({
  useConfirm: vi.fn(() => ({ showConfirm: vi.fn() })),
}));

vi.mock('../services/storage', () => ({
  storageService: {
    listVolumes: vi.fn(),
    loadSettings: vi.fn(),
    renameVolume: vi.fn(),
    deleteVolume: vi.fn(),
    unmountVolume: vi.fn(),
    mountVolume: vi.fn(),
    createVolume: vi.fn(),
    createVolumeFromFiles: vi.fn(),
  },
}));

// --- Helpers ---

function makeVolume(overrides: Partial<Volume> = {}): Volume {
  return { id: 'vol-1', name: 'My Docs', type: 'opfs', createdAt: 0, ...overrides };
}

function makeMount(volumeId: string): Mount {
  return { type: 'volume', volumeId, mountPath: '/docs', readOnly: true };
}

function setupStorageMock(volumes: Volume[], mounts: Mount[]) {
  vi.mocked(storageService.listVolumes).mockReturnValue(
    (async function* () {
      yield* volumes;
    })()
  );
  vi.mocked(storageService.loadSettings).mockResolvedValue({ mounts } as any);
}

async function mountTab(volumes: Volume[], mounts: Mount[] = []) {
  setupStorageMock(volumes, mounts);
  const wrapper = mount(VolumeSettingsTab);
  await flushPromises();
  return wrapper;
}

// --- Tests ---

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
      const { useToast } = await import('../composables/useToast');
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
