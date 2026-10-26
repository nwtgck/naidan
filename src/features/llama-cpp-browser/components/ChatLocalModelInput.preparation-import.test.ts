import { flushPromises, mount } from '@vue/test-utils';
import { computed } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChatLocalModelUi } from '@/composables/chat/chat-scoped/useChatLocalModel';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import ChatLocalModelInput from './ChatLocalModelInput.vue';

const preparation = vi.hoisted(() => ({ tasks: [] as (() => Promise<void>)[], gate: Promise.withResolvers<void>(), imports: 0, mounts: 0, prefetch: [] as (() => void)[] }));
vi.mock('@/utils/idle-task', () => ({
  scheduleIdleTask: ({ task }: { task: () => Promise<void> }) => {
    preparation.tasks.push(task);
    return { cancel: vi.fn() };
  },
}));
vi.mock('../composables/useChatBrowserModelPickerTab', () => ({ useChatBrowserModelPickerTab: () => ({ remembered: computed(() => 'files'), remember: vi.fn(async () => {}) }) }));
vi.mock('./LlamaCppBrowserRepositoryPicker.vue', async () => {
  preparation.imports++;
  await preparation.gate.promise;
  return {
    __esModule: true,
    default: {
      setup() {
        preparation.mounts++;
      },
      template: '<div data-testid="delayed-repository-picker" />',
    },
  };
});

const originalIdleCallback = Object.getOwnPropertyDescriptor(window, 'requestIdleCallback');

beforeEach(async () => {
  Object.defineProperty(window, 'requestIdleCallback', {
    configurable: true,
    value: vi.fn<(callback: IdleRequestCallback) => number>().mockImplementation(callback => {
      preparation.prefetch.push(() => callback({ didTimeout: false, timeRemaining: () => 50 }));
      return preparation.prefetch.length;
    }),
  });
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  if (originalIdleCallback !== undefined) {
    Object.defineProperty(window, 'requestIdleCallback', originalIdleCallback);
  } else {
    Reflect.deleteProperty(window, 'requestIdleCallback');
  }
});

it('prefetches code through the shared mechanism without mounting a late tab after closing', async () => {
  const state = {
    operation: computed(() => undefined),
    downloadJob: computed(() => undefined),
    maySend: computed(() => true),
    useModel: vi.fn(async () => {}),
    useRepositoryModel: vi.fn(async () => {}),
    pauseDownload: vi.fn(),
    accept: vi.fn(async () => {}),
    acceptAfterFailedDownload: vi.fn(async () => {}),
    choose: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    TEST_ONLY: {},
  } satisfies ChatLocalModelUi;
  const wrapper = mount(ChatLocalModelInput, { props: { state, expansion: 'closed', availability: 'available', layout: 'welcome', scrollMode: 'source', sourceTabsHost: undefined } });
  using _cleanup = {
    [Symbol.dispose]() {
      preparation.gate.resolve();
      wrapper.unmount();
    },
  };
  await flushPromises();
  expect(preparation.imports).toBe(0);
  expect(preparation.prefetch).toHaveLength(3);
  preparation.prefetch[0]!();
  await flushPromises();
  expect(preparation.imports).toBe(1);
  expect(preparation.mounts).toBe(0);
  await wrapper.setProps({ expansion: 'open' });
  await flushPromises();
  const task = preparation.tasks[0]!();
  await flushPromises();
  expect(preparation.imports).toBe(1);
  await wrapper.setProps({ expansion: 'closed' });
  preparation.gate.resolve();
  await task;
  await flushPromises();
  expect(preparation.mounts).toBe(0);
  expect(wrapper.find('[data-testid=delayed-repository-picker]').exists()).toBe(false);
  expect(preparation.tasks).toHaveLength(1);
  await wrapper.setProps({ expansion: 'open' });
  await flushPromises();
  await preparation.tasks[1]!();
  await flushPromises();
  expect(preparation.mounts).toBe(1);
});
