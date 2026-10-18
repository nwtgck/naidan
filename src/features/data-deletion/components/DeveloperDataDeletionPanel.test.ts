import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import DeveloperDataDeletionPanel from './DeveloperDataDeletionPanel.vue';
import { useConfirm } from '@/composables/useConfirm';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import * as dataDeletion from '@/features/data-deletion/logic/data-deletion';

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

  it('clears the Factory Reset selection and preview without deleting data and allows reselection', async () => {
    localStorage.setItem('naidan:lsp:settings', '{"kept":true}');
    localStorage.setItem('other:shared', 'kept');
    using executeDeletion = vi.spyOn(dataDeletion, 'executeDataDeletion');
    const wrapper = mountPanel();
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    const clearButton = wrapper.get('[data-testid="data-deletion-clear-all-selections-button"]');
    const deleteButton = wrapper.get('[data-testid="setting-reset-data-button"]');
    const previewPanel = wrapper.get('[data-testid="data-deletion-preview-panel"]');

    expect(clearButton.text()).toBe('Clear all selections');
    expect(clearButton.attributes('disabled')).toBeDefined();
    expect(deleteButton.attributes('disabled')).toBeDefined();

    await wrapper.get('[data-testid="data-deletion-factory-reset-preset-button"]').trigger('click');
    expect(clearButton.attributes('disabled')).toBeUndefined();
    await vi.waitFor(() => {
      expect(previewPanel.text()).toContain('naidan:lsp:settings');
    });

    await clearButton.trigger('click');
    await flushPromises();

    for (const input of wrapper.findAll<HTMLInputElement>('[data-testid^="data-deletion-checkbox-"]')) {
      expect(input.element.checked).toBe(false);
    }
    expect(clearButton.attributes('disabled')).toBeDefined();
    expect(deleteButton.attributes('disabled')).toBeDefined();
    expect(previewPanel.text()).toContain('No matching entries.');
    expect(previewPanel.text()).not.toContain('naidan:lsp:settings');
    expect(localStorage.getItem('naidan:lsp:settings')).toBe('{"kept":true}');
    expect(localStorage.getItem('other:shared')).toBe('kept');
    expect(executeDeletion).not.toHaveBeenCalled();
    expect(showConfirm).not.toHaveBeenCalled();
    expect(routerMocks.replace).not.toHaveBeenCalled();
    expect(reloadPage).not.toHaveBeenCalled();

    const selector = wrapper.get<HTMLInputElement>('[data-testid="data-deletion-checkbox-local-storage-naidan-all"]');
    await selector.setValue(true);
    await flushPromises();

    expect(selector.element.checked).toBe(true);
    expect(clearButton.attributes('disabled')).toBeUndefined();
    expect(deleteButton.attributes('disabled')).toBeUndefined();
    expect(previewPanel.text()).toContain('naidan:lsp:settings');
  });

  it('clears advanced selections while their selectors are hidden', async () => {
    const wrapper = mountPanel();
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    const advancedMode = wrapper.get('[data-testid="data-deletion-advanced-mode-checkbox"]');
    const clearButton = wrapper.get('[data-testid="data-deletion-clear-all-selections-button"]');

    await advancedMode.setValue(true);
    await wrapper.get('[data-testid="data-deletion-checkbox-local-storage-theme-mode"]').setValue(true);
    await advancedMode.setValue(false);

    expect(wrapper.find('[data-testid="data-deletion-checkbox-local-storage-theme-mode"]').exists()).toBe(false);
    expect(clearButton.attributes('disabled')).toBeUndefined();

    await clearButton.trigger('click');
    await advancedMode.setValue(true);

    expect(wrapper.get<HTMLInputElement>('[data-testid="data-deletion-checkbox-local-storage-theme-mode"]').element.checked).toBe(false);
    expect(clearButton.attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="setting-reset-data-button"]').attributes('disabled')).toBeDefined();
  });

  it('keeps the preview empty when an older scan finishes after clearing selections', async () => {
    const wrapper = mountPanel();
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await flushPromises();
    const pending = Promise.withResolvers<dataDeletion.DataDeletionPreview>();
    using _previewSpy = vi.spyOn(dataDeletion, 'createDataDeletionPreview').mockReturnValueOnce(pending.promise);
    const previewPanel = wrapper.get('[data-testid="data-deletion-preview-panel"]');

    await wrapper.get('[data-testid="data-deletion-checkbox-local-storage-naidan-all"]').setValue(true);
    expect(previewPanel.text()).toContain('Scanning storage');
    await wrapper.get('[data-testid="data-deletion-clear-all-selections-button"]').trigger('click');
    await flushPromises();
    expect(previewPanel.text()).toContain('No matching entries.');

    pending.resolve({
      status: 'ready',
      entries: [{ path: 'stale-entry', location: 'localStorage' }],
      notes: [],
    });
    await flushPromises();

    expect(previewPanel.text()).toContain('No matching entries.');
    expect(previewPanel.text()).not.toContain('stale-entry');
    expect(wrapper.get('[data-testid="setting-reset-data-button"]').attributes('disabled')).toBeDefined();
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
