import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { useImageGeneration } from '@/features/stable-diffusion-cpp-browser/use-image-generation-standalone';
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
