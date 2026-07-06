import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import DeveloperDataDeletionPanel from './DeveloperDataDeletionPanel.vue';
import { useConfirm } from '@/composables/useConfirm';
import { ensureAllStringsForTest } from '@/strings/test-utils';

const routerMocks = vi.hoisted(() => ({
  replace: vi.fn(),
}));

vi.mock('@/composables/useConfirm', () => ({
  useConfirm: vi.fn(),
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({
    replace: routerMocks.replace,
  }),
}));

describe('DeveloperDataDeletionPanel', () => {
  const showConfirm = vi.fn();
  const reloadPage = vi.fn();

  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
    vi.clearAllMocks();
    routerMocks.replace.mockResolvedValue(undefined);
    localStorage.clear();
    reloadPage.mockReset();
    (useConfirm as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      showConfirm,
    });
  });


  function mountPanel() {
    return mount(DeveloperDataDeletionPanel, {
      props: {
        storageType: 'opfs',
        reloadPage,
      },
    });
  }

  it('shows only normal selectors until advanced mode is enabled', async () => {
    const wrapper = mountPanel();

    expect(wrapper.find('[data-testid="data-deletion-checkbox-local-storage-naidan-all"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="data-deletion-checkbox-local-storage-theme-mode"]').exists()).toBe(false);

    await wrapper.find('[data-testid="data-deletion-advanced-mode-checkbox"]').setValue(true);

    expect(wrapper.find('[data-testid="data-deletion-checkbox-local-storage-theme-mode"]').exists()).toBe(true);
  });

  it('applies the Factory Reset preset including Cache Storage all caches', async () => {
    const wrapper = mountPanel();

    await wrapper.find('[data-testid="data-deletion-factory-reset-preset-button"]').trigger('click');

    for (const id of [
      'local-storage-naidan-all',
      'opfs-naidan-storage',
      'opfs-naidan-tmp',
      'opfs-models',
      'indexed-db-naidan-volumes',
      'cache-storage-all',
    ]) {
      const input = wrapper.find<HTMLInputElement>(`[data-testid="data-deletion-checkbox-${id}"]`);
      expect(input.element.checked).toBe(true);
    }
  });

  it('keeps unavailable storage selectors checkable while showing a warning', async () => {
    const wrapper = mountPanel();

    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="data-deletion-option-warning-opfs-naidan-storage"]').exists()).toBe(true);
    });

    const input = wrapper.find<HTMLInputElement>('[data-testid="data-deletion-checkbox-opfs-naidan-storage"]');
    expect(input.exists()).toBe(true);
    expect(input.attributes('disabled')).toBeUndefined();
  });

  it('uses the existing Danger Zone red button style for destructive deletion', () => {
    const wrapper = mountPanel();
    const button = wrapper.find('[data-testid="setting-reset-data-button"]');

    expect(button.classes()).toEqual(expect.arrayContaining([
      'bg-red-600',
      'hover:bg-red-700',
      'shadow-red-500/20',
    ]));
  });


  it('keeps the destructive delete button above the preview panel', () => {
    const wrapper = mountPanel();
    const button = wrapper.find('[data-testid="setting-reset-data-button"]').element;
    const previewPanel = wrapper.find('[data-testid="data-deletion-preview-panel"]').element;

    expect(Boolean(button.compareDocumentPosition(previewPanel) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it('confirms deletion with the danger variant', async () => {
    showConfirm.mockResolvedValue(false);
    const wrapper = mountPanel();

    await wrapper.find('[data-testid="data-deletion-factory-reset-preset-button"]').trigger('click');
    await nextTick();
    const deleteButton = wrapper.find('[data-testid="setting-reset-data-button"]');
    await vi.waitFor(() => {
      expect(deleteButton.attributes('disabled')).toBeUndefined();
    });
    await deleteButton.trigger('click');

    await vi.waitFor(() => {
      expect(showConfirm).toHaveBeenCalledWith({
        title: 'Delete selected data?',
        message: expect.stringContaining('Current storage provider: opfs'),
        confirmButtonText: 'Delete selected data',
        confirmButtonVariant: 'danger',
      });
    });
  });

  it('resets the route to the initial route before reloading after successful deletion', async () => {
    showConfirm.mockResolvedValue(true);
    const wrapper = mountPanel();

    await wrapper.find('[data-testid="data-deletion-checkbox-local-storage-naidan-all"]').setValue(true);
    const deleteButton = wrapper.find('[data-testid="setting-reset-data-button"]');
    await vi.waitFor(() => {
      expect(deleteButton.attributes('disabled')).toBeUndefined();
    });
    await deleteButton.trigger('click');

    await vi.waitFor(() => {
      expect(routerMocks.replace).toHaveBeenCalledWith('/');
      expect(reloadPage).toHaveBeenCalled();
    });
  });
});
