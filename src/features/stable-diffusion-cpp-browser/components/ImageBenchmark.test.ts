import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { useImageGeneration } from '@/features/image-generation/test-utils/unavailable-image-view';
import { useImageBenchmark } from '@/features/stable-diffusion-cpp-browser/use-image-benchmark-standalone';
import ImageBenchmark from './ImageBenchmark.vue';

let wrapper: VueWrapper | undefined;

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  wrapper?.unmount(); wrapper = undefined;
});

it.each(['import', 'download', 'history-action'])('disables refresh during %s while keeping independent measurement settings editable', async operation => {
  const pending = ref(true);
  const generation = useImageGeneration();
  generation.formDisabled = computed(() => pending.value && operation === 'history-action');
  generation.library.importing = computed(() => pending.value && operation === 'import');
  generation.library.downloading = computed(() => pending.value && operation === 'download');
  generation.library.refresh = vi.fn(async () => {});
  const bench = useImageBenchmark({ generation });
  bench.available = computed(() => true);
  wrapper = mount(ImageBenchmark, { props: { generation, bench, active: true } });
  const refresh = wrapper.get('[data-testid="benchmark-refresh"]');
  expect(refresh.element.matches(':disabled')).toBe(true);
  await refresh.trigger('click');
  expect(generation.library.refresh).not.toHaveBeenCalled();
  const prompt = wrapper.get('[data-testid="parameter-prompt"]');
  expect(prompt.element.matches(':disabled')).toBe(false);
  await prompt.setValue('a quiet afternoon');
  expect(bench.common.value.prompt).toBe('a quiet afternoon');

  pending.value = false;
  // The owner joins a scan already in flight, so refreshing during a scan
  // remains available instead of introducing another unrelated lock.
  generation.library.scanState.value = 'scanning';
  await flushPromises();
  expect(refresh.element.matches(':disabled')).toBe(false);
  await refresh.trigger('click');
  expect(generation.library.refresh).toHaveBeenCalledOnce();
});

it('edits ZIP contents during measurement but locks them to an export in progress', async () => {
  const generation = useImageGeneration();
  const bench = useImageBenchmark({ generation });
  const measuring = ref(true);
  bench.busy = computed(() => measuring.value);
  wrapper = mount(ImageBenchmark, { props: { generation, bench, active: true } });
  const prompts = wrapper.get('[data-testid="benchmark-include-prompts"]');
  const inputs = wrapper.get('[data-testid="benchmark-input-images"]');
  expect(prompts.element.matches(':disabled')).toBe(false);
  expect(inputs.element.matches(':disabled')).toBe(false);
  await prompts.setValue(true);
  await inputs.setValue(true);
  expect(bench.includePrompts.value).toBe(true);
  expect(bench.includeInputImages.value).toBe('include');
  expect(wrapper.get('[data-testid="benchmark-clear"]').element.matches(':disabled')).toBe(true);
  bench.exporting.value = true; await flushPromises();
  expect(prompts.element.matches(':disabled')).toBe(true);
  expect(inputs.element.matches(':disabled')).toBe(true);
  measuring.value = false; await flushPromises();
  expect(prompts.element.matches(':disabled')).toBe(true);
  expect(inputs.element.matches(':disabled')).toBe(true);
  expect(wrapper.get('[data-testid="benchmark-clear"]').element.matches(':disabled')).toBe(true);
});
