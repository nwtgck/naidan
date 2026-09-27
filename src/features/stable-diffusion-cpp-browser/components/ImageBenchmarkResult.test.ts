import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import type { BenchmarkRun } from '@/features/stable-diffusion-cpp-browser/benchmark/types';
import ImageBenchmarkResult from './ImageBenchmarkResult.vue';

let wrapper: VueWrapper<InstanceType<typeof ImageBenchmarkResult>> | undefined;
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  let sequence = 0;
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = vi.fn(() => `blob:benchmark-${++sequence}`);
    static override revokeObjectURL = vi.fn();
  });
});
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals();
});
function runFixture({ image }: { image: BenchmarkRun['record']['image']['status'] }): BenchmarkRun {
  return {
    record: { id: 'm001-r001', modelIndex: 0, runIndex: 0, plannedKind: 'cold', status: 'succeeded',
      metrics: { diagnosticsReceived: 0, invalidDiagnostics: 0, omittedDiagnostics: 0, steps: [] },
      image: { status: image, bytes: image === 'retained' ? 3 : 0 }, previewFrames: 0, hiddenObserved: false, visibilityChanges: 0 },
    diagnostics: '', png: image === 'retained' ? new Blob(['PNG'], { type: 'image/png' }) : undefined,
  };
}
async function toggle({ open }: { open: boolean }): Promise<void> {
  const details = wrapper!.get<HTMLDetailsElement>('[data-testid="benchmark-result-details"]');
  details.element.open = open;
  await details.trigger('toggle');
}
it('lazily displays the retained PNG without copying it and releases URLs on close, replacement and unmount', async () => {
  const run = runFixture({ image: 'retained' });
  wrapper = mount(ImageBenchmarkResult, { props: { runId: run.record.id, png: run.png, imageStatus: run.record.image.status } });
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  await toggle({ open: true });
  expect(URL.createObjectURL).toHaveBeenCalledWith(run.png);
  expect(wrapper.get('[data-testid="benchmark-result-image"]').attributes('src')).toBe('blob:benchmark-1');
  await toggle({ open: false });
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:benchmark-1');
  expect(wrapper.find('img').exists()).toBe(false);
  await toggle({ open: true });
  await wrapper.setProps({ png: runFixture({ image: 'retained' }).png });
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:benchmark-2');
  expect(wrapper.get('img').attributes('src')).toBe('blob:benchmark-3');
  wrapper.unmount(); wrapper = undefined;
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:benchmark-3');
});
it.each([
  ['not-requested', 'not retained for this run'],
  ['budget-exceeded', 'memory limit was reached'],
  ['no-output', 'No final image is available'],
] as const)('explains %s without creating an image URL', async (image, text) => {
  wrapper = mount(ImageBenchmarkResult, { props: { runId: 'm001-r001', png: undefined, imageStatus: image } });
  await toggle({ open: true });
  expect(wrapper.get('[data-testid="benchmark-result-image-unavailable"]').text()).toContain(text);
  expect(wrapper.find('img').exists()).toBe(false); expect(URL.createObjectURL).not.toHaveBeenCalled();
});
it('updates already-open details when a running measurement produces its final PNG', async () => {
  wrapper = mount(ImageBenchmarkResult, { props: { runId: 'm001-r001', png: undefined, imageStatus: 'no-output' } });
  await toggle({ open: true });
  const png = new Blob(['PNG'], { type: 'image/png' });
  await wrapper.setProps({ png, imageStatus: 'retained' });
  expect(wrapper.find('[data-testid="benchmark-result-image-unavailable"]').exists()).toBe(false);
  expect(wrapper.get('img').attributes('src')).toBe('blob:benchmark-1');
  expect(URL.createObjectURL).toHaveBeenCalledWith(png);
});
