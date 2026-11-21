import { beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, ref } from 'vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { LocalModel, ModelDirectoryInput } from '@/features/llama-cpp-browser/types';
import ModelSelectorFileImport from './ModelSelectorFileImport.vue';

const mocks = vi.hoisted(() => ({ importLocalDirectory: vi.fn() }));

vi.mock('@/features/llama-cpp-browser/model-files', () => ({
  llamaCppBrowserModelFiles: { importLocalDirectory: mocks.importLocalDirectory },
}));
vi.mock('@/features/llama-cpp-browser/composables/useModelDownloadDestination', () => ({
  useModelDownloadDestination: () => ({ linkedFolders: { busy: ref(false) }, failure: computed(() => false) }),
}));

beforeEach(async () => {
  mocks.importLocalDirectory.mockReset();
  await ensureAllStringsForTest({ locale: 'en' });
});

function ggufFile({ name, header }: { name: string, header: 'intact' | 'corrupt' }): File {
  const bytes = new Uint8Array(32);
  if (header === 'intact') {
    bytes.set([71, 71, 85, 70, 3, 0, 0, 0]);
  }
  const file = new File([bytes], name);
  // jsdom File does not expose the browser's Blob.arrayBuffer in this test.
  vi.spyOn(file, 'slice').mockReturnValue(Object.assign(new Blob(), { arrayBuffer: async () => bytes.slice(0, 8).buffer }));
  return file;
}

it('adds usable variants from a dropped folder without choosing and reports skipped weights', async () => {
  const input = [
    ggufFile({ name: 'Speech-Q8_0.gguf', header: 'intact' }),
    ggufFile({ name: 'Speech-Q4_K.gguf', header: 'intact' }),
    ggufFile({ name: 'Broken.gguf', header: 'corrupt' }),
    ggufFile({ name: 'Incomplete-00001-of-00002.gguf', header: 'intact' }),
  ];
  const added: LocalModel[] = input.slice(0, 2).map(file => ({ modelId: '~user/Folder/' + file.name, size: file.size, importedAt: 1 }));
  mocks.importLocalDirectory.mockResolvedValue({ models: added, publication: { isCurrent: () => true } });
  const wrapper = mount(ModelSelectorFileImport, {
    props: { added: [], availableModelIds: [], disabled: false, selectedModelId: 'user/existing/Q8_0' },
  });
  using cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  void cleanup;
  const children = input.map(file => ({ isFile: true, isDirectory: false, name: file.name, file: (resolve: (file: File) => void) => resolve(file) }));
  let batch = 0;
  const folder = { name: 'Folder', isDirectory: true, createReader: () => ({ readEntries: (resolve: (entries: typeof children) => void) => resolve(batch++ === 0 ? children : []) }) };
  const item = { kind: 'file', webkitGetAsEntry: () => folder };
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], items: [item], files: [] } });
  wrapper.get('[data-testid="llama-cpp-browser-drop-zone"]').element.dispatchEvent(drop);
  await vi.dynamicImportSettled();
  await flushPromises();

  expect(wrapper.find('[role="alert"]').exists(), wrapper.text()).toBe(false);
  expect(mocks.importLocalDirectory).toHaveBeenCalledOnce();
  const imported = mocks.importLocalDirectory.mock.calls[0]?.[0].directory as ModelDirectoryInput;
  expect(imported.files.map(entry => entry.relativePath)).toEqual(input.slice(0, 2).map(file => file.name));
  expect(wrapper.emitted('update:added')).toEqual([[added]]);
  expect(wrapper.emitted('inventory-changed')).toEqual([[]]);
  expect(wrapper.emitted('choose')).toBeUndefined();
  expect(wrapper.get('details summary').text()).toContain('(2)');
  expect(wrapper.get('details').text()).toContain('Broken.gguf');
  expect(wrapper.get('details').text()).toContain('Incomplete-00001-of-00002.gguf');

  await wrapper.setProps({ added, availableModelIds: added.map(model => model.modelId) });
  const options = wrapper.findAll('section[aria-label="Added models"] button');
  expect(options.map(option => option.attributes('aria-label'))).toEqual(added.map(model => model.modelId));
  expect(options.map(option => option.attributes('aria-pressed'))).toEqual(['false', 'false']);
  await options[1]!.trigger('click');
  expect(wrapper.emitted('choose')).toEqual([[added[1]]]);
});
