import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import ImportExportModal from './ImportExportModal.vue';

const mocks = vi.hoisted(() => ({
  addToast: vi.fn(),
  exportData: vi.fn(),
  compressingData: vi.fn(async () => 'Compressing data...'),
  exportSuccessful: vi.fn(async () => 'Export successful'),
}));

vi.mock('@/strings', async importOriginal => {
  const actual = await importOriginal<typeof import('@/strings')>();
  return {
    ...actual,
    ensureStrings: new Proxy(actual.ensureStrings, {
      get(target, property, receiver) {
        if (property === 'ImportExportModal__compressing_data') return mocks.compressingData;
        if (property === 'ImportExportModal__export_successful') return mocks.exportSuccessful;
        return Reflect.get(target, property, receiver);
      },
    }),
  };
});

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
  expect(URL.createObjectURL).toHaveBeenCalledOnce();
  expect(mocks.addToast).toHaveBeenCalledOnce();
  expect(wrapper.emitted('close')).toHaveLength(1);
}

describe('ImportExportModal.vue', () => {
  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('isSecureContext', false);
    mocks.compressingData.mockReset().mockResolvedValue('Compressing data...');
    mocks.exportSuccessful.mockReset().mockResolvedValue('Export successful');
    mocks.exportData.mockImplementation(async () => ({
      filename: 'naidan-data-test.zip',
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('zip')); controller.close();
        },
      }),
    }));

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

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not start export after cancellation during asynchronous preparation', async () => {
    const preparation = Promise.withResolvers<string>();
    mocks.compressingData.mockReturnValueOnce(preparation.promise);
    const wrapper = mountModal();
    await openExportMode({ wrapper });
    await wrapper.find('[data-testid="import-export-export-now-button"]').trigger('click');
    await vi.waitFor(() => expect(mocks.compressingData).toHaveBeenCalledOnce());
    await wrapper.setProps({ isOpen: false });
    await wrapper.setProps({ isOpen: true });
    preparation.resolve('Compressing data...');
    await flushPromises();
    expect(mocks.exportData).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(mocks.addToast).not.toHaveBeenCalled();
    expect(wrapper.emitted('close')).toBeUndefined();
    wrapper.unmount();
  });

  it('does not close a reopened dialog after an old success message resolves', async () => {
    const success = Promise.withResolvers<string>();
    mocks.exportSuccessful.mockReturnValueOnce(success.promise);
    const wrapper = mountModal();
    await openExportMode({ wrapper });
    await wrapper.find('[data-testid="import-export-export-now-button"]').trigger('click');
    await vi.waitFor(() => expect(mocks.exportSuccessful).toHaveBeenCalledOnce());
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    await wrapper.setProps({ isOpen: false });
    await wrapper.setProps({ isOpen: true });
    success.resolve('Export successful');
    await flushPromises();
    expect(mocks.addToast).not.toHaveBeenCalled();
    expect(wrapper.emitted('close')).toBeUndefined();
    expect(wrapper.find('[data-testid="import-export-export-card"]').exists()).toBe(true);
    wrapper.unmount();
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
