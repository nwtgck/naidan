import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { FileExplorerEntry } from '@/features/file-explorer/logic/types';
import type { FileExplorerReadDirectoryResponse, FileExplorerWorkerClient } from '@/features/file-explorer/worker/types';
import FileExplorerFileView from './FileExplorerFileView.vue';

type DirectoryEntry = FileExplorerReadDirectoryResponse['entries'][number];

function makeEntry({ path, kind }: { path: string, kind: FileExplorerEntry['kind'] }): DirectoryEntry {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return {
    path,
    name,
    kind,
    size: kind === 'file' ? 3 : undefined,
    lastModified: undefined,
    extension: kind === 'file' ? '.txt' : '',
    mimeCategory: kind === 'file' ? 'text' : 'binary',
    readOnly: false,
    canNavigate: kind === 'directory',
    canMutate: true,
  };
}

function directory({ path, entries }: { path: string, entries: DirectoryEntry[] }): FileExplorerReadDirectoryResponse {
  return { directoryName: path, directoryPath: path, readOnly: false, pathSegments: [], entries };
}

function mountView({ entry, readDirectory }: { entry: FileExplorerEntry, readDirectory: FileExplorerWorkerClient['readDirectory'] }) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const wrapper = mount(FileExplorerFileView, {
    attachTo: host,
    props: { entry, readDirectory, directoryPath: '/', treeVisible: false, treeId: 'tree', informationVisible: false, informationId: 'info', directoryRevision: 0 },
    slots: { default: () => h('input', { 'data-testid': 'editor' }) },
  });
  return {
    wrapper,
    [Symbol.dispose]() {
      wrapper.unmount();
      host.remove();
    },
  };
}

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

describe('FileExplorerFileView', () => {
  it('reopens a collapsed root and waits for a breadcrumb folder to load before focusing it', async () => {
    const entry = makeEntry({ path: '/current.txt', kind: 'file' });
    const docs = makeEntry({ path: '/docs', kind: 'directory' });
    const nested = makeEntry({ path: '/docs/nested', kind: 'directory' });
    const loading = Promise.withResolvers<FileExplorerReadDirectoryResponse>();
    const readDirectory = vi.fn<FileExplorerWorkerClient['readDirectory']>(({ path }) => {
      return path === '/docs' ? loading.promise : Promise.resolve(directory({ path, entries: path === '/' ? [entry, docs] : [] }));
    });
    using view = mountView({ entry, readDirectory });
    const { wrapper } = view;
    await wrapper.setProps({ treeVisible: true });
    await flushPromises();
    await wrapper.get('[data-path="/"]').trigger('keydown', { key: 'ArrowLeft' });
    expect(wrapper.find('[data-path="/docs"]').exists()).toBe(false);
    const editor = wrapper.get('[data-testid="editor"]');
    (editor.element as HTMLElement).focus();
    wrapper.vm.revealDirectory({ path: nested.path });
    await flushPromises();
    expect(wrapper.get('[data-path="/"]').attributes('aria-expanded')).toBe('true');
    expect(readDirectory).toHaveBeenCalledWith({ path: docs.path });
    expect(document.activeElement).toBe(editor.element);
    loading.resolve(directory({ path: docs.path, entries: [nested] }));
    await flushPromises();
    expect(document.activeElement).toBe(wrapper.get('[data-path="/docs/nested"]').element);
    expect(wrapper.emitted('open')).toBeUndefined();
  });

  it('resizes the tree from its right separator without changing the file view', async () => {
    const entry = makeEntry({ path: '/current.txt', kind: 'file' });
    const readDirectory = vi.fn<FileExplorerWorkerClient['readDirectory']>().mockResolvedValue(directory({ path: '/', entries: [entry] }));
    using view = mountView({ entry, readDirectory });
    await view.wrapper.setProps({ treeVisible: true });
    const pane = view.wrapper.get('[data-testid="file-explorer-tree-pane"]');
    const separator = view.wrapper.get('[data-testid="tree-resize-handle"]');
    expect(separator.attributes('aria-valuenow')).toBe('208');
    await separator.trigger('keydown', { key: 'ArrowRight' });
    expect(separator.attributes('aria-valuenow')).toBe('232');
    expect(pane.attributes('style')).toContain('--tree-width: 232px');
    await separator.trigger('keydown', { key: 'ArrowLeft' });
    expect(separator.attributes('aria-valuenow')).toBe('208');
  });

  it('loads just the open branches and only switches files on explicit activation', async () => {
    const entry = makeEntry({ path: '/docs/notes/current.txt', kind: 'file' });
    const next = makeEntry({ path: '/docs/notes/next.txt', kind: 'file' });
    const fixture = new Map([
      ['/', [makeEntry({ path: '/docs', kind: 'directory' }), makeEntry({ path: '/other', kind: 'directory' })]],
      ['/docs', [makeEntry({ path: '/docs/notes', kind: 'directory' })]],
      ['/docs/notes', [entry, next]],
    ]);
    const readDirectory = vi.fn<FileExplorerWorkerClient['readDirectory']>(async ({ path }) =>
      directory({ path, entries: fixture.get(path) ?? [] }),
    );
    using view = mountView({ entry, readDirectory });
    const { wrapper } = view;
    await flushPromises();
    expect(readDirectory).not.toHaveBeenCalled();

    await wrapper.setProps({ treeVisible: true });
    await flushPromises();
    expect(readDirectory.mock.calls).toEqual([[{ path: '/' }], [{ path: '/docs' }], [{ path: '/docs/notes' }]]);
    const active = wrapper.get('[data-path="/docs/notes/current.txt"]');
    const sibling = wrapper.get('[data-path="/docs/notes/next.txt"]');
    expect(active.attributes('aria-selected')).toBe('true');
    await active.trigger('keydown', { key: 'ArrowDown' });
    await flushPromises();
    expect(document.activeElement).toBe(sibling.element);
    expect(wrapper.emitted('open')).toBeUndefined();
    await sibling.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('open')).toEqual([[{ entry: next }]]);
    await sibling.trigger('click');
    expect(wrapper.emitted('open')).toEqual([[{ entry: next }], [{ entry: next }]]);
  });

  it('keeps the editor and open branches when hiding and restoring both panes', async () => {
    const entry = makeEntry({ path: '/docs/current.txt', kind: 'file' });
    const readDirectory = vi.fn<FileExplorerWorkerClient['readDirectory']>(async ({ path }) =>
      directory({ path, entries: path === '/' ? [makeEntry({ path: '/docs', kind: 'directory' })] : [entry] }),
    );
    using view = mountView({ entry, readDirectory });
    const { wrapper } = view;
    await wrapper.setProps({ treeVisible: true, informationVisible: true });
    await flushPromises();

    const tree = wrapper.get('[data-testid="file-explorer-file-tree"]');
    const information = wrapper.get('[data-testid="file-explorer-file-information"]');
    const editor = wrapper.get<HTMLInputElement>('[data-testid="editor"]');
    const editorElement = editor.element;
    await editor.setValue('Unsaved');
    await wrapper.setProps({ treeVisible: false, informationVisible: false });
    expect(wrapper.get('[data-testid="editor"]').element).toBe(editorElement);
    expect(editor.element.value).toBe('Unsaved');
    expect(tree.isVisible()).toBe(false);
    expect(information.isVisible()).toBe(false);

    await wrapper.setProps({ treeVisible: true, informationVisible: true });
    expect(tree.get('[data-path="/docs"]').attributes('aria-expanded')).toBe('true');
    expect(tree.isVisible()).toBe(true);
    expect(information.isVisible()).toBe(true);
    expect(readDirectory).toHaveBeenCalledTimes(2);

    const rootRefresh = Promise.withResolvers<FileExplorerReadDirectoryResponse>();
    const docsRefresh = Promise.withResolvers<FileExplorerReadDirectoryResponse>();
    readDirectory.mockImplementation(({ path }) => path === '/' ? rootRefresh.promise : docsRefresh.promise);
    await wrapper.setProps({ directoryRevision: 1 });
    expect(tree.get('[data-path="/docs/current.txt"]').isVisible()).toBe(true);
    expect(tree.get('[data-path="/docs"]').attributes('aria-busy')).toBeUndefined();
    rootRefresh.resolve(directory({ path: '/', entries: [makeEntry({ path: '/docs', kind: 'directory' })] }));
    docsRefresh.resolve(directory({ path: '/docs', entries: [entry, makeEntry({ path: '/docs/new.txt', kind: 'file' })] }));
    await flushPromises();
    expect(tree.get('[data-path="/docs"]').attributes('aria-expanded')).toBe('true');
    expect(tree.get('[data-path="/docs/new.txt"]').isVisible()).toBe(true);
    expect(readDirectory).toHaveBeenCalledTimes(4);
  });

  it('discards a late response after a branch is collapsed', async () => {
    const entry = makeEntry({ path: '/current.txt', kind: 'file' });
    const folder = makeEntry({ path: '/docs', kind: 'directory' });
    const loading = Promise.withResolvers<FileExplorerReadDirectoryResponse>();
    const readDirectory = vi.fn<FileExplorerWorkerClient['readDirectory']>()
      .mockResolvedValueOnce(directory({ path: '/', entries: [folder, entry] }))
      .mockReturnValueOnce(loading.promise)
      .mockResolvedValueOnce(directory({ path: '/docs', entries: [makeEntry({ path: '/docs/fresh.txt', kind: 'file' })] }));
    using view = mountView({ entry, readDirectory });
    const { wrapper } = view;
    await wrapper.setProps({ treeVisible: true });
    await flushPromises();
    const row = wrapper.get('[data-path="/docs"]');
    await row.trigger('click');
    expect(row.attributes('aria-busy')).toBe('true');
    await row.trigger('click');
    loading.resolve(directory({ path: '/docs', entries: [makeEntry({ path: '/docs/stale.txt', kind: 'file' })] }));
    await flushPromises();
    expect(wrapper.find('[data-path="/docs/stale.txt"]').exists()).toBe(false);
    await row.trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-path="/docs/fresh.txt"]').exists()).toBe(true);
    expect(readDirectory).toHaveBeenCalledTimes(3);
  });

  it('keeps children of a linked directory under the path used to open it', async () => {
    const entry = makeEntry({ path: '/current.txt', kind: 'file' });
    const alias = makeEntry({ path: '/alias', kind: 'directory' });
    const readDirectory = vi.fn<FileExplorerWorkerClient['readDirectory']>(async ({ path }) =>
      directory({ path, entries: [alias, entry] }),
    );
    using view = mountView({ entry, readDirectory });
    const { wrapper } = view;
    await wrapper.setProps({ treeVisible: true });
    await flushPromises();
    await wrapper.get('[data-path="/alias"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-path="/alias/alias"]').attributes('aria-level')).toBe('3');
    expect(readDirectory.mock.calls).toEqual([[{ path: '/' }], [{ path: '/alias' }]]);
    await wrapper.get('[data-path="/alias/current.txt"]').trigger('click');
    expect(wrapper.emitted('open')).toEqual([[{ entry: { ...entry, path: '/alias/current.txt' } }]]);
  });
});
