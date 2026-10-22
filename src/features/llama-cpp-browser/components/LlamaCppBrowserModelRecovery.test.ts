import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, nextTick, ref, shallowRef } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { ModelLaunchTarget } from '@/01-models/llama-cpp-browser-model-launch';
import type { DownloadJob } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import type { MissingLlamaCppBrowserModelUi } from '@/features/llama-cpp-browser/composables/useMissingLlamaCppBrowserModel';
import LlamaCppBrowserModelRecovery from './LlamaCppBrowserModelRecovery.vue';

const wrappers: VueWrapper[] = [];

function createState({ modelId }: { modelId: string }) {
  const job = shallowRef<DownloadJob>();
  const availability = ref<MissingLlamaCppBrowserModelUi['availability']['value']>('missing');
  const state = {
    modelId: computed(() => modelId),
    availability,
    verification: ref<MissingLlamaCppBrowserModelUi['verification']['value']>('idle'),
    operation: ref<MissingLlamaCppBrowserModelUi['operation']['value']>('idle'),
    target: shallowRef<ModelLaunchTarget>(),
    failure: ref(false),
    canDownload: computed(() => modelId.startsWith('hf.co/')),
    job: computed(() => job.value),
    busy: computed(() => false),
    visible: computed(() => availability.value === 'missing' || availability.value === 'unreadable'),
    maySend: computed(() => availability.value === 'available'),
    retry: vi.fn(),
    review: vi.fn(async () => {}),
    download: vi.fn(async () => {}),
    TEST_ONLY: {},
  } satisfies MissingLlamaCppBrowserModelUi;
  return { state, job };
}

function render({ state, appearance }: { state: MissingLlamaCppBrowserModelUi, appearance: 'welcome' | 'compact' | undefined }): VueWrapper {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: {} }] });
  const wrapper = mount(LlamaCppBrowserModelRecovery, {
    props: { state, appearance },
    global: {
      plugins: [router],
      stubs: { LlamaCppBrowserDownloadJob: { name: 'LlamaCppBrowserDownloadJob', props: ['job', 'disabled', 'appearance', 'sourcesVisibility'], template: '<div data-testid="recovery-download-job" />' } },
    },
  });
  wrappers.push(wrapper);
  return wrapper;
}

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) {
    wrapper.unmount();
  }
});

describe('model recovery presentation', () => {
  it.each([
    { id: 'temp/LiquidAI_LFM2.5-VL-3B-GGUF', name: 'LiquidAI_LFM2.5-VL-3B-GGUF' },
    { id: 'hf.co/owner/LFM2.5-VL-3B-GGUF:Q4_K_M', name: 'owner/LFM2.5-VL-3B-GGUF:Q4_K_M' },
    { id: 'host/MyModels1/owner/LFM2.5-VL-3B-GGUF:Q8_0', name: 'MyModels1/owner/LFM2.5-VL-3B-GGUF:Q8_0' },
  ])('keeps the complete model name and selector readable for $id', ({ id, name }) => {
    const { state } = createState({ modelId: id });
    const wrapper = render({ state, appearance: 'compact' });
    const model = wrapper.get('[data-testid="model-recovery-name"]');
    expect(model.text()).toBe(name);
    expect(model.attributes('title')).toBe(id);
    expect(model.classes()).toContain('break-all');
    expect(model.classes()).not.toContain('truncate');
    expect(wrapper.get('[data-testid="model-recovery"]').classes()).toContain('rounded-xl');
    expect(wrapper.text()).not.toContain('You can keep writing here');
  });

  it('preserves the large welcome explanation while compact recovery hides long download source lists', async () => {
    const { state, job } = createState({ modelId: 'hf.co/owner/Model-3B:Q4_K_M' });
    const welcome = render({ state, appearance: undefined });
    expect(welcome.text()).toContain('You can keep writing here');
    expect(welcome.get('[data-testid="model-recovery"]').classes()).toContain('max-w-xl');
    job.value = { id: 1, key: 'job', repository: 'owner/Model-3B', source: 'repository', destination: { kind: 'opfs' }, status: 'downloading', selection: undefined, progress: undefined, error: undefined };
    await nextTick();
    const compact = render({ state, appearance: 'compact' });
    expect(welcome.getComponent({ name: 'LlamaCppBrowserDownloadJob' }).props('sourcesVisibility')).toBe('visible');
    expect(compact.getComponent({ name: 'LlamaCppBrowserDownloadJob' }).props('sourcesVisibility')).toBe('hidden');
    compact.getComponent({ name: 'LlamaCppBrowserDownloadJob' }).vm.$emit('resume');
    expect(state.download).toHaveBeenCalledOnce();
  });

  it('keeps review and recheck actions and disappears once the model becomes available', async () => {
    const { state } = createState({ modelId: 'hf.co/owner/Model-3B:Q4_K_M' });
    const wrapper = render({ state, appearance: 'compact' });
    await wrapper.get('[data-testid="model-recovery-review"]').trigger('click');
    await wrapper.get('[data-testid="model-recovery-recheck"]').trigger('click');
    expect(state.review).toHaveBeenCalledOnce();
    expect(state.retry).toHaveBeenCalledOnce();
    state.availability.value = 'unreadable';
    await nextTick();
    expect(wrapper.find('[data-testid="model-recovery-review"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="model-recovery-manage"]').exists()).toBe(true);
    state.availability.value = 'available';
    await nextTick();
    expect(wrapper.find('[data-testid="model-recovery"]').exists()).toBe(false);
  });
});
