import { mount } from '@vue/test-utils';
import { beforeEach, expect, it } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import TemporaryModelSaveNotice from './TemporaryModelSaveNotice.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

it('keeps the source name after saving and shows useful units for a small model', async () => {
  const sourceModel = { modelId: 'temp/Models:Gemma-Q4_K_M.gguf', size: 40000000, importedAt: 1 };
  const wrapper = mount(TemporaryModelSaveNotice, { props: { state: { phase: 'offered', sourceModel, model: sourceModel, progress: undefined, error: undefined } } });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  expect(wrapper.text()).toContain('Gemma-Q4_K_M');
  expect(wrapper.text()).toContain('MiB');
  expect(wrapper.text()).not.toContain('temp/');
  await wrapper.get('[data-testid="temporary-model-save"]').trigger('click');
  expect(wrapper.emitted('save')).toHaveLength(1);
  await wrapper.setProps({ state: { phase: 'saved', sourceModel, model: { ...sourceModel, modelId: 'user/Models-copy' }, progress: undefined, error: undefined } });
  expect(wrapper.text()).toContain('Gemma-Q4_K_M');
  expect(wrapper.text()).not.toContain('Models-copy');
});
