import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import FileExplorerPatchView from './FileExplorerPatchView.vue';

describe('FileExplorerPatchView', () => {
  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
  });

  it('shows separate line numbers and TypeScript syntax in a hunk, then falls back to escaped source', async () => {
    const text = `\
--- a/index.ts
+++ b/index.ts
@@ -5 +7 @@
-type Result = string;
+type Result = boolean;
`;
    const wrapper = mount(FileExplorerPatchView, { props: { text } });
    using _mounted = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    const [removed, added] = wrapper.findAll('[data-testid="patch-row"]');
    expect(removed?.get('[data-testid="patch-old-line"]').text()).toBe('5');
    expect(removed?.get('[data-testid="patch-new-line"]').text()).toBe('');
    expect(added?.get('[data-testid="patch-new-line"]').text()).toBe('7');
    expect(added?.get('[data-syntax="keyword"]').text()).toBe('type');

    const malformed = '<p>Not a patch</p>';
    await wrapper.setProps({ text: malformed });
    expect(wrapper.get('[data-testid="patch-source"]').text()).toBe(malformed);
    expect(wrapper.find('[data-testid="patch-source"] p').exists()).toBe(false);
  });
});
