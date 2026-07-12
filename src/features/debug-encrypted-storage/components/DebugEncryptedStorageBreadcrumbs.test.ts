import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { DebugEncryptedStorageNavigationColumn } from '@/features/debug-encrypted-storage/logic/navigation';
import DebugEncryptedStorageBreadcrumbs from './DebugEncryptedStorageBreadcrumbs.vue';

const columns: readonly DebugEncryptedStorageNavigationColumn[] = [
  {
    ref: { type: 'root' },
    title: 'Encrypted store',
    kind: 'root',
    references: [],
  },
  {
    ref: { type: 'store_manifest' },
    title: 'Store manifest',
    kind: 'manifest',
    references: [],
  },
];

describe('DebugEncryptedStorageBreadcrumbs', () => {
  it('shows the navigation trail and emits the selected ancestor index', async () => {
    const wrapper = mount(DebugEncryptedStorageBreadcrumbs, {
      props: { columns },
    });

    expect(wrapper.get('[data-testid="encrypted-storage-breadcrumb-current"]').text()).toBe('Store manifest');
    await wrapper.get('[data-testid="encrypted-storage-breadcrumb-0"]').trigger('click');
    expect(wrapper.emitted('navigate')).toEqual([[{ index: 0 }]]);
  });
});
