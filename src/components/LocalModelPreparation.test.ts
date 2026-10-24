import { mount } from '@vue/test-utils';
import { computed, ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { ErrorCode, LocalModel, Progress } from '@/features/llama-cpp-browser/types';
import type { LocalModelLaunchChatUi } from '@/features/llama-cpp-browser/composables/useLocalModelLaunchChat';
import LocalModelPreparation from './LocalModelPreparation.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

function localState() {
  const status = ref<'loading' | 'ready' | 'error'>('loading');
  const visible = ref(true);
  const model = ref<LocalModel | undefined>({ modelId: 'temp/local/Qwen-9B-Q4.gguf', size: 5_600_000_000, importedAt: 1 });
  const homeOriginId = ref<string | undefined>('home-origin');
  const progress = ref<Progress | undefined>({ phase: 'loading', completed: 40, total: 100 });
  const error = ref<ErrorCode | undefined>(undefined);
  return {
    visible,
    status,
    homeOriginId,
    error,
    state: {
      visible: computed(() => visible.value),
      model: computed(() => model.value),
      homeOriginId: computed(() => homeOriginId.value),
      status: computed(() => status.value),
      progress: computed(() => progress.value),
      error: computed(() => error.value),
      maySend: computed(() => status.value === 'ready'),
      retry: vi.fn(async () => {}),
      back: vi.fn(async () => {}),
      TEST_ONLY: {},
    } satisfies LocalModelLaunchChatUi,
  };
}

describe('local model preparation presentation', () => {
  it('keeps the real model name and size through loading and ready', async () => {
    const { state, status } = localState();
    const wrapper = mount(LocalModelPreparation, { props: { state }, global: { stubs: { Teleport: true } } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    expect(wrapper.get('[data-testid="preparation-model-name"]').text()).toBe('Qwen-9B-Q4');
    expect(wrapper.text()).toContain('5.22 GiB');
    // Navigation/privacy live above the welcome content in ChatPane.
    expect(wrapper.find('[data-testid="model-launch-privacy-trigger"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="model-preparation-brand"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="model-preview-variant-input"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="model-load-percentage"]').text()).toBe('40%');
    expect(wrapper.find('[data-testid="back-to-model-selection"]').exists()).toBe(false);
    status.value = 'ready';
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-testid="preparation-model-name"]').text()).toBe('Qwen-9B-Q4');
    expect(wrapper.text()).toContain('5.22 GiB');
    expect(wrapper.find('[data-testid="model-preparation-ready"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="model-launch-loading"]').exists()).toBe(false);
  });

  it('offers a local retry without an HF variant or new Start action', async () => {
    const { state, visible, status, error, homeOriginId } = localState();
    status.value = 'error';
    error.value = 'runtime-error';
    homeOriginId.value = undefined;
    const wrapper = mount(LocalModelPreparation, { props: { state }, global: { stubs: { Teleport: true } } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    expect(wrapper.find('[data-testid="model-preview-variant-input"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="back-to-model-selection"]').exists()).toBe(false);
    const retry = wrapper.get('[data-testid="start-preview-model"]');
    expect(retry.text()).toContain('Retry');
    await retry.trigger('click');
    expect(state.retry).toHaveBeenCalledOnce();
    visible.value = false;
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="local-model-preparation"]').exists()).toBe(false);
  });
});
