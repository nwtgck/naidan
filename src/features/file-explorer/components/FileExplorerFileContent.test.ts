import { Blob as NodeBlob } from 'node:buffer';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import type { usePrompt } from '@/composables/usePrompt';
import BlockMarkdownRenderer from '@/components/block-markdown/BlockMarkdownRenderer.vue';
import EditorV4 from '@/features/editor-v4/components/EditorV4.vue';
import { TEST_ONLY as editorPreferences } from '@/features/file-explorer/composables/useFileExplorerEditorPreferences';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { FileExplorerEntry } from '@/features/file-explorer/logic/types';
import { getFileExtension, getMimeCategory } from '@/features/file-explorer/logic/utils';
import type { FileExplorerFileAccess, FileExplorerFileForView } from '@/features/file-explorer/worker/types';
import FileExplorerBinaryPreview from './FileExplorerBinaryPreview.vue';
import FileExplorerDelimitedView from './FileExplorerDelimitedView.vue';
import FileExplorerFileContent from './FileExplorerFileContent.vue';
import FileExplorerImageView from './FileExplorerImageView.vue';
import FileExplorerModelView from './FileExplorerModelView.vue';

const { showPrompt } = vi.hoisted(() => ({
  showPrompt: vi.fn<ReturnType<typeof usePrompt>['showPrompt']>(),
}));

vi.mock('@/composables/usePrompt', () => ({
  usePrompt: () => ({ showPrompt }),
}));

const access = {
  read: vi.fn<FileExplorerFileAccess['read']>(),
  openSnapshot: vi.fn<FileExplorerFileAccess['openSnapshot']>(),
  save: vi.fn<FileExplorerFileAccess['save']>(),
  inspectModelOverview: vi.fn<FileExplorerFileAccess['inspectModelOverview']>(),
  inspectModel: vi.fn<FileExplorerFileAccess['inspectModel']>(),
  readModelMetadataValue: vi.fn<FileExplorerFileAccess['readModelMetadataValue']>(),
  prepareGgufMetadataRewrite: vi.fn<FileExplorerFileAccess['prepareGgufMetadataRewrite']>(),
} satisfies FileExplorerFileAccess;

class TestURL extends URL {
  static override readonly createObjectURL = vi.fn(() => 'blob:fixture');
  static override readonly revokeObjectURL = vi.fn();
}

beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('URL', TestURL);
  TestURL.createObjectURL.mockReturnValue('blob:fixture');
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  editorPreferences.temporaryWordWrap.value = false;
  vi.unstubAllGlobals();
});

function mountFile({ path, blob, revision, locked, canWriteToRoot, forceText, listedSize }: {
  path: string, blob: Blob, revision: string | undefined, locked: boolean, canWriteToRoot: boolean, forceText?: boolean, listedSize?: number,
}) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const extension = getFileExtension({ name });
  const entry: FileExplorerEntry = {
    kind: 'file',
    path,
    name,
    extension,
    mimeCategory: getMimeCategory({ extension }),
    size: listedSize ?? blob.size,
    lastModified: undefined,
    readOnly: false,
    canNavigate: false,
    canMutate: true,
  };
  const source: FileExplorerFileForView = { kind: 'file', name, blob, size: blob.size, partial: false, revision };
  access.read.mockResolvedValue(source);
  access.openSnapshot.mockResolvedValueOnce(source);
  const wrapper = mount(FileExplorerFileContent, {
    props: { entry, client: { fileAccess: access }, locked, canWriteToRoot, focused: false, forceText },
  });
  return {
    wrapper,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

async function openEditor({ wrapper }: { wrapper: VueWrapper<InstanceType<typeof FileExplorerFileContent>> }) {
  await vi.waitFor(() => expect(wrapper.find('[data-testid="file-view-edit-source"]').exists()).toBe(true));
  await wrapper.get('[data-testid="file-view-edit-source"]').trigger('click');
  await vi.waitFor(() => expect(wrapper.findComponent(EditorV4).exists()).toBe(true));
  return wrapper.getComponent(EditorV4).get<HTMLTextAreaElement>('[data-testid="editor-v4-input"]');
}

async function editText({ textarea, value }: { textarea: HTMLTextAreaElement, value: string }): Promise<void> {
  textarea.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText' }));
  textarea.value = value;
  textarea.setSelectionRange(value.length, value.length);
  textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  await nextTick();
}

function csvSource({ value }: { value: number }): string {
  return ['name,value', `sample,${value}`, ''].join('\n');
}

it('shares word wrapping between the file reader and editor without changing the file', async () => {
  const content = `\
One long line in a text file
`;
  using file = mountFile({ path: '/note.txt', blob: new Blob([content]), revision: 'first', locked: false, canWriteToRoot: true });
  const { wrapper } = file;
  await vi.waitFor(() => expect(wrapper.get('[data-testid="file-view-text"]').classes()).toContain('whitespace-pre'));
  await wrapper.get('[data-testid="file-view-wrap-toggle"]').trigger('click');
  expect(wrapper.get('[data-testid="file-view-text"]').classes()).toContain('whitespace-pre-wrap');

  const textarea = await openEditor({ wrapper });
  expect(textarea.attributes('wrap')).toBe('soft');
  expect(textarea.element.value).toBe(content);
  await wrapper.get('[data-testid="editor-v4-wrap-toggle"]').trigger('click');
  expect(editorPreferences.temporaryWordWrap.value).toBe(false);
  expect(textarea.attributes('wrap')).toBe('off');
  expect(wrapper.vm.hasChanges()).toBe(false);
  await wrapper.get('[data-testid="file-view-show-preview"]').trigger('click');
  expect(wrapper.get('[data-testid="file-view-text"]').element.textContent).toBe(content);
  expect(wrapper.get('[data-testid="file-view-text"]').classes()).toContain('whitespace-pre');
});

it('keeps the CSV encoding and marks only the submitted EditorV4 checkpoint as saved', async () => {
  const path = '/data.csv';
  using file = mountFile({ path, blob: new Blob(['\uFEFFname,value\r\nsample,1\r\n']), revision: 'first', locked: false, canWriteToRoot: true });
  const { wrapper } = file;
  const write = Promise.withResolvers<{ path: string, revision: string }>();
  access.save.mockReturnValueOnce(write.promise);
  const textarea = await openEditor({ wrapper });
  await editText({ textarea: textarea.element, value: csvSource({ value: 2 }) });
  const saving = wrapper.vm.saveChanges();
  expect(access.save).toHaveBeenCalledOnce();
  await nextTick();
  expect(wrapper.find('progress').exists()).toBe(false);
  await editText({ textarea: textarea.element, value: csvSource({ value: 3 }) });
  write.resolve({ path, revision: 'second' });
  expect(await saving).toBe(true);
  expect(wrapper.vm.hasChanges()).toBe(true);
  expect(wrapper.get('[data-testid="editor-v4-input"]').element).toBe(textarea.element);
  expect(textarea.element.value).toBe(csvSource({ value: 3 }));
  const firstSave = access.save.mock.calls[0]?.[0];
  expect(firstSave?.target).toEqual({ kind: 'replace', path, revision: 'first' });
  expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(await firstSave?.blob.arrayBuffer())).toBe('\uFEFFname,value\r\nsample,2\r\n');

  await textarea.trigger('keydown', { key: 'z', ctrlKey: true });
  expect(textarea.element.value).toBe(csvSource({ value: 2 }));
  expect(wrapper.vm.hasChanges()).toBe(false);
  await wrapper.get('[data-testid="file-view-show-preview"]').trigger('click');
  await vi.waitFor(() => expect(wrapper.findComponent(FileExplorerDelimitedView).exists()).toBe(true));
  expect(wrapper.getComponent(FileExplorerDelimitedView).text()).toContain('sample');
});

it('opens the saved CSV table edits in the source editor', async () => {
  const path = '/data.csv';
  using file = mountFile({ path, blob: new Blob(['\uFEFFname,value\r\nsample,1\r\n']), revision: 'first', locked: false, canWriteToRoot: true });
  const { wrapper } = file;
  const textarea = await openEditor({ wrapper });
  expect(textarea.element.value).toBe(csvSource({ value: 1 }));
  await wrapper.get('[data-testid="file-view-show-preview"]').trigger('click');
  const cells = '[data-testid="delimited-cell-button"]';
  await vi.waitFor(() => expect(wrapper.findAll(cells)).toHaveLength(4));
  await wrapper.get(`[data-testid="delimited-row"]:last-child td:last-child ${cells}`).trigger('click');
  await wrapper.get('[data-testid="delimited-cell-input"]').setValue('2');
  access.save.mockResolvedValueOnce({ path, revision: 'second' });
  expect(await wrapper.vm.saveChanges()).toBe(true);
  const write = access.save.mock.calls[0]?.[0];
  expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(await write?.blob.arrayBuffer())).toBe('\uFEFFname,value\r\nsample,2\r\n');
  const updated = await openEditor({ wrapper });
  expect(updated.element.value).toBe(csvSource({ value: 2 }));
  expect(wrapper.vm.hasChanges()).toBe(false);
});

it('shows the current Markdown draft after saving a text file with a Markdown extension', async () => {
  using file = mountFile({ path: '/note.txt', blob: new Blob(['# Original']), revision: 'old', locked: false, canWriteToRoot: true });
  const { wrapper } = file;
  const textarea = await openEditor({ wrapper });
  await editText({ textarea: textarea.element, value: '# Saved heading' });
  const write = Promise.withResolvers<{ path: string, revision: string }>();
  showPrompt.mockResolvedValueOnce('/note.md');
  access.save.mockReturnValueOnce(write.promise);
  await wrapper.get('[data-testid="file-view-save-as"]').trigger('click');
  await vi.waitFor(() => expect(access.save).toHaveBeenCalledOnce());
  await editText({ textarea: textarea.element, value: '# Continued editing' });
  write.resolve({ path: '/note.md', revision: 'new' });
  await flushPromises();
  await vi.dynamicImportSettled();
  expect(wrapper.getComponent(BlockMarkdownRenderer).props('content')).toBe('# Continued editing');
  expect(wrapper.vm.hasChanges()).toBe(true);
  expect(await access.save.mock.calls[0]?.[0]?.blob.text()).toBe('# Saved heading');
});

it('gates editing with the modal lock and saves a protected source only to an explicit new path', async () => {
  using file = mountFile({
    path: '/naidan-storage/settings.json',
    blob: new Blob(['{}']),
    revision: undefined,
    locked: true,
    canWriteToRoot: true,
  });
  const { wrapper } = file;
  const textarea = await openEditor({ wrapper });
  expect(textarea.element.readOnly).toBe(true);
  expect(await wrapper.vm.saveChanges()).toBe(true);
  expect(access.save).not.toHaveBeenCalled();

  await wrapper.setProps({ locked: false });
  expect(wrapper.find('[data-testid="file-view-read-only"]').exists()).toBe(true);
  expect(wrapper.get<HTMLButtonElement>('[data-testid="file-view-save"]').element.disabled).toBe(true);
  await editText({ textarea: textarea.element, value: '{ "sample": true }' });
  showPrompt.mockResolvedValueOnce('notes/settings.json');
  expect(await wrapper.vm.saveChanges()).toBe(false);
  expect(access.save).not.toHaveBeenCalled();
  expect(wrapper.vm.hasChanges()).toBe(true);

  showPrompt.mockResolvedValueOnce('/notes/settings.json');
  access.save.mockResolvedValueOnce({ path: '/notes/settings.json', revision: 'copy' });
  expect(await wrapper.vm.saveChanges()).toBe(true);
  expect(access.save).toHaveBeenCalledWith(expect.objectContaining({
    target: { kind: 'create', directoryPath: '/notes', name: 'settings.json' },
  }));
});

it('offers source viewing only when the entire root is read-only', async () => {
  using file = mountFile({
    path: '/document.txt',
    blob: new Blob(['text']),
    revision: undefined,
    locked: false,
    canWriteToRoot: false,
  });
  const textarea = await openEditor({ wrapper: file.wrapper });
  expect(textarea.element.readOnly).toBe(true);
  expect(file.wrapper.find('[data-testid="file-view-save-as"]').exists()).toBe(false);
});

it('can edit binary data as text and saves a UTF-8 copy when the original bytes cannot be preserved', async () => {
  using file = mountFile({
    path: '/sample.bin',
    blob: new Blob([new Uint8Array([0xff, 0x41])]),
    revision: 'first',
    locked: false,
    canWriteToRoot: true,
    forceText: true,
  });
  const { wrapper } = file;
  const input = '[data-testid="editor-v4-input"]';
  await vi.waitFor(() => expect(wrapper.find(input).exists()).toBe(true));
  const textarea = wrapper.get<HTMLTextAreaElement>(input);
  expect(textarea.element.value).toBe('�A');
  expect(textarea.element.readOnly).toBe(false);
  expect(wrapper.get<HTMLButtonElement>('[data-testid="file-view-save"]').element.disabled).toBe(true);
  await editText({ textarea: textarea.element, value: 'decoded text' });
  const path = '/sample-copy.txt';
  showPrompt.mockResolvedValueOnce(path);
  access.save.mockResolvedValueOnce({ path, revision: 'copy' });
  expect(await wrapper.vm.saveChanges()).toBe(true);
  expect(access.save).toHaveBeenCalledOnce();
  const write = access.save.mock.calls[0]?.[0];
  expect(write?.target).toEqual({ kind: 'create', directoryPath: '/', name: 'sample-copy.txt' });
  expect(await write?.blob.text()).toBe('decoded text');
});

it.each([{ path: '/blank.png' }, { path: '/blank.gguf' }])('can edit and save actual empty files named $path as text', async ({ path }) => {
  using file = mountFile({
    path,
    blob: new Blob(),
    revision: 'empty',
    locked: true,
    canWriteToRoot: true,
    listedSize: 32,
  });
  const { wrapper } = file;
  await vi.waitFor(() => expect(wrapper.find('[data-testid="file-view-empty-file"]').exists()).toBe(true));
  const editButton = '[data-testid="file-view-edit-binary-as-text"]';
  expect(wrapper.find(editButton).exists()).toBe(false);
  expect(access.inspectModel).not.toHaveBeenCalled();
  expect(TestURL.createObjectURL).not.toHaveBeenCalled();
  await wrapper.setProps({ locked: false });
  await wrapper.get(editButton).trigger('click');
  await vi.waitFor(() => expect(wrapper.findComponent(EditorV4).exists()).toBe(true));
  const textarea = wrapper.getComponent(EditorV4).get<HTMLTextAreaElement>('[data-testid="editor-v4-input"]');
  expect(textarea.element.value).toBe('');
  expect(textarea.element.readOnly).toBe(false);

  await editText({ textarea: textarea.element, value: 'draft' });
  access.save.mockResolvedValueOnce({ path, revision: 'new' });
  expect(await wrapper.vm.saveChanges()).toBe(true);
  const write = access.save.mock.calls[0]?.[0];
  expect(write?.target).toEqual({ kind: 'replace', path, revision: 'empty' });
  expect(await write?.blob.text()).toBe('draft');
});

it('keeps the HEX preview when reading binary data for editing fails', async () => {
  const path = '/sample.bin';
  using file = mountFile({
    path,
    blob: new Blob([new Uint8Array([0xff, 0x41])]),
    revision: 'first',
    locked: false,
    canWriteToRoot: true,
  });
  const { wrapper } = file;
  await vi.waitFor(() => expect(wrapper.findComponent(FileExplorerBinaryPreview).exists()).toBe(true));
  const hex = wrapper.get('[data-testid="binary-hex-dump"]');
  expect(hex.text()).toContain('ff 41');
  const read = Promise.withResolvers<FileExplorerFileForView>();
  access.read.mockReturnValueOnce(read.promise);
  const editButton = wrapper.get<HTMLButtonElement>('[data-testid="file-view-edit-binary-as-text"]');
  await editButton.trigger('click');
  expect(editButton.element.disabled).toBe(true);
  expect(wrapper.get('[data-testid="binary-hex-dump"]').element).toBe(hex.element);

  read.reject(new Error('The file could not be read'));
  await vi.waitFor(() => expect(wrapper.get('[role="alert"]').text()).toBe('The file could not be read'));
  expect(wrapper.get('[data-testid="binary-hex-dump"]').element).toBe(hex.element);
  expect(wrapper.findComponent(EditorV4).exists()).toBe(false);
  expect(editButton.element.disabled).toBe(false);
  await editButton.trigger('click');
  await vi.waitFor(() => expect(wrapper.findComponent(EditorV4).exists()).toBe(true));
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
});

it('can cancel a write before the Worker reports any progress', async () => {
  using file = mountFile({ path: '/document.txt', blob: new Blob(['text']), revision: 'old', locked: false, canWriteToRoot: true });
  const { wrapper } = file;
  access.save.mockImplementationOnce(({ signal }) => new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const textarea = await openEditor({ wrapper });
  await editText({ textarea: textarea.element, value: 'draft' });
  const saving = wrapper.vm.saveChanges();
  await vi.waitFor(() => expect(wrapper.find('[data-testid="file-view-cancel-write"]').exists()).toBe(true));
  expect(wrapper.get('progress').element.hasAttribute('value')).toBe(false);
  await wrapper.get('[data-testid="file-view-cancel-write"]').trigger('click');
  expect(await saving).toBe(false);
  expect(wrapper.vm.hasChanges()).toBe(true);
});

it('keeps image edits for retry and requires the destination extension to match the export', async () => {
  using file = mountFile({
    path: '/photo.jpg',
    blob: new Blob(['original']),
    revision: 'original',
    locked: false,
    canWriteToRoot: true,
    forceText: true,
    listedSize: 0,
  });
  const { wrapper } = file;
  await vi.waitFor(() => expect(wrapper.findComponent(FileExplorerImageView).exists()).toBe(true));
  const image = wrapper.getComponent(FileExplorerImageView);
  expect(image.props('mimeType')).toBe('image/jpeg');
  expect(wrapper.find('[data-testid="file-view-empty-file"]').exists()).toBe(false);
  expect(wrapper.find('[data-testid="file-view-edit-binary-as-text"]').exists()).toBe(false);
  expect(access.read).toHaveBeenCalledOnce();
  expect(wrapper.findComponent(EditorV4).exists()).toBe(false);
  const edited = new Blob(['edited'], { type: 'image/webp' });
  showPrompt.mockResolvedValueOnce('/copy.jpg');
  image.vm.$emit('save', { blob: edited });
  await vi.waitFor(() => expect(wrapper.get('[role="alert"]').text()).toContain('.webp'));
  expect(access.save).not.toHaveBeenCalled();
  expect(wrapper.vm.hasChanges()).toBe(true);

  showPrompt.mockResolvedValueOnce('/copy.webp');
  access.save.mockResolvedValueOnce({ path: '/copy.webp', revision: 'copy' });
  expect(await wrapper.vm.saveChanges()).toBe(true);
  expect(access.save).toHaveBeenCalledWith(expect.objectContaining({
    blob: edited,
    target: { kind: 'create', directoryPath: '/', name: 'copy.webp' },
  }));
  expect(wrapper.vm.hasChanges()).toBe(false);
});

it('acknowledges a committed GGUF edit when reopening the new snapshot fails', async () => {
  const path = '/model.gguf';
  const original = new Blob(['old header', 'weights']);
  using file = mountFile({ path, blob: original, revision: 'old', locked: false, canWriteToRoot: true });
  const { wrapper } = file;
  access.inspectModel.mockResolvedValue({
    status: 'weights',
    value: {
      format: 'gguf',
      version: 3,
      alignment: 32,
      dataOffset: 10,
      split: undefined,
      tensors: [],
      metadata: [{
        key: 'general.name',
        type: 'string',
        value: 'Original name',
        elementType: undefined,
        count: undefined,
        range: undefined,
      }],
    },
  });
  access.prepareGgufMetadataRewrite.mockResolvedValueOnce({ header: new TextEncoder().encode('new header'), bodyOffset: 10 });
  access.save.mockResolvedValueOnce({ path, revision: 'new' });
  access.openSnapshot.mockRejectedValueOnce(new Error('Cannot reopen the saved file'));
  await vi.waitFor(() => expect(wrapper.findComponent(FileExplorerModelView).exists()).toBe(true));
  await vi.waitFor(() => expect(wrapper.find('[data-testid="model-overview"]').exists()).toBe(true));
  await wrapper.get('[data-testid="model-metadata-tab"]').trigger('click');
  await wrapper.get('[data-testid="model-metadata-key"]').trigger('click');
  await wrapper.get('[data-testid="model-metadata-edit"]').trigger('click');
  await wrapper.get('[data-testid="model-metadata-input"]').setValue('New name');

  expect(await wrapper.vm.saveChanges()).toBe(true);
  expect(wrapper.vm.hasChanges()).toBe(false);
  expect(wrapper.get('[role="alert"]').text()).toContain('Cannot reopen the saved file');
  expect(wrapper.find('[data-testid="model-file-view"]').exists()).toBe(false);
  const write = access.save.mock.calls[0]?.[0];
  expect(write?.target).toEqual({ kind: 'replace', path, revision: 'old' });
  expect(await write?.blob.text()).toBe('new headerweights');
  expect(wrapper.emitted('saved')).toHaveLength(1);
});
