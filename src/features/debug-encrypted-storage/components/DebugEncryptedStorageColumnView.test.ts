import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { DebugEncryptedStorageNavigationColumn } from '@/features/debug-encrypted-storage/logic/navigation';
import DebugEncryptedStorageColumnView from './DebugEncryptedStorageColumnView.vue';

const manifestRef = { type: 'store_manifest' as const };
const columns: readonly DebugEncryptedStorageNavigationColumn[] = [
  {
    ref: { type: 'root' },
    title: 'Encrypted store',
    kind: 'root',
    references: [{ label: 'Store manifest', ref: manifestRef }],
  },
  {
    ref: manifestRef,
    title: 'Store manifest',
    kind: 'manifest',
    references: [],
  },
];

describe('DebugEncryptedStorageColumnView', () => {
  it('marks the reference selected by the next column and emits its source column', async () => {
    const wrapper = mount(DebugEncryptedStorageColumnView, {
      props: { columns },
    });

    const referenceButton = wrapper.get('section[data-testid="encrypted-storage-column-0"] button');
    expect(referenceButton.classes()).toContain('bg-blue-50');
    await referenceButton.trigger('click');
    expect(wrapper.emitted('navigate')).toEqual([[
      { ref: manifestRef, columnIndex: 0 },
    ]]);
  });
});
