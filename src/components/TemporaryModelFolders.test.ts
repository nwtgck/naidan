import { beforeEach, afterEach, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import TemporaryModelFolders from './TemporaryModelFolders.vue';
import { temporaryModelFiles } from '@/logic/temporary-model-files';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  for (const root of temporaryModelFiles.list()) {
    temporaryModelFiles.remove({ rootPath: root.rootPath });
  }
});

it('shows the same roots in two feature panes, unregisters globally and does not unregister on unmount', async () => {
  const a = mount(TemporaryModelFolders, { props: { disabled: false } });
  const b = mount(TemporaryModelFolders, { props: { disabled: true } });
  using _cleanup = {
    [Symbol.dispose]() {
      a.unmount();
      b.unmount();
    },
  };
  const root = temporaryModelFiles.register({ directory: { rootName: 'shared', files: [{ relativePath: 'weights/model.gguf', file: new File(['weights'], 'model.gguf') }] }, signal: undefined });
  await nextTick();
  expect(a.text()).toContain(root.rootPath);
  expect(b.text()).toContain(root.rootPath);
  expect(a.text()).toContain('both');
  const disabled = b.get<HTMLButtonElement>(`[data-testid="unregister-${root.rootPath}"]`);
  expect(disabled.element.disabled).toBe(true);
  await disabled.trigger('click');
  expect(temporaryModelFiles.list()).toHaveLength(1);
  a.unmount();
  expect(temporaryModelFiles.list()).toHaveLength(1);
  await b.setProps({ disabled: false });
  await disabled.trigger('click');
  expect(temporaryModelFiles.list()).toEqual([]);
  expect(b.find('[data-testid="temporary-model-folders"]').exists()).toBe(false);
});
