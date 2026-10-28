import { DOMWrapper, mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import ImportExportModal from './ImportExportModal.vue';
import type { ImportPreview } from '@/features/import-export/types';

const mocks = vi.hoisted(() => ({
  addToast: vi.fn(),
  exportData: vi.fn(),
  analyze: vi.fn(),
  verify: vi.fn(),
  executeImport: vi.fn(),
  compressingData: vi.fn<() => Promise<string>>(),
  exportSuccessful: vi.fn<() => Promise<string>>(),
  openFileExplorer: vi.fn(),
}));

vi.mock('@/strings', async importOriginal => {
  const actual = await importOriginal<typeof import('@/strings')>();
  return {
    ...actual,
    ensureStrings: new Proxy(actual.ensureStrings, {
      get(target, property, receiver) {
        if (property === 'ImportExportModal__compressing_data') {
          return mocks.compressingData;
        }
        if (property === 'ImportExportModal__export_successful') {
          return mocks.exportSuccessful;
        }
        return Reflect.get(target, property, receiver);
      },
    }),
  };
});

vi.mock('@/features/import-export/service', () => ({
  ImportExportService: class {
    analyze = mocks.analyze;
    executeImport = mocks.executeImport;
    exportData = mocks.exportData;
    verify = mocks.verify;
  },
}));

vi.mock('@/00-storage/service', () => ({
  storageService: {},
}));

vi.mock('@/features/file-explorer/composables/useFileExplorerModal', () => ({
  useFileExplorerModal: vi.fn(() => ({
    openFileExplorer: mocks.openFileExplorer,
  })),
}));


vi.mock('@/composables/useToast', () => ({
  useToast: vi.fn(() => ({
    addToast: mocks.addToast,
  })),
}));

function mountModal({ initialMode }: { initialMode: 'menu' | 'export' }) {
  return mount(ImportExportModal, {
    props: { isOpen: true, initialMode },
    global: {
      stubs: {
        Teleport: true,
      },
    },
  });
}

function mountModalResource({ initialMode, teleport }: { initialMode: 'menu' | 'export', teleport: 'stubbed' | 'real' }) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const wrapper = mount(ImportExportModal, {
    attachTo: host,
    props: { isOpen: true, initialMode },
    global: {
      stubs: {
        Teleport: teleport === 'stubbed',
      },
    },
  });
  return {
    wrapper,
    surface: new DOMWrapper(document.body),
    [Symbol.dispose]() {
      wrapper.unmount();
      host.remove();
    },
  };
}

function installClipboard({ writeText }: { writeText: Clipboard['writeText'] }) {
  const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  return {
    [Symbol.dispose]() {
      if (previous === undefined) {
        Reflect.deleteProperty(navigator, 'clipboard');
      } else {
        Object.defineProperty(navigator, 'clipboard', previous);
      }
    },
  };
}

function emptyPreview(): ImportPreview {
  return { appVersion: 'test', exportedAt: 0, stats: { chatsCount: 0, chatGroupsCount: 0, attachmentsCount: 0, hasSettings: false, providerProfilesCount: 0 }, items: [] };
}

function readBlobBytes({ blob }: { blob: Blob }): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(new Uint8Array(reader.result));
      } else {
        reject(new Error('Expected Blob bytes'));
      }
    };
    reader.readAsArrayBuffer(blob);
  });
}

async function pasteAndRead({ wrapper, serialized }: { wrapper: ReturnType<typeof mountModal>, serialized: string }): Promise<void> {
  await wrapper.get('[data-testid="import-export-paste-base64"]').trigger('click');
  await wrapper.get('[data-testid="import-export-base64-input"]').setValue(serialized);
  await wrapper.get('[data-testid="import-export-base64-read"]').trigger('click');
  await flushPromises();
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

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('@/strings')>('@/strings');
    vi.clearAllMocks();
    vi.stubGlobal('isSecureContext', false);
    mocks.compressingData.mockReset().mockImplementation(actual.ensureStrings.ImportExportModal__compressing_data);
    mocks.exportSuccessful.mockReset().mockImplementation(actual.ensureStrings.ImportExportModal__export_successful);
    mocks.analyze.mockReset().mockResolvedValue(emptyPreview());
    mocks.verify.mockReset().mockResolvedValue(undefined);
    mocks.executeImport.mockReset().mockResolvedValue(undefined);
    mocks.exportData.mockReset().mockImplementation(async () => ({
      filename: 'naidan-data-test.zip',
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('zip'));
          controller.close();
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

  it('opens directly at export without exporting and preserves the menu back action', async () => {
    const wrapper = mountModal({ initialMode: 'export' });
    await nextTick();
    expect(wrapper.find('[data-testid="import-export-export-card"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="import-export-export-now-button"]').exists()).toBe(true);
    expect(mocks.exportData).not.toHaveBeenCalled();
    const back = wrapper.findAll('button').find(button => button.text().includes('Back to Menu'));
    expect(back).toBeDefined();
    await back?.trigger('click');
    expect(wrapper.find('[data-testid="import-export-export-card"]').exists()).toBe(true);
    await wrapper.setProps({ isOpen: false });
    await wrapper.setProps({ isOpen: true });
    expect(wrapper.find('[data-testid="import-export-export-card"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="import-export-export-now-button"]').exists()).toBe(true);
    expect(mocks.exportData).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('does not start export after cancellation during asynchronous preparation', async () => {
    const preparation = Promise.withResolvers<string>();
    mocks.compressingData.mockReturnValueOnce(preparation.promise);
    const wrapper = mountModal({ initialMode: 'menu' });
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
    const wrapper = mountModal({ initialMode: 'menu' });
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
    const wrapper = mountModal({ initialMode: 'menu' });
    await openExportMode({ wrapper });

    await exportNow({ wrapper });

    expect(mocks.exportData).toHaveBeenCalledOnce();
    const options = mocks.exportData.mock.calls[0]?.[0];
    expect(options).toEqual({ fileNameSegment: '' });
    expect(Object.prototype.hasOwnProperty.call(options, 'exclude')).toBe(false);
  });

  it('passes chat exclusion when Exclude Chats is checked', async () => {
    const wrapper = mountModal({ initialMode: 'menu' });
    await openExportMode({ wrapper });

    await wrapper.find('[data-testid="export-exclude-chats-checkbox"]').setValue(true);
    await exportNow({ wrapper });

    expect(mocks.exportData).toHaveBeenCalledWith({
      fileNameSegment: '',
      exclude: ['chat'],
    });
  });

  it('passes chat history exclusion', async () => {
    const wrapper = mountModal({ initialMode: 'menu' });
    await openExportMode({ wrapper });

    await wrapper.find('[data-testid="export-exclude-chat-history-checkbox"]').setValue(true);
    await exportNow({ wrapper });

    expect(mocks.exportData).toHaveBeenCalledWith({
      fileNameSegment: '',
      exclude: ['chat_history'],
    });
  });

  it('disables and clears chat history when Exclude Chats is checked', async () => {
    const wrapper = mountModal({ initialMode: 'menu' });
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
    const wrapper = mountModal({ initialMode: 'menu' });
    await openExportMode({ wrapper });

    await wrapper.find('[data-testid="export-exclude-attachments-checkbox"]').setValue(true);
    await exportNow({ wrapper });

    expect(mocks.exportData).toHaveBeenCalledWith({
      fileNameSegment: '',
      exclude: ['binary_object'],
    });
  });

  it('passes both exclusion options when both export checkboxes are checked', async () => {
    const wrapper = mountModal({ initialMode: 'menu' });
    await openExportMode({ wrapper });

    await wrapper.find('[data-testid="export-exclude-chats-checkbox"]').setValue(true);
    await wrapper.find('[data-testid="export-exclude-attachments-checkbox"]').setValue(true);
    await exportNow({ wrapper });

    expect(mocks.exportData).toHaveBeenCalledWith({
      fileNameSegment: '',
      exclude: ['chat', 'binary_object'],
    });
  });

  it('uses Download ZIP as the default split-button action', async () => {
    using view = mountModalResource({ initialMode: 'menu', teleport: 'stubbed' });
    const { wrapper } = view;
    await openExportMode({ wrapper });

    expect(wrapper.find('[data-testid="import-export-export-now-button"]').text()).toContain('Download ZIP');
    const actionMenuButton = wrapper.find('[data-testid="import-export-export-action-menu-button"]');
    expect(actionMenuButton.attributes('aria-label')).toBe('Export options');
    expect(actionMenuButton.attributes('aria-haspopup')).toBe('menu');
    await exportNow({ wrapper });

    expect(mocks.openFileExplorer).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
    });
  });

  it('closes the export action menu when clicking outside the split button', async () => {
    using view = mountModalResource({ initialMode: 'menu', teleport: 'stubbed' });
    const { wrapper } = view;
    await openExportMode({ wrapper });

    await wrapper.find('[data-testid="import-export-export-action-menu-button"]').trigger('click');
    expect(wrapper.find('[data-testid="import-export-export-action-menu"]').exists()).toBe(true);

    document.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await nextTick();

    expect(wrapper.find('[data-testid="import-export-export-action-menu"]').exists()).toBe(false);
  });

  it('can switch the export split button to open the generated ZIP in File Explorer', async () => {
    using view = mountModalResource({ initialMode: 'menu', teleport: 'stubbed' });
    const { wrapper } = view;
    await openExportMode({ wrapper });

    await wrapper.find('[data-testid="import-export-export-action-menu-button"]').trigger('click');
    expect(wrapper.find('[data-testid="import-export-export-action-download"]').attributes('aria-checked')).toBe('true');
    expect(wrapper.find('[data-testid="import-export-export-action-file-explorer"]').attributes('aria-checked')).toBe('false');
    await wrapper.find('[data-testid="import-export-export-action-file-explorer"]').trigger('click');
    await nextTick();
    expect(wrapper.find('[data-testid="import-export-export-now-button"]').text()).toContain('View in File Explorer');

    await wrapper.get('[data-testid="import-export-export-now-button"]').trigger('click');
    await flushPromises();

    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(mocks.openFileExplorer).toHaveBeenCalledOnce();
    });
    const call = mocks.openFileExplorer.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      options: {
        kind: 'archive-root',
        title: 'naidan-data-test.zip',
        rootName: 'naidan-data-test.zip',
        archive: {
          format: 'zip',
          source: { kind: 'blob' },
        },
      },
    });
    if (call?.options.kind !== 'archive-root' || call.options.archive.source.kind !== 'blob') {
      throw new Error('Expected Blob-backed archive root options');
    }
    expect(call.options.archive.source.blob).toMatchObject({ size: 3 });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(mocks.addToast).not.toHaveBeenCalled();
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('moves between export actions with the keyboard and restores focus on selection and Escape', async () => {
    using view = mountModalResource({ initialMode: 'export', teleport: 'real' });
    const { surface } = view;
    await flushPromises();
    const trigger = () => surface.get('[data-testid="import-export-export-action-menu-button"]');
    await trigger().trigger('keydown', { key: 'ArrowDown' });
    await nextTick();
    const download = surface.get('[data-testid="import-export-export-action-download"]');
    const explorer = surface.get('[data-testid="import-export-export-action-file-explorer"]');
    const menu = surface.get('[data-testid="import-export-export-action-menu"]');
    expect(trigger().attributes('aria-controls')).toBe(menu.attributes('id'));
    expect(document.activeElement).toBe(download.element);
    await download.trigger('keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(explorer.element);
    await explorer.trigger('click');
    expect(document.activeElement).toBe(trigger().element);
    expect(surface.get('[data-testid="import-export-export-now-button"]').text()).toContain('View in File Explorer');
    expect(mocks.exportData).not.toHaveBeenCalled();
    await trigger().trigger('keydown', { key: 'ArrowUp' });
    expect(document.activeElement).toBe(surface.get('[data-testid="import-export-export-action-file-explorer"]').element);
    await surface.get('[data-testid="import-export-export-action-menu"]').trigger('keydown', { key: 'Escape' });
    expect(surface.find('[data-testid="import-export-export-action-menu"]').exists()).toBe(false);
    expect(document.activeElement).toBe(trigger().element);
  });

  it('closes an export action menu when its view is left and resets the action on reopening', async () => {
    using view = mountModalResource({ initialMode: 'export', teleport: 'real' });
    const { wrapper, surface } = view;
    await surface.get('[data-testid="import-export-export-action-menu-button"]').trigger('click');
    await surface.get('[data-testid="import-export-export-action-file-explorer"]').trigger('click');
    await surface.get('[data-testid="import-export-export-action-menu-button"]').trigger('click');
    await surface.get('[data-testid="import-export-export-back"]').trigger('click');
    expect(surface.find('[data-testid="import-export-export-action-menu"]').exists()).toBe(false);
    await wrapper.setProps({ isOpen: false });
    await wrapper.setProps({ isOpen: true });
    expect(surface.get('[data-testid="import-export-export-now-button"]').text()).toContain('Download ZIP');
  });

  it('cancels a late archive source instead of opening File Explorer after the modal reopens', async () => {
    using view = mountModalResource({ initialMode: 'export', teleport: 'real' });
    const { wrapper, surface } = view;
    const output = Promise.withResolvers<{ stream: ReadableStream<Uint8Array>, filename: string }>();
    mocks.exportData.mockReturnValueOnce(output.promise);
    await surface.get('[data-testid="import-export-export-action-menu-button"]').trigger('click');
    await surface.get('[data-testid="import-export-export-action-file-explorer"]').trigger('click');
    await surface.get('[data-testid="import-export-export-now-button"]').trigger('click');
    await vi.waitFor(() => expect(mocks.exportData).toHaveBeenCalledOnce());
    await wrapper.setProps({ isOpen: false });
    await wrapper.setProps({ isOpen: true });
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream<Uint8Array>({ cancel });
    output.resolve({ filename: 'late.zip', stream });
    await flushPromises();
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
    expect(mocks.openFileExplorer).not.toHaveBeenCalled();
    expect(wrapper.emitted('close')).toBeUndefined();
  });

  it('cancels archive buffering when the modal closes without waiting for producer cleanup', async () => {
    using view = mountModalResource({ initialMode: 'export', teleport: 'real' });
    const { wrapper, surface } = view;
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'));
      },
      cancel,
    });
    mocks.exportData.mockResolvedValueOnce({ filename: 'partial.zip', stream });
    await surface.get('[data-testid="import-export-export-action-menu-button"]').trigger('click');
    await surface.get('[data-testid="import-export-export-action-file-explorer"]').trigger('click');
    await surface.get('[data-testid="import-export-export-now-button"]').trigger('click');
    await vi.waitFor(() => expect(stream.locked).toBe(true));
    await wrapper.setProps({ isOpen: false });
    await flushPromises();
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
    expect(mocks.openFileExplorer).not.toHaveBeenCalled();
    expect(wrapper.emitted('close')).toBeUndefined();
  });

  it('resets export exclusion checkboxes when the modal is reopened', async () => {
    const wrapper = mountModal({ initialMode: 'menu' });
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

  it('prepares raw ZIP Base64 and copies the same bytes only on a separate click', async () => {
    const writeText = vi.fn<Clipboard['writeText']>().mockResolvedValue(undefined);
    using clipboard = installClipboard({ writeText });
    using view = mountModalResource({ initialMode: 'export', teleport: 'stubbed' });
    const { wrapper } = view;
    const bytes = Uint8Array.of(0xfb, 0xff);
    mocks.exportData.mockResolvedValueOnce({
      filename: 'test.zip',
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    });
    await wrapper.get('[data-testid="export-exclude-chats-checkbox"]').setValue(true);
    await wrapper.get('[data-testid="export-exclude-attachments-checkbox"]').setValue(true);
    expect(mocks.exportData).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="import-export-base64-generate"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.find('[data-testid="import-export-base64-copy"]').exists()).toBe(true));
    expect(writeText).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="import-export-base64-copy"]').trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledExactlyOnceWith('+/8=');
    expect(mocks.exportData).toHaveBeenCalledExactlyOnceWith({ fileNameSegment: '', exclude: ['chat', 'binary_object'] });
    expect(wrapper.get('[data-testid="import-export-base64-copy-success"]').text()).toBe('Base64 copied.');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(mocks.addToast).not.toHaveBeenCalled();
    expect(wrapper.emitted('close')).toBeUndefined();
    void clipboard;
  });

  it('keeps clipboard failures local and discards a pending copy after exclusion changes', async () => {
    const pending = Promise.withResolvers<void>();
    const writeText = vi.fn<Clipboard['writeText']>().mockRejectedValueOnce(new Error('private clipboard diagnostic')).mockReturnValueOnce(pending.promise);
    using clipboard = installClipboard({ writeText });
    using view = mountModalResource({ initialMode: 'export', teleport: 'stubbed' });
    const { wrapper } = view;
    await wrapper.get('[data-testid="import-export-base64-generate"]').trigger('click');
    await vi.waitFor(() => expect(wrapper.find('[data-testid="import-export-base64-copy"]').exists()).toBe(true));
    await wrapper.get('[data-testid="import-export-base64-copy"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="import-export-base64-copy-error"]').text()).toBe('Could not copy Base64.');
    expect(wrapper.text()).not.toContain('private clipboard diagnostic');
    await wrapper.get('[data-testid="import-export-base64-copy"]').trigger('click');
    await wrapper.get('[data-testid="export-exclude-attachments-checkbox"]').setValue(true);
    expect(wrapper.find('[data-testid="import-export-base64-copy"]').exists()).toBe(false);
    pending.resolve();
    await flushPromises();
    expect(wrapper.find('[data-testid="import-export-base64-copy-success"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="import-export-base64-generate"]').attributes('disabled')).toBeUndefined();
    expect(mocks.exportData).toHaveBeenCalledOnce();
    expect(mocks.addToast).not.toHaveBeenCalled();
    void clipboard;
  });

  it('cancels a service stream that arrives after close and does not leave a reopened export busy', async () => {
    const pending = Promise.withResolvers<{ filename: string, stream: ReadableStream<Uint8Array> }>();
    mocks.exportData.mockReturnValueOnce(pending.promise);
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    using view = mountModalResource({ initialMode: 'export', teleport: 'stubbed' });
    const { wrapper } = view;
    await wrapper.get('[data-testid="import-export-base64-generate"]').trigger('click');
    await wrapper.setProps({ isOpen: false });
    await wrapper.setProps({ isOpen: true });
    pending.resolve({ filename: 'late.zip', stream });
    await flushPromises();
    expect(cancel).toHaveBeenCalledOnce();
    expect(wrapper.find('[data-testid="import-export-base64-copy"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="import-export-base64-generate"]').attributes('disabled')).toBeUndefined();
  });

  it('aborts encoding an active stream on close and clears the prepared data before reopening', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    mocks.exportData.mockResolvedValueOnce({ filename: 'active.zip', stream });
    using view = mountModalResource({ initialMode: 'export', teleport: 'stubbed' });
    const { wrapper } = view;
    await wrapper.get('[data-testid="import-export-base64-generate"]').trigger('click');
    await vi.waitFor(() => expect(stream.locked).toBe(true));
    await wrapper.setProps({ isOpen: false });
    await flushPromises();
    expect(cancel).toHaveBeenCalledOnce();
    await wrapper.setProps({ isOpen: true });
    expect(wrapper.find('[data-testid="import-export-base64-copy"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="import-export-base64-generate"]').attributes('disabled')).toBeUndefined();
  });

  it('routes pasted Base64 through preview and configuration before verify and execute', async () => {
    const order: string[] = [];
    mocks.analyze.mockImplementation(async () => {
      order.push('analyze');
      return emptyPreview();
    });
    mocks.verify.mockImplementation(async () => {
      order.push('verify');
    });
    mocks.executeImport.mockImplementation(async () => {
      order.push('execute');
    });
    using view = mountModalResource({ initialMode: 'menu', teleport: 'stubbed' });
    const { wrapper } = view;
    await pasteAndRead({ wrapper, serialized: '+/8=' });
    expect(wrapper.find('[data-testid="import-export-preview"]').exists()).toBe(true);
    expect(order).toEqual(['analyze']);
    const file: File = mocks.analyze.mock.calls[0]?.[0].zipFile;
    expect(await readBlobBytes({ blob: file })).toEqual(Uint8Array.of(0xfb, 0xff));
    await wrapper.get('[data-testid="import-export-preview-next"]').trigger('click');
    expect(wrapper.find('[data-testid="import-export-config"]').exists()).toBe(true);
    expect(mocks.verify).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="import-export-import-now"]').trigger('click');
    await vi.waitFor(() => expect(mocks.executeImport).toHaveBeenCalledOnce());
    expect(order).toEqual(['analyze', 'verify', 'execute']);
    expect(mocks.verify.mock.calls[0]?.[0].config.data.mode).toBe('append');
    expect(mocks.executeImport.mock.calls[0]?.[0].config).toEqual(mocks.verify.mock.calls[0]?.[0].config);
    expect(mocks.executeImport.mock.calls[0]?.[0].zipFile).toBe(file);
  });

  it('rejects invalid Base64 before analysis and keeps malformed ZIP analysis failures local', async () => {
    using view = mountModalResource({ initialMode: 'menu', teleport: 'stubbed' });
    const { wrapper } = view;
    await pasteAndRead({ wrapper, serialized: '%invalid-base64' });
    expect(wrapper.get('[data-testid="import-export-base64-paste-error"]').text()).toBe('Could not read the ZIP from Base64.');
    expect(mocks.analyze).not.toHaveBeenCalled();
    mocks.analyze.mockRejectedValueOnce(new Error('private ZIP diagnostic'));
    await wrapper.get('[data-testid="import-export-base64-input"]').setValue('emlw');
    await wrapper.get('[data-testid="import-export-base64-read"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="import-export-base64-input"]').element).toHaveProperty('value', 'emlw');
    expect(wrapper.text()).toContain('Could not read the ZIP from Base64.');
    expect(wrapper.text()).not.toContain('private ZIP diagnostic');
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.executeImport).not.toHaveBeenCalled();
  });

  it('does not execute an import after verification fails', async () => {
    mocks.verify.mockRejectedValueOnce(new Error('ZIP verification failed'));
    using view = mountModalResource({ initialMode: 'menu', teleport: 'stubbed' });
    const { wrapper } = view;
    await pasteAndRead({ wrapper, serialized: 'emlw' });
    await wrapper.get('[data-testid="import-export-preview-next"]').trigger('click');
    await wrapper.get('[data-testid="import-export-import-now"]').trigger('click');
    await flushPromises();
    expect(mocks.verify).toHaveBeenCalledOnce();
    expect(mocks.executeImport).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="import-export-config"]').exists()).toBe(true);
    expect(mocks.addToast).not.toHaveBeenCalled();
  });

  it('discards late analysis after close and clears pasted data in a reopened modal', async () => {
    const pending = Promise.withResolvers<ImportPreview>();
    mocks.analyze.mockReturnValueOnce(pending.promise);
    using view = mountModalResource({ initialMode: 'menu', teleport: 'stubbed' });
    const { wrapper } = view;
    await pasteAndRead({ wrapper, serialized: 'emlw' });
    expect(mocks.analyze).toHaveBeenCalledOnce();
    await wrapper.setProps({ isOpen: false });
    await wrapper.setProps({ isOpen: true });
    await wrapper.get('[data-testid="import-export-paste-base64"]').trigger('click');
    expect(wrapper.get('[data-testid="import-export-base64-input"]').element).toHaveProperty('value', '');
    await wrapper.get('[data-testid="import-export-base64-input"]').setValue('bmV3');
    pending.resolve(emptyPreview());
    await flushPromises();
    expect(wrapper.find('[data-testid="import-export-preview"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="import-export-base64-input"]').element).toHaveProperty('value', 'bmV3');
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.executeImport).not.toHaveBeenCalled();
  });

  it('does not begin execution when verification completes after close and reopen', async () => {
    const pending = Promise.withResolvers<void>();
    mocks.verify.mockReturnValueOnce(pending.promise);
    using view = mountModalResource({ initialMode: 'menu', teleport: 'stubbed' });
    const { wrapper } = view;
    await pasteAndRead({ wrapper, serialized: 'emlw' });
    await wrapper.get('[data-testid="import-export-preview-next"]').trigger('click');
    await wrapper.get('[data-testid="import-export-import-now"]').trigger('click');
    await flushPromises();
    expect(mocks.verify).toHaveBeenCalledOnce();
    await wrapper.setProps({ isOpen: false });
    await wrapper.setProps({ isOpen: true });
    pending.resolve();
    await flushPromises();
    expect(mocks.executeImport).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="import-export-paste-base64"]').exists()).toBe(true);
    expect(mocks.addToast).not.toHaveBeenCalled();
  });
});
