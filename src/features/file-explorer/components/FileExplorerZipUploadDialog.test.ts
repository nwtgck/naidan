import { reactive } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { UploadIcon } from 'lucide-vue-next';

import { ensureAllStringsForTest } from '@/strings/test-utils';
import { FILE_EXPLORER_INJECTION_KEY } from '@/features/file-explorer/composables/useFileExplorer';
import type {
  FileExplorerContext,
  ZipUploadState,
} from '@/features/file-explorer/logic/types';
import FileExplorerZipUploadDialog from './FileExplorerZipUploadDialog.vue';

function createState(): ZipUploadState {
  return reactive({
    visibility: 'visible',
    phase: 'configuring',
    currentFileName: 'backup.zip',
    currentFileSize: 32,
    targetDirectoryPath: '/uploads',
    currentZipIndex: 0,
    totalZipCount: 1,
    extractability: 'extractable',
    singleRootDirectoryName: 'workspace',
    placement: { kind: 'keep_archive' },
    previewRelativePath: '',
    previewPathSegments: [],
    previewEntries: [],
    previewSummary: {
      addedCount: 1,
      mergedCount: 0,
      replacedCount: 0,
      blockedCount: 0,
    },
    errorMessage: undefined,
  });
}

function mountDialog() {
  const state = createState();
  const context = {
    currentDirectoryPath: '/uploads',
    upload: {
      state,
      begin: vi.fn(),
      setPlacement: vi.fn(async ({ placement }) => {
        state.placement = placement;
      }),
      navigatePreview: vi.fn(),
      confirm: vi.fn(),
      close: vi.fn(),
      dispose: vi.fn(),
    },
  } as unknown as FileExplorerContext;
  const wrapper = mount(FileExplorerZipUploadDialog, {
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
  return { wrapper, context, state };
}

describe('FileExplorerZipUploadDialog', () => {
  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
  });

  it('shows modal-side preview without redundant ZIP analysis descriptions', () => {
    const { wrapper } = mountDialog();

    expect(wrapper.find('[data-testid="zip-upload-preview"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('ZIP was analyzed');
    expect(wrapper.text()).not.toContain('current and planned items');
  });

  it('uses the existing upward upload icon and keeps cancel before upload', () => {
    const { wrapper } = mountDialog();
    const cancel = wrapper.get('[data-testid="zip-upload-cancel"]');
    const confirm = wrapper.get('[data-testid="zip-upload-confirm"]');

    expect(wrapper.findComponent(UploadIcon).exists()).toBe(true);
    expect(cancel.element.compareDocumentPosition(confirm.element) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });


  it('shows root handling only after extraction is selected', async () => {
    const { wrapper, context } = mountDialog();

    expect(wrapper.find('[data-testid="zip-root-preserve"]').exists()).toBe(false);
    await wrapper.get('[data-testid="zip-placement-extract"]').setValue(true);

    expect(context.upload.setPlacement).toHaveBeenCalledWith({
      placement: { kind: 'extract', rootHandling: 'preserve' },
    });
    expect(wrapper.find('[data-testid="zip-root-preserve"]').exists()).toBe(true);
  });
});
