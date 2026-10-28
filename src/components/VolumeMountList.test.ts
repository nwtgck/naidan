import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mount, Volume } from '@/01-models/types';
import { toVolumeId } from '@/01-models/ids';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import VolumeMountList from './VolumeMountList.vue';
import { storageService } from '@/00-storage/service';
import { listLazyVolumeStates, publishLazyVolumeState, removeLazyVolumeState } from '@/00-storage/service/lazy-volume-state';

vi.mock('@/composables/useToast', () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock('@/00-storage/service', () => ({ storageService: { pauseLazyVolumeCopy: vi.fn(), retryLazyVolumeCopy: vi.fn() } }));

const activeId = toVolumeId({ raw: 'active-volume' });
const availableId = toVolumeId({ raw: 'available-volume' });
const volumes: Volume[] = [
  { id: activeId, name: 'Documents', type: 'opfs', createdAt: 0 },
  { id: availableId, name: 'Project Notes', type: 'host', createdAt: 1 },
];
const activeMount: Mount = { type: 'volume', volumeId: activeId, mountPath: '/project-notes', readOnly: true };

beforeEach(async () => {
  vi.clearAllMocks();
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  for (const state of listLazyVolumeStates()) {
    removeLazyVolumeState({ volumeId: state.volume.id });
  }
});

function mountList({ management }: { management: boolean }) {
  const host = document.createElement('div');
  document.body.append(host);
  const wrapper = mount(VolumeMountList, {
    attachTo: host,
    props: { volumes, mounts: [activeMount], showVolumeManagement: management, mountPathPrefix: '/', deletionPending: false },
  });
  return {
    wrapper,
    [Symbol.dispose]() {
      wrapper.unmount();
      host.remove();
    },
  };
}

describe('VolumeMountList', () => {
  it('keeps active and available volumes separate without automatically mounting anything', () => {
    using view = mountList({ management: true });
    expect(view.wrapper.get('[data-testid="volume-section-mounted"]').text()).toContain('Documents');
    expect(view.wrapper.get('[data-testid="volume-section-available"]').text()).toContain('Project Notes');
    expect(view.wrapper.emitted('add')).toBeUndefined();
    expect(view.wrapper.emitted('remove')).toBeUndefined();
  });

  it('starts using an available volume with a unique root path and read-only access', async () => {
    using view = mountList({ management: true });
    await view.wrapper.get('[data-testid="volume-add-btn-available-volume"]').trigger('click');
    expect(view.wrapper.emitted('add')).toEqual([[{ volumeId: availableId, mountPath: '/project-notes-2', readOnly: true }]]);
    expect(view.wrapper.emitted('delete-volume')).toBeUndefined();
  });

  it('keeps stopping use separate from deleting a registered volume', async () => {
    using view = mountList({ management: true });
    await view.wrapper.get('[data-testid="volume-stop-using-btn"]').trigger('click');
    expect(view.wrapper.emitted('remove')).toEqual([[{ volumeId: activeId }]]);
    expect(view.wrapper.emitted('delete-volume')).toBeUndefined();
    await view.wrapper.get('[data-testid="volume-row-active-volume"]').get('[data-testid="volume-delete-btn"]').trigger('click');
    expect(view.wrapper.emitted('delete-volume')).toEqual([[{ volumeId: activeId }]]);
  });

  it('keeps path and access changes in the draft until Save', async () => {
    using view = mountList({ management: true });
    await view.wrapper.get('[data-testid="volume-settings-btn"]').trigger('click');
    await view.wrapper.get('[data-testid="volume-path-input"]').setValue('updated');
    await view.wrapper.get('[data-testid="volume-access-read-write"]').trigger('click');
    expect(view.wrapper.emitted('update-mount')).toBeUndefined();
    expect(view.wrapper.props('mounts')[0]?.readOnly).toBe(true);
    await view.wrapper.get('[data-testid="mount-save-btn"]').trigger('click');
    expect(view.wrapper.emitted('update-mount')).toEqual([[{ volumeId: activeId, mountPath: '/updated', readOnly: false }]]);
    expect(view.wrapper.find('[data-testid="volume-path-input"]').exists()).toBe(false);
  });

  it('discards the draft on Cancel and restores persisted values on the next edit', async () => {
    using view = mountList({ management: true });
    await view.wrapper.get('[data-testid="volume-settings-btn"]').trigger('click');
    await view.wrapper.get('[data-testid="volume-path-input"]').setValue('/discarded');
    await view.wrapper.get('[data-testid="volume-access-read-write"]').trigger('click');
    await view.wrapper.get('[data-testid="volume-settings-cancel"]').trigger('click');
    expect(view.wrapper.emitted('update-mount')).toBeUndefined();
    await view.wrapper.get('[data-testid="volume-settings-btn"]').trigger('click');
    expect(view.wrapper.get<HTMLInputElement>('[data-testid="volume-path-input"]').element.value).toBe('/project-notes');
    expect(view.wrapper.get('[data-testid="volume-access-read-only"]').attributes('aria-pressed')).toBe('true');
  });

  it('closes only the editor on Escape and returns keyboard focus to Configure', async () => {
    using view = mountList({ management: true });
    const configure = view.wrapper.get<HTMLButtonElement>('[data-testid="volume-settings-btn"]');
    configure.element.focus();
    await configure.trigger('click');
    const input = view.wrapper.get<HTMLInputElement>('[data-testid="volume-path-input"]');
    input.element.focus();
    await input.trigger('keydown', { key: 'Escape' });
    expect(view.wrapper.find('[data-testid="volume-path-input"]').exists()).toBe(false);
    expect(configure.attributes('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(configure.element);
    expect(view.wrapper.emitted('update-mount')).toBeUndefined();
  });

  it('does not expose registry management when it is disabled', () => {
    using view = mountList({ management: false });
    expect(view.wrapper.find('[data-testid="volume-rename-btn"]').exists()).toBe(false);
    expect(view.wrapper.find('[data-testid="volume-delete-btn"]').exists()).toBe(false);
    expect(view.wrapper.find('[data-testid="volume-add-btn-available-volume"]').exists()).toBe(true);
    expect(view.wrapper.find('[data-testid="volume-stop-using-btn"]').exists()).toBe(true);
  });

  it('shows unfinished storage without calling the folder copied and shares pause/resume actions', async () => {
    const volume = volumes[0];
    if (volume === undefined) {
      throw new Error('Expected active volume');
    }
    publishLazyVolumeState({ state: { volume, phase: 'copying', progress: { processed: 0, total: 2 }, error: undefined } });
    using view = mountList({ management: true });
    const row = view.wrapper.get('[data-testid="volume-row-active-volume"]');
    expect(row.find('[data-testid="copy-progress"]').exists()).toBe(true);
    expect(row.text()).not.toContain('Copied Folder');
    await row.get('[data-testid="copy-pause-btn"]').trigger('click');
    await flushPromises();
    expect(storageService.pauseLazyVolumeCopy).toHaveBeenCalledWith({ volumeId: activeId });
    expect(view.wrapper.emitted('remove')).toBeUndefined();
    expect(view.wrapper.emitted('delete-volume')).toBeUndefined();

    publishLazyVolumeState({ state: { volume, phase: 'paused', progress: { processed: 1, total: 2 }, error: undefined } });
    await flushPromises();
    await row.get('[data-testid="copy-resume-btn"]').trigger('click');
    await flushPromises();
    expect(storageService.retryLazyVolumeCopy).toHaveBeenCalledWith({ volumeId: activeId });

    publishLazyVolumeState({ state: { volume, phase: 'saved', progress: { processed: 2, total: 2 }, error: undefined } });
    await flushPromises();
    expect(row.find('[data-testid="copy-progress"]').exists()).toBe(false);
    expect(row.text()).toContain('Copied Folder');
  });
});
