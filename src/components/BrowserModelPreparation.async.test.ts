import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import BrowserModelPreparation from './BrowserModelPreparation.vue';

const load = vi.hoisted(() => vi.fn());
vi.mock('@/utils/module-loader', () => ({ createModuleLoader: () => ({ load, prefetch: async () => {} }) }));
enableAutoUnmount(afterEach);

beforeEach(async () => {
  load.mockReset();
  await ensureAllStringsForTest({ locale: 'en' });
});

it('keeps the model header and offers a UI-only retry when the configuration chunk fails', async () => {
  const pending = Promise.withResolvers<unknown>();
  load.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ default: { template: '<div data-testid="loaded-file-settings" />' } });
  const wrapper = mount(BrowserModelPreparation, {
    props: {
      model: { name: 'Example 20B', developer: 'Owner', repository: 'owner/model', bytes: undefined },
      entry: 'model-url',
      stage: 'needs-selection',
      interaction: 'ready',
      variant: 'Q4_K_M',
      quantizationOptions: [],
      startStatus: 'idle',
      error: undefined,
      selectionState: { status: 'needs-selection', operation: Symbol('files'), input: 'owner/model', mainChoices: [{ path: 'model.gguf', label: 'Q4_K_M', size: 100 }], companionChoices: [], selectedMainPath: 'model.gguf', selectedCompanionPath: undefined, companionRequirement: 'none' },
    },
  });
  expect(wrapper.get('[data-testid="preparation-model-name"]').text()).toBe('Example 20B');
  expect(wrapper.get('[data-testid="model-files-ui-loading"]').text()).toContain('Loading model settings');
  pending.reject(new Error('chunk unavailable'));
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toBe('Could not load model settings.');
  expect(wrapper.get('[data-testid="preparation-model-name"]').text()).toBe('Example 20B');
  await wrapper.get('[data-testid="model-files-ui-retry"]').trigger('click');
  await flushPromises();
  expect(load).toHaveBeenCalledTimes(2);
  expect(wrapper.find('[data-testid="loaded-file-settings"]').exists()).toBe(true);
  expect(wrapper.find('[data-testid="model-files-ui-loading"]').exists()).toBe(false);
  expect(wrapper.emitted('start')).toBeUndefined();
  expect(wrapper.emitted('retry')).toBeUndefined();
});
