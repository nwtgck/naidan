import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import ImageGenerationProgress from './ImageGenerationProgress.vue';

let wrapper: VueWrapper | undefined;
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
});
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined; vi.useRealTimers();
});
function openProgress() {
  wrapper = mount(ImageGenerationProgress, { props: { busy: true, supported: true, active: true, stopping: false, progress: undefined, width: 512, height: 512, image: undefined } });
  return wrapper;
}

it('keeps progress values based on observed completed steps and loading progress', async () => {
  const view = openProgress();
  expect(view.get('[data-testid="image-generation-heading"]').text()).toBe('Waiting');
  expect(view.get('[role="progressbar"]').attributes('aria-valuenow')).toBeUndefined();
  for (const [phase, label] of [
    ['runtime', 'Loading runtime…'], ['model', 'Loading model…'], ['encoding', 'Encoding image…'],
    ['sampling', 'Generating image…'], ['decoding', 'Decoding image…'],
  ] as const) {
    await view.setProps({ progress: { phase, step: 0, steps: 0 } });
    expect(view.get('[data-testid="image-generation-heading"]').text()).toBe(label);
    expect(view.get('[data-testid="image-generation-phase"]').text()).toBe(label);
    expect(view.get('[role="progressbar"]').attributes('aria-label')).toBe(label);
    expect(view.get('[role="progressbar"]').attributes('aria-valuenow')).toBeUndefined();
  }
  await view.setProps({ progress: { phase: 'sampling', step: 0, steps: 20 } });
  expect(view.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('0');
  await view.setProps({ progress: { phase: 'sampling', step: 7, steps: 20 } });
  expect(view.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('7');
  await view.setProps({ progress: { phase: 'model', step: 31, steps: 90 } });
  expect(view.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('34');
  expect(view.get('[role="progressbar"]').attributes('aria-valuemax')).toBe('100');
  expect(view.find('[data-testid="image-generation-indeterminate"]').exists()).toBe(false);
  expect(view.get('[data-testid="image-generation-units"]').text()).not.toContain('Steps');
  expect(view.get('[data-testid="image-generation-units"]').text()).toBe('34%');
  expect(view.get('[data-testid="image-generation-heading"]').text()).toBe('Loading model…');
  await view.setProps({ progress: { phase: 'model', step: 0, steps: 0 } });
  expect(view.get('[data-testid="image-generation-indeterminate"]').attributes('aria-label')).toBe(view.get('[data-testid="image-generation-phase"]').text());
  expect(view.get('[role="progressbar"]').attributes('aria-valuenow')).toBeUndefined();
  expect(view.get('[role="progressbar"]').attributes('aria-valuemax')).toBeUndefined();
  expect(view.find('[data-testid="image-generation-units"]').exists()).toBe(false);
  await view.setProps({ progress: { phase: 'encoding', step: 0, steps: 0 } });
  expect(view.get('[role="progressbar"]').attributes('aria-valuenow')).toBeUndefined();
});

it('distinguishes the inferred active step from completed progress, including the final step and cancellation', async () => {
  const view = openProgress();
  for (const [completed, displayed, label] of [
    [0, 1, 'Processing step 1 / 8'],
    [1, 2, 'Processing step 2 / 8'],
    [7, 8, 'Processing step 8 / 8'],
    [8, 8, '8 / 8 steps completed'],
  ] as const) {
    await view.setProps({ progress: { phase: 'sampling', step: completed, steps: 8 } });
    expect(view.get('[data-testid="image-generation-heading"]').text()).toBe(label);
    expect(view.get('[data-testid="image-generation-phase"]').text()).toBe(label);
    expect(view.get('[data-testid="image-generation-units"]').text()).toBe(`${displayed}/ 8`);
    const bar = view.get('[role="progressbar"]');
    expect(bar.attributes('aria-valuenow')).toBe(String(completed));
    expect(bar.attributes('aria-valuemax')).toBe('8');
    expect(bar.attributes('aria-label')).toBe(`${completed} / 8 steps completed`);
    expect(bar.element.firstElementChild?.getAttribute('style')).toContain(`width: ${completed / 8 * 100}%`);
  }
  await view.setProps({ progress: { phase: 'sampling', step: 0, steps: 1 } });
  expect(view.get('[data-testid="image-generation-heading"]').text()).toBe('Processing step 1 / 1');
  await view.setProps({ progress: { phase: 'sampling', step: 1, steps: 1 } });
  expect(view.get('[data-testid="image-generation-heading"]').text()).toBe('1 / 1 step completed');
  await view.setProps({ progress: { phase: 'sampling', step: 3, steps: 8 }, image: { url: 'blob:live', width: 32, height: 16 } });
  expect(view.get('[data-testid="image-generation-phase"]').text()).toBe('Processing step 4 / 8');
  expect(view.get('[data-testid="image-generation-current-preview"]').attributes('width')).toBe('32');
  expect(view.get('[data-testid="image-generation-current-preview"]').attributes('height')).toBe('16');
  expect(view.get('[data-testid="image-generation-current-preview"]').attributes('style')).toContain('max-width: min(100%, 32px)');
  await view.setProps({ active: false });
  expect(view.get('[data-testid="image-generation-phase"]').text()).toBe('Processing step 4 / 8');
  await view.setProps({ stopping: true, image: undefined });
  expect(view.get('[data-testid="image-generation-phase"]').text()).toContain('3 / 8 steps completed');
  expect(view.text()).not.toContain('Processing step');
  expect(view.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('3');
  await view.setProps({ stopping: false, progress: { phase: 'decoding', step: 0, steps: 0 } });
  expect(view.text()).not.toContain('Processing step');
  expect(view.get('[data-testid="image-generation-heading"]').text()).toBe('Decoding image…');
});

it('keeps the animation canvas large while a small preview stays at native size inside it', async () => {
  const view = openProgress();
  await view.setProps({ width: 256, height: 256, progress: { phase: 'model', step: 0, steps: 0 } });
  const canvas = view.get('[data-testid="image-generation-canvas"]');
  expect(canvas.attributes('style')).toContain('max-width: 65vh');
  expect(view.get('[data-testid="image-generation-heading"]').text()).toBe('Loading model…');

  await view.setProps({ image: { url: 'blob:preview', width: 32, height: 32 } });
  expect(canvas.attributes('style')).toContain('max-width: 65vh');
  const image = view.get('[data-testid="image-generation-current-preview"]');
  expect(image.attributes('width')).toBe('32');
  expect(image.attributes('height')).toBe('32');
  expect(image.attributes('style')).toContain('max-width: min(100%, 32px)');
});

it('suspends hidden work while retaining the run clock, and resets the next run', async () => {
  const view = openProgress();
  await vi.advanceTimersByTimeAsync(3000);
  expect(view.get('[data-testid="image-generation-elapsed"]').text()).toContain('3 s');
  await view.setProps({ active: false });
  expect(vi.getTimerCount()).toBe(0);
  expect(view.get('[data-testid="image-generation-progress"]').attributes('data-running')).toBe('false');
  await vi.advanceTimersByTimeAsync(5000);
  await view.setProps({ active: true });
  expect(view.get('[data-testid="image-generation-elapsed"]').text()).toContain('8 s');
  await view.setProps({ busy: false });
  expect(vi.getTimerCount()).toBe(0);
  expect(view.find('[data-testid="image-generation-progress"]').exists()).toBe(false);
  await view.setProps({ busy: true });
  expect(view.get('[data-testid="image-generation-elapsed"]').text()).toContain('0 s');
  view.unmount(); wrapper = undefined;
  expect(vi.getTimerCount()).toBe(0);
});

it('stops animation and timers during cancellation and does no work when unsupported', async () => {
  const view = openProgress();
  await vi.advanceTimersByTimeAsync(2000);
  await view.setProps({ stopping: true });
  expect(vi.getTimerCount()).toBe(0);
  expect(view.get('[data-testid="image-generation-progress"]').attributes('data-running')).toBe('false');
  expect(view.get('[data-testid="image-generation-phase"]').text()).toContain('Stopping');
  expect(view.get('[data-testid="image-generation-heading"]').text()).toBe(view.get('[data-testid="image-generation-phase"]').text());
  await view.setProps({ busy: false, stopping: false });
  expect(vi.getTimerCount()).toBe(0);
  await view.setProps({ busy: true, supported: false });
  expect(vi.getTimerCount()).toBe(0);
  expect(view.find('[data-testid="image-generation-progress"]').exists()).toBe(false);
});

it('uses a non-animated compact tree and preserves elapsed time across remounts', async () => {
  const view = openProgress(); await view.setProps({ presentation: 'compact-progress', startedAt: 0 });
  expect(view.find('[data-testid="image-generation-compact-progress"]').exists()).toBe(true);
  expect(view.find('[data-testid="image-generation-indeterminate"]').exists()).toBe(false);
  expect(view.find('[data-testid="image-generation-current-preview"]').exists()).toBe(false);
  vi.advanceTimersByTime(6000); await view.vm.$nextTick(); expect(view.text()).toContain('6 s');
  view.unmount(); wrapper = undefined;
  const next = openProgress(); await next.setProps({ presentation: 'compact-progress', startedAt: 0 });
  vi.advanceTimersByTime(1000); await next.vm.$nextTick(); expect(next.text()).toContain('7 s');
  await next.setProps({ busy: false }); expect(next.find('[data-testid="image-generation-compact-progress"]').exists()).toBe(false);
});
