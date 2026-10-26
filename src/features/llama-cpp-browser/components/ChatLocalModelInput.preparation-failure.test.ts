import { flushPromises, mount } from '@vue/test-utils';
import { computed } from 'vue';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ChatLocalModelUi } from '@/composables/chat/chat-scoped/useChatLocalModel';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import ChatLocalModelInput from './ChatLocalModelInput.vue';

const preparation = vi.hoisted(() => ({ attempts: 0 }));
vi.mock('@/utils/idle-task', () => ({ scheduleIdleTask: () => ({ cancel: vi.fn() }) }));
vi.mock('../composables/useChatBrowserModelPickerTab', () => ({ useChatBrowserModelPickerTab: () => ({ remembered: computed(() => 'hugging-face'), remember: vi.fn(async () => {}) }) }));
vi.mock('./LlamaCppBrowserRepositoryPicker.vue', () => {
  if (++preparation.attempts === 1) {
    throw new Error('Could not load the component');
  }
  return { __esModule: true, default: { template: '<div data-testid="retried-repository-picker" />' } };
});

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

it('keeps the panel usable and offers retry when the active tab import fails', async () => {
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
  using test = {
    wrapper: mount(ChatLocalModelInput, { props: { state, expansion: 'open', availability: 'available', layout: 'welcome', scrollMode: 'source', sourceTabsHost: undefined } }),
    [Symbol.dispose]() {
      this.wrapper.unmount();
    },
  };
  await flushPromises();
  expect(test.wrapper.get('[data-testid=chat-model-tab-load-error]').attributes('role')).toBe('alert');
  expect(test.wrapper.find('[data-testid=chat-model-tab-files]').exists()).toBe(true);
  await test.wrapper.get('[data-testid=chat-model-tab-load-error] button').trigger('click');
  await flushPromises();
  expect(test.wrapper.find('[data-testid=chat-model-tab-load-error]').exists()).toBe(false);
  expect(test.wrapper.find('[data-testid=retried-repository-picker]').exists()).toBe(true);
  expect(state.useRepositoryModel).not.toHaveBeenCalled();
});
