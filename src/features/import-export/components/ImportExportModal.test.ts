import { mount, flushPromises } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import ImportExportModal from './ImportExportModal.vue';

const mocks = vi.hoisted(() => ({
  addToast: vi.fn(),
  exportData: vi.fn(),
}));

vi.mock('@/features/import-export/service', () => ({
  ImportExportService: class {
    analyze = vi.fn();
    executeImport = vi.fn();
    exportData = mocks.exportData;
    verify = vi.fn();
  },
}));

vi.mock('@/00-storage/service', () => ({
  storageService: {},
}));


vi.mock('@/composables/useToast', () => ({
  useToast: vi.fn(() => ({
    addToast: mocks.addToast,
  })),
}));

function mountModal() {
  return mount(ImportExportModal, {
    props: { isOpen: true },
    global: {
      stubs: {
        Teleport: true,
      },
    },
  });
}

async function openExportMode({ wrapper }: { wrapper: ReturnType<typeof mountModal> }) {
  await wrapper.find('[data-testid="import-export-export-card"]').trigger('click');
  await nextTick();
}

async function exportNow({ wrapper }: { wrapper: ReturnType<typeof mountModal> }) {
  await wrapper.find('[data-testid="import-export-export-now-button"]').trigger('click');
  await vi.waitFor(() => {
    expect(mocks.exportData).toHaveBeenCalled();
  });
  await flushPromises();
}

describe('ImportExportModal.vue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.exportData.mockResolvedValue({
      filename: 'naidan-data-test.zip',
      stream: new Blob(['zip'], { type: 'application/zip' }),
    });

    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:naidan-export'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  it('exports all data by default without passing exclude options', async () => {
    const wrapper = mountModal();
    await openExportMode({ wrapper });

    await exportNow({ wrapper });

    expect(mocks.exportData).toHaveBeenCalledOnce();
    const options = mocks.exportData.mock.calls[0]?.[0];
    expect(options).toEqual({ fileNameSegment: '' });
    expect(Object.prototype.hasOwnProperty.call(options, 'exclude')).toBe(false);
  });

  it('passes chat exclusion when Exclude Chats is checked', async () => {
    const wrapper = mountModal();
    await openExportMode({ wrapper });

    await wrapper.find('[data-testid="export-exclude-chats-checkbox"]').setValue(true);
    await exportNow({ wrapper });

    expect(mocks.exportData).toHaveBeenCalledWith({
      fileNameSegment: '',
      exclude: ['chat'],
    });
  });

  it('passes chat history exclusion', async () => {
    const wrapper = mountModal();
    await openExportMode({ wrapper });

    await wrapper.find('[data-testid="export-exclude-chat-history-checkbox"]').setValue(true);
    await exportNow({ wrapper });

    expect(mocks.exportData).toHaveBeenCalledWith({
      fileNameSegment: '',
      exclude: ['chat_history'],
    });
  });

  it('disables and clears chat history when Exclude Chats is checked', async () => {
    const wrapper = mountModal();
    await openExportMode({ wrapper });
    const history = wrapper.find('[data-testid="export-exclude-chat-history-checkbox"]');

    await history.setValue(true);
    await wrapper.find('[data-testid="export-exclude-chats-checkbox"]').setValue(true);
    await nextTick();

    const updatedHistory = wrapper.find('[data-testid="export-exclude-chat-history-checkbox"]');
    expect((updatedHistory.element as HTMLInputElement).checked).toBe(false);
    expect(updatedHistory.attributes('disabled')).toBeDefined();
  });

  it('passes binary object exclusion when Exclude Attachments is checked', async () => {
    const wrapper = mountModal();
    await openExportMode({ wrapper });

    await wrapper.find('[data-testid="export-exclude-attachments-checkbox"]').setValue(true);
    await exportNow({ wrapper });

    expect(mocks.exportData).toHaveBeenCalledWith({
      fileNameSegment: '',
      exclude: ['binary_object'],
    });
  });

  it('passes both exclusion options when both export checkboxes are checked', async () => {
    const wrapper = mountModal();
    await openExportMode({ wrapper });

    await wrapper.find('[data-testid="export-exclude-chats-checkbox"]').setValue(true);
    await wrapper.find('[data-testid="export-exclude-attachments-checkbox"]').setValue(true);
    await exportNow({ wrapper });

    expect(mocks.exportData).toHaveBeenCalledWith({
      fileNameSegment: '',
      exclude: ['chat', 'binary_object'],
    });
  });

  it('resets export exclusion checkboxes when the modal is reopened', async () => {
    const wrapper = mountModal();
    await openExportMode({ wrapper });

    await wrapper.find('[data-testid="export-exclude-chats-checkbox"]').setValue(true);
    await wrapper.find('[data-testid="export-exclude-attachments-checkbox"]').setValue(true);

    await wrapper.setProps({ isOpen: false });
    await wrapper.setProps({ isOpen: true });
    await openExportMode({ wrapper });

    expect((wrapper.find('[data-testid="export-exclude-chats-checkbox"]').element as HTMLInputElement).checked).toBe(false);
    expect((wrapper.find('[data-testid="export-exclude-chat-history-checkbox"]').element as HTMLInputElement).checked).toBe(false);
    expect((wrapper.find('[data-testid="export-exclude-attachments-checkbox"]').element as HTMLInputElement).checked).toBe(false);
  });
});
