import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import ModelDiscoveryPanel from './ModelDiscoveryPanel.vue';

vi.mock('@/composables/useModelDiscoveryTab', async () => {
  const { ref } = await import('vue');
  return { useModelDiscoveryTab: () => ({ remembered: ref('candidates'), remember: vi.fn(async () => {}) }) };
});

const preparation = vi.hoisted(() => ({ tasks: [] as (() => Promise<void>)[], searchImport: Promise.withResolvers<void>(), mounts: 0 }));
vi.mock('@/utils/idle-task', () => ({
  scheduleIdleTask: ({ task }: { task: () => Promise<void> }) => {
    preparation.tasks.push(task);
    return { cancel: vi.fn() };
  },
}));
vi.mock('@/features/llama-cpp-browser/composables/model-inventory', () => ({ listModelInventory: async () => [] }));
vi.mock('@/features/llama-cpp-browser/runtime/host-model-store', () => ({ getHostModelInventoryIssues: () => [] }));
vi.mock('@/features/llama-cpp-browser/model-files', () => ({ captureModelFileStorage: () => () => true, llamaCppBrowserModelFiles: { subscribeModelList: () => () => {} } }));
vi.mock('@/features/llama-cpp-browser/components/LlamaCppBrowserHuggingFaceSearch.vue', async () => {
  await preparation.searchImport.promise;
  return {
    default: {
      name: 'DeferredSearch',
      setup() {
        preparation.mounts++;
      },
      template: '<div data-testid="deferred-search" />',
    },
  };
});

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

it('does not mount a late background import after its panel has closed', async () => {
  const wrapper = mount(ModelDiscoveryPanel, { global: { stubs: { Teleport: true } }, props: { visibility: 'open', tab: 'candidates' } });
  using _cleanup = {
    [Symbol.dispose]() {
      preparation.searchImport.resolve();
      wrapper.unmount();
    },
  };
  await flushPromises();
  const task = preparation.tasks[0]!();
  let finished = false;
  void task.then(() => {
    finished = true;
  });
  await flushPromises();
  expect(finished).toBe(false);
  await wrapper.setProps({ visibility: 'closed' });
  preparation.searchImport.resolve();
  await task;
  await flushPromises();
  expect(preparation.mounts).toBe(0);
  expect(wrapper.find('[data-testid="deferred-search"]').exists()).toBe(false);
  expect(preparation.tasks).toHaveLength(1);

  await wrapper.setProps({ visibility: 'open' });
  await flushPromises();
  await preparation.tasks[1]!();
  await flushPromises();
  expect(preparation.mounts).toBe(1);
  expect(wrapper.find('[data-testid="deferred-search"]').exists()).toBe(true);
});
