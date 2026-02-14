import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import OPFSExplorer from './OPFSExplorer.vue';

// --- Mocks for OPFS ---
class MockFileSystemFileHandle {
  kind = 'file' as const;
  constructor(
    public name: string,
    public size: number = 0,
    private content: string = '',
    public lastModified: number = Date.now()
  ) {}
  async getFile() {
    return {
      size: this.size,
      lastModified: this.lastModified,
      text: () => Promise.resolve(this.content),
    };
  }
}

class MockFileSystemDirectoryHandle {
  kind = 'directory' as const;
  public entries = new Map<string, MockFileSystemDirectoryHandle | MockFileSystemFileHandle>();

  constructor(public name: string) {}

  async *values() {
    for (const entry of this.entries.values()) {
      yield entry;
    }
  }

  async removeEntry(name: string, _options?: { recursive?: boolean }) {
    this.entries.delete(name);
  }
}

const mockOpfsRoot = new MockFileSystemDirectoryHandle('');

const mockShowConfirm = vi.fn().mockResolvedValue(true);
vi.mock('../composables/useConfirm', () => ({
  useConfirm: () => ({
    showConfirm: mockShowConfirm,
  }),
}));

describe('OPFSExplorer.vue', () => {
  const globalStubs = {
    Folder: true,
    FileText: true,
    Trash2: true,
    ChevronLeft: true,
    X: true,
    ChevronRight: true,
    HardDrive: true,
    AlertCircle: true,
    Braces: true,
  };

  beforeEach(() => {
    mockOpfsRoot.entries.clear();
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: () => Promise.resolve(mockOpfsRoot),
      },
    });
  });

  it('renders nothing when modelValue is false', () => {
    const wrapper = mount(OPFSExplorer, {
      props: { modelValue: false },
      global: { stubs: globalStubs },
    });
    expect(wrapper.find('div').exists()).toBe(false);
  });

  it('renders directory contents when opened', async () => {
    mockOpfsRoot.entries.set('folder1', new MockFileSystemDirectoryHandle('folder1'));
    mockOpfsRoot.entries.set('file1.txt', new MockFileSystemFileHandle('file1.txt', 100));

    const wrapper = mount(OPFSExplorer, {
      props: { modelValue: true },
      global: { stubs: globalStubs },
    });
    await flushPromises();

    expect(wrapper.text()).toContain('folder1');
    expect(wrapper.text()).toContain('file1.txt');
    expect(wrapper.text()).toContain('100 B');
  });

  it('navigates into a directory', async () => {
    const subDir = new MockFileSystemDirectoryHandle('subdir');
    subDir.entries.set('inner.txt', new MockFileSystemFileHandle('inner.txt', 50));
    mockOpfsRoot.entries.set('subdir', subDir);

    const wrapper = mount(OPFSExplorer, {
      props: { modelValue: true },
      global: { stubs: globalStubs },
    });
    await flushPromises();

    // Click on subdir
    await wrapper.find('div.group').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('inner.txt');
    expect(wrapper.text()).toContain('50 B');
    expect(wrapper.text()).toContain('root');
    expect(wrapper.text()).toContain('subdir');
  });

  it('views a text file', async () => {
    const content = 'Hello World';
    mockOpfsRoot.entries.set('test.txt', new MockFileSystemFileHandle('test.txt', content.length, content));

    const wrapper = mount(OPFSExplorer, {
      props: { modelValue: true },
      global: { stubs: globalStubs },
    });
    await flushPromises();

    // Find and click the file
    const fileEntry = wrapper.findAll('[data-testid="opfs-entry"]').find(e => e.text().includes('test.txt'));
    await fileEntry?.trigger('click');
    await flushPromises();

    expect(wrapper.find('pre').text()).toBe(content);
    expect(wrapper.text()).toContain('11 B');
  });

  it('formats JSON file automatically and allows toggling', async () => {
    const rawJson = '{"a":1,"b":"test"}';
    const formattedJson = JSON.stringify(JSON.parse(rawJson), null, 2);
    mockOpfsRoot.entries.set('data.json', new MockFileSystemFileHandle('data.json', rawJson.length, rawJson));

    const wrapper = mount(OPFSExplorer, {
      props: { modelValue: true },
      global: { stubs: globalStubs },
    });
    await flushPromises();

    // Click the json file
    const fileEntry = wrapper.findAll('[data-testid="opfs-entry"]').find(e => e.text().includes('data.json'));
    await fileEntry?.trigger('click');
    await flushPromises();

    // Should be formatted automatically
    expect(wrapper.find('pre').text()).toBe(formattedJson);
    expect(wrapper.text()).toContain('Formatted');

    // Click toggle button
    await wrapper.find('button[title="Show Raw JSON"]').trigger('click');
    await flushPromises();

    // Should show raw content
    expect(wrapper.find('pre').text()).toBe(rawJson);
    expect(wrapper.text()).toContain('Format JSON');
  });

  it('shows binary file message for non-text files', async () => {
    mockOpfsRoot.entries.set('image.png', new MockFileSystemFileHandle('image.png', 1024));

    const wrapper = mount(OPFSExplorer, {
      props: { modelValue: true },
      global: { stubs: globalStubs },
    });
    await flushPromises();

    const fileEntry = wrapper.findAll('[data-testid="opfs-entry"]').find(e => e.text().includes('image.png'));
    await fileEntry?.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Binary File');
    expect(wrapper.text()).toContain('Preview not available');
    expect(wrapper.text()).toContain('1.0 KB');
  });

  it('deletes an entry', async () => {
    mockOpfsRoot.entries.set('delete-me.txt', new MockFileSystemFileHandle('delete-me.txt', 0));
    mockShowConfirm.mockResolvedValueOnce(true);

    const wrapper = mount(OPFSExplorer, {
      props: { modelValue: true },
      global: { stubs: globalStubs },
    });
    await flushPromises();

    expect(wrapper.text()).toContain('delete-me.txt');

    // Click delete button
    await wrapper.find('button[class*="hover:text-red-600"]').trigger('click');
    await flushPromises();

    expect(mockShowConfirm).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Delete Entry',
      confirmButtonVariant: 'danger'
    }));
    expect(wrapper.text()).not.toContain('delete-me.txt');
    expect(mockOpfsRoot.entries.has('delete-me.txt')).toBe(false);
  });

  it('does not delete an entry if cancelled', async () => {
    mockOpfsRoot.entries.set('keep-me.txt', new MockFileSystemFileHandle('keep-me.txt', 0));
    mockShowConfirm.mockResolvedValueOnce(false);

    const wrapper = mount(OPFSExplorer, {
      props: { modelValue: true },
      global: { stubs: globalStubs },
    });
    await flushPromises();

    expect(wrapper.text()).toContain('keep-me.txt');

    // Click delete button
    await wrapper.find('button[class*="hover:text-red-600"]').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('keep-me.txt');
    expect(mockOpfsRoot.entries.has('keep-me.txt')).toBe(true);
  });

  it('goes back up in the directory tree', async () => {
    const subDir = new MockFileSystemDirectoryHandle('subdir');
    mockOpfsRoot.entries.set('subdir', subDir);

    const wrapper = mount(OPFSExplorer, {
      props: { modelValue: true },
      global: { stubs: globalStubs },
    });
    await flushPromises();

    // Go into subdir
    await wrapper.find('[data-testid="opfs-entry"]').trigger('click');
    await flushPromises();

    // Breadcrumb should contain subdir as current
    expect(wrapper.find('[data-testid="breadcrumb-current"]').text()).toBe('subdir');

    // Click back button
    await wrapper.find('[data-testid="opfs-back-button"]').trigger('click');
    await flushPromises();

    // Breadcrumb should show root as current (from my mock root name)
    expect(wrapper.find('[data-testid="breadcrumb-current"]').text()).toBe('root');
    // subdir should still be listed in entries
    expect(wrapper.text()).toContain('subdir');
  });

  it('sorts directories before files and alphabetically', async () => {
    mockOpfsRoot.entries.set('z_file.txt', new MockFileSystemFileHandle('z_file.txt'));
    mockOpfsRoot.entries.set('a_file.txt', new MockFileSystemFileHandle('a_file.txt'));
    mockOpfsRoot.entries.set('b_folder', new MockFileSystemDirectoryHandle('b_folder'));
    mockOpfsRoot.entries.set('a_folder', new MockFileSystemDirectoryHandle('a_folder'));

    const wrapper = mount(OPFSExplorer, {
      props: { modelValue: true },
      global: { stubs: globalStubs },
    });
    await flushPromises();

    const entryNames = wrapper.findAll('[data-testid="opfs-entry"] span.text-xs').map(e => e.text());
    expect(entryNames).toEqual(['a_folder', 'b_folder', 'a_file.txt', 'z_file.txt']);
  });

  it('handles invalid JSON gracefully', async () => {
    const invalidJson = '{"broken": }';
    mockOpfsRoot.entries.set('broken.json', new MockFileSystemFileHandle('broken.json', invalidJson.length, invalidJson));

    const wrapper = mount(OPFSExplorer, {
      props: { modelValue: true },
      global: { stubs: globalStubs },
    });
    await flushPromises();

    await wrapper.findAll('[data-testid="opfs-entry"]').find(e => e.text().includes('broken.json'))?.trigger('click');
    await flushPromises();

    // Should not be formatted
    expect(wrapper.find('pre').text()).toBe(invalidJson);
    expect(wrapper.text()).toContain('Format JSON');
    expect(wrapper.text()).not.toContain('Formatted');
  });

  it('shows empty directory state', async () => {
    const wrapper = mount(OPFSExplorer, {
      props: { modelValue: true },
      global: { stubs: globalStubs },
    });
    await flushPromises();

    expect(wrapper.text()).toContain('Empty Directory');
  });

  it('handles nested directory navigation and deep breadcrumbs', async () => {
    const level1 = new MockFileSystemDirectoryHandle('level1');
    const level2 = new MockFileSystemDirectoryHandle('level2');
    level1.entries.set('level2', level2);
    mockOpfsRoot.entries.set('level1', level1);

    const wrapper = mount(OPFSExplorer, {
      props: { modelValue: true },
      global: { stubs: globalStubs },
    });
    await flushPromises();

    // Enter level1
    await wrapper.find('[data-testid="opfs-entry"]').trigger('click');
    await flushPromises();

    // Enter level2
    await wrapper.find('[data-testid="opfs-entry"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="breadcrumb-current"]').text()).toBe('level2');
    const breadcrumbs = wrapper.findAll('[data-testid="breadcrumb-item"]');
    expect(breadcrumbs).toHaveLength(2);
    expect(breadcrumbs[0]!.text()).toBe('root');
    expect(breadcrumbs[1]!.text()).toBe('level1');

    // Go up twice
    await wrapper.find('[data-testid="opfs-back-button"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="breadcrumb-current"]').text()).toBe('level1');
    expect(wrapper.findAll('[data-testid="breadcrumb-item"]')).toHaveLength(1);

    await wrapper.find('[data-testid="opfs-back-button"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="breadcrumb-current"]').text()).toBe('root');
  });

  it('displays the last modified date for files', async () => {
    const timestamp = new Date('2024-01-01T12:00:00').getTime();
    mockOpfsRoot.entries.set('dated.txt', new MockFileSystemFileHandle('dated.txt', 10, 'content', timestamp));

    const wrapper = mount(OPFSExplorer, {
      props: { modelValue: true },
      global: { stubs: globalStubs },
    });
    await flushPromises();

    expect(wrapper.text()).toContain(new Date(timestamp).toLocaleString());
  });

  it('displays correct byte size for files', async () => {
    mockOpfsRoot.entries.set('small.txt', new MockFileSystemFileHandle('small.txt', 512));
    mockOpfsRoot.entries.set('medium.txt', new MockFileSystemFileHandle('medium.txt', 1536)); // 1.5 KB
    mockOpfsRoot.entries.set('large.txt', new MockFileSystemFileHandle('large.txt', 2 * 1024 * 1024)); // 2 MB

    const wrapper = mount(OPFSExplorer, {
      props: { modelValue: true },
      global: { stubs: globalStubs },
    });
    await flushPromises();

    expect(wrapper.text()).toContain('512 B');
    expect(wrapper.text()).toContain('1.5 KB');
    expect(wrapper.text()).toContain('2.0 MB');
  });

  it('maintains selection when navigating back and forth (simulated)', async () => {
    // This is more about checking that selectedFile is cleared when loading a new directory
    mockOpfsRoot.entries.set('file1.txt', new MockFileSystemFileHandle('file1.txt'));
    const sub = new MockFileSystemDirectoryHandle('sub');
    mockOpfsRoot.entries.set('sub', sub);

    const wrapper = mount(OPFSExplorer, {
      props: { modelValue: true },
      global: { stubs: globalStubs },
    });
    await flushPromises();

    // Select file1
    await wrapper.findAll('[data-testid="opfs-entry"]').find(e => e.text().includes('file1.txt'))?.trigger('click');
    await flushPromises();
    expect(wrapper.find('.text-blue-600').exists()).toBe(true);

    // Enter sub
    await wrapper.findAll('[data-testid="opfs-entry"]').find(e => e.text().includes('sub'))?.trigger('click');
    await flushPromises();

    // Selection should be cleared
    expect(wrapper.text()).toContain('Select a file to view');
    expect(wrapper.find('pre').exists()).toBe(false);
  });
});
