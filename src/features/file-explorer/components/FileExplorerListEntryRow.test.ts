import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';

import type { FileExplorerEntry } from '@/features/file-explorer/logic/types';
import FileExplorerListEntryRow from './FileExplorerListEntryRow.vue';

function createEntry({ readOnly = false }: { readOnly?: boolean } = {}): FileExplorerEntry {
  return {
    path: '/workspace/file.txt',
    name: 'file.txt',
    kind: 'file',
    size: 4,
    lastModified: 1,
    extension: '.txt',
    mimeCategory: 'text',
    readOnly,
    canNavigate: false,
    canMutate: !readOnly,
  };
}

describe('FileExplorerListEntryRow', () => {
  it('renders the shared name and trailing presentation without requiring explorer context', () => {
    const wrapper = mount(FileExplorerListEntryRow, {
      props: {
        entry: createEntry(),
        appearance: 'default',
      },
      slots: {
        name: '<span data-testid="custom-name">custom.txt</span>',
        trailing: '<span data-testid="custom-trailing">status</span>',
      },
    });

    expect(wrapper.get('[data-testid="custom-name"]').text()).toBe('custom.txt');
    expect(wrapper.get('[data-testid="custom-trailing"]').text()).toBe('status');
    expect(wrapper.find('[data-testid="entry-lock-icon"]').exists()).toBe(false);
  });

  it('shows the lock for a read-only entry', () => {
    const wrapper = mount(FileExplorerListEntryRow, {
      props: {
        entry: createEntry({ readOnly: true }),
        appearance: 'default',
      },
    });

    expect(wrapper.find('[data-testid="entry-lock-icon"]').exists()).toBe(true);
  });

  it('applies planned and blocked visual states', async () => {
    const wrapper = mount(FileExplorerListEntryRow, {
      props: {
        entry: createEntry(),
        appearance: 'planned',
      },
    });

    expect(wrapper.classes()).toContain('ring-blue-400/70');

    await wrapper.setProps({ appearance: 'blocked' });
    expect(wrapper.classes()).toContain('ring-red-400/80');
  });
});
