import { nextTick } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';

import { FILE_EXPLORER_INJECTION_KEY } from '@/features/file-explorer/composables/useFileExplorer';
import { useFileExplorerDirectoryDownload } from '@/features/file-explorer/composables/useFileExplorerDirectoryDownload';
import type { FileExplorerContext } from '@/features/file-explorer/logic/types';
import type { FileExplorerWorkerClient } from '@/features/file-explorer/worker/types';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import FileExplorerDirectoryDownloadDialog from './FileExplorerDirectoryDownloadDialog.vue';

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));

function createClient(): FileExplorerWorkerClient {
  return {
    readDirectory: vi.fn(),
    readPreview: vi.fn(),
    readFile: vi.fn(),
    suggestArchiveExclusions: vi.fn().mockResolvedValue({ suggestions: [], resultState: 'complete' }),
    startDirectoryArchive: vi.fn(() => ({
      result: Promise.resolve({ status: 'cancelled' as const }),
      cancel: vi.fn().mockResolvedValue(undefined),
    })),
    createFile: vi.fn(),
    createFolder: vi.fn(),
    deleteEntries: vi.fn(),
    renameEntry: vi.fn(),
    copyEntries: vi.fn(),
    moveEntries: vi.fn(),
    uploadFiles: vi.fn(),
    dispose: vi.fn(),
  } as unknown as FileExplorerWorkerClient;
}

function mountDialog() {
  const controller = useFileExplorerDirectoryDownload({ client: createClient() });
  controller.open({ target: { path: '/hoge/my-project', name: 'my-project' } });
  const context = { directoryDownload: controller } as unknown as FileExplorerContext;
  const wrapper = mount(FileExplorerDirectoryDownloadDialog, {
    attachTo: document.body,
    global: {
      provide: {
        [FILE_EXPLORER_INJECTION_KEY as symbol]: context,
      },
      stubs: {
        Teleport: true,
      },
    },
  });
  return { wrapper, controller };
}

describe('FileExplorerDirectoryDownloadDialog', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    await ensureAllStringsForTest({ locale: 'en' });
  });

  it('shows archive and exclusion controls without source, summary, or worker status', async () => {
    const { wrapper, controller } = mountDialog();
    await nextTick();
    await nextTick();

    expect(wrapper.get('[data-testid="directory-download-archive-name"]').attributes('value')).toBe('my-project');
    expect(wrapper.find('[data-testid="directory-download-exclusion-input"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('/hoge/my-project');
    expect(wrapper.text()).not.toContain('1 directory');
    expect(wrapper.text()).not.toContain('Web Worker');

    controller.dispose();
    wrapper.unmount();
  });

  it('uses Enter to apply a suggestion and a second Enter to add it', async () => {
    const { wrapper, controller } = mountDialog();
    controller.state.suggestionStatus = 'ready';
    controller.state.suggestions = [
      { relativePath: 'src/components', name: 'components', kind: 'directory' },
    ];
    controller.state.selectedSuggestionIndex = 0;
    await nextTick();

    await wrapper.get('[data-testid="directory-download-exclusion-input"]').trigger('keydown', { key: 'Enter' });
    await nextTick();

    expect(controller.state.query).toBe('src/components');
    expect(controller.state.exclusions).toEqual([]);
    expect(wrapper.find('[data-testid="directory-download-suggestions"]').exists()).toBe(false);

    await wrapper.get('[data-testid="directory-download-exclusion-input"]').trigger('keydown', { key: 'Enter' });
    await nextTick();

    expect(controller.state.exclusions[0]?.relativePath).toBe('src/components');
    expect(wrapper.findAll('[data-testid="directory-download-exclusion-chip"]')).toHaveLength(1);

    controller.dispose();
    wrapper.unmount();
  });

  it('applies a clicked suggestion without adding it, then adds it with the button', async () => {
    const { wrapper, controller } = mountDialog();
    controller.state.suggestionStatus = 'ready';
    controller.state.suggestions = [
      { relativePath: 'src', name: 'src', kind: 'directory' },
    ];
    controller.state.selectedSuggestionIndex = 0;
    await nextTick();

    await wrapper.get('[data-testid="directory-download-suggestion"]').trigger('click');
    await nextTick();

    expect(controller.state.query).toBe('src');
    expect(controller.state.exclusions).toEqual([]);
    expect(wrapper.find('[data-testid="directory-download-suggestions"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="directory-download-add-exclusion"]').attributes('disabled')).toBeUndefined();

    await wrapper.get('[data-testid="directory-download-add-exclusion"]').trigger('click');
    await nextTick();

    expect(controller.state.exclusions[0]?.relativePath).toBe('src');
    expect(wrapper.findAll('[data-testid="directory-download-exclusion-chip"]')).toHaveLength(1);

    controller.dispose();
    wrapper.unmount();
  });

  it('closes suggestions when focus moves to the download button', async () => {
    const { wrapper, controller } = mountDialog();
    controller.state.suggestionStatus = 'ready';
    controller.state.suggestions = [
      { relativePath: 'src', name: 'src', kind: 'directory' },
    ];
    await nextTick();

    const input = wrapper.get('[data-testid="directory-download-exclusion-input"]');
    const confirm = wrapper.get('[data-testid="directory-download-confirm"]');
    input.element.dispatchEvent(new FocusEvent('focusout', {
      bubbles: true,
      relatedTarget: confirm.element,
    }));
    await nextTick();

    expect(wrapper.find('[data-testid="directory-download-suggestions"]').exists()).toBe(false);
    expect(controller.state.suggestionStatus).toBe('idle');

    controller.dispose();
    wrapper.unmount();
  });

  it('closes suggestions without closing the dialog when Escape is pressed in the input', async () => {
    const { wrapper, controller } = mountDialog();
    controller.state.suggestionStatus = 'ready';
    controller.state.suggestions = [
      { relativePath: 'src', name: 'src', kind: 'directory' },
    ];
    await nextTick();

    await wrapper.get('[data-testid="directory-download-exclusion-input"]').trigger('keydown', { key: 'Escape' });
    await nextTick();

    expect(controller.state.suggestionStatus).toBe('idle');
    expect(controller.state.visibility).toBe('visible');

    controller.dispose();
    wrapper.unmount();
  });

  it('connects the combobox to its active option and shows truncated-result guidance', async () => {
    const { wrapper, controller } = mountDialog();
    controller.state.suggestionStatus = 'ready';
    controller.state.suggestionResultState = 'truncated';
    controller.state.suggestions = [
      { relativePath: 'src', name: 'src', kind: 'directory' },
    ];
    controller.state.selectedSuggestionIndex = 0;
    await nextTick();

    const input = wrapper.get('[data-testid="directory-download-exclusion-input"]');
    expect(input.attributes('aria-expanded')).toBe('true');
    expect(input.attributes('aria-activedescendant')).toBe('directory-download-suggestion-0');
    expect(wrapper.get('[data-testid="directory-download-suggestion"]').attributes('id')).toBe('directory-download-suggestion-0');
    expect(wrapper.text()).toContain('Type to narrow the results');

    controller.dispose();
    wrapper.unmount();
  });

  it('distinguishes no matches from a suggestion loading failure', async () => {
    const { wrapper, controller } = mountDialog();
    controller.state.suggestionStatus = 'ready';
    await nextTick();
    expect(wrapper.text()).toContain('No matching items');

    controller.state.suggestionStatus = 'error';
    await nextTick();
    expect(wrapper.text()).toContain('Failed to load exclusion suggestions');

    controller.dispose();
    wrapper.unmount();
  });
});
