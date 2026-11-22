import { mount } from '@vue/test-utils';
import { nextTick, ref } from 'vue';
import { beforeEach, expect, it } from 'vitest';
import { FILE_EXPLORER_INJECTION_KEY } from '@/features/file-explorer/composables/useFileExplorer';
import type { FileExplorerContext, FileExplorerEntry } from '@/features/file-explorer/logic/types';
import { filterEntries } from '@/features/file-explorer/logic/utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import FileExplorerEmptyState from './FileExplorerEmptyState.vue';
import FileExplorerIconView from './FileExplorerIconView.vue';
import FileExplorerListView from './FileExplorerListView.vue';

const existingFile: FileExplorerEntry = {
  kind: 'file',
  name: 'notes.txt',
  path: '/notes.txt',
  size: 5,
  lastModified: 1,
  extension: '.txt',
  mimeCategory: 'text',
  readOnly: false,
  canNavigate: false,
  canMutate: true,
};

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

it.each([
  { name: 'list', component: FileExplorerListView },
  { name: 'icon', component: FileExplorerIconView },
])('shows the correct empty state in $name view', async ({ component }) => {
  const entries = ref<FileExplorerEntry[]>([]);
  const loading = ref(false);
  const error = ref<string>();
  const context = {
    get entries() {
      return entries.value;
    },
    get sortedFilteredEntries() {
      return filterEntries({ entries: entries.value, query: 'unmatched' });
    },
    get isLoading() {
      return loading.value;
    },
    get loadError() {
      return error.value;
    },
    selectionState: {
      selectedNames: new Set<string>(),
      anchorName: undefined,
      focusName: undefined,
    },
    renamingEntryName: undefined,
    sortConfig: { field: 'name', direction: 'ascending' },
  } satisfies Pick<FileExplorerContext, 'entries' | 'sortedFilteredEntries' | 'isLoading' | 'loadError' | 'selectionState' | 'renamingEntryName' | 'sortConfig'>;
  const wrapper = mount(component, { global: { provide: { [FILE_EXPLORER_INJECTION_KEY]: context } } });
  using view = {
    wrapper,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  const selector = '[data-testid="file-explorer-empty"]';
  expect(view.wrapper.get(selector).text()).toBe('This folder is empty');

  entries.value = [existingFile];
  await nextTick();
  expect(view.wrapper.get(selector).text()).toBe('No matching items');

  entries.value = [];
  loading.value = true;
  await nextTick();
  expect(view.wrapper.find(selector).exists()).toBe(false);

  loading.value = false;
  error.value = 'Could not load the folder';
  await nextTick();
  expect(view.wrapper.find(selector).exists()).toBe(false);
});

it('uses a full Japanese sentence in the compact folder state', async () => {
  await ensureAllStringsForTest({ locale: 'ja' });
  const wrapper = mount(FileExplorerEmptyState, { props: { density: 'compact', kind: 'empty-folder' } });
  using view = {
    wrapper,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  expect(view.wrapper.get('[role="status"]').text()).toBe('このフォルダに項目はありません');
});
