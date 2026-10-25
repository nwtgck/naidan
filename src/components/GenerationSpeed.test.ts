import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
import type { GenerationMetricsPresentation } from '@/01-models/generation-metrics';
import { createTokenMetrics } from '@/logic/generation-metrics/measurement';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import GenerationSpeed from './GenerationSpeed.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

function presentation({ live = false, updatedAt = 0, runId = 1 }: { live?: boolean, updatedAt?: number, runId?: number } = {}): GenerationMetricsPresentation {
  const metrics = createTokenMetrics({ measurement: 'ollama_eval', nInputTokens: 512, nOutputTokens: 100, nMeasuredTokens: 100, durationMs: 2500 })!;
  return { runId, metrics, live, updatedAt, scope: live ? 'current' : 'last', calls: [{ metrics }] };
}

function mounted({ value = presentation() }: { value?: GenerationMetricsPresentation } = {}) {
  const wrapper = mount(GenerationSpeed, { props: { presentation: value }, attachTo: document.body });
  return {
    wrapper,
    [Symbol.dispose](): void {
      wrapper.unmount();
      wrapper.element.remove();
    },
  };
}

function fakeTimers() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  return {
    [Symbol.dispose](): void {
      vi.useRealTimers();
    },
  };
}

describe('subtle generation speed details', () => {
  it('uses the speed itself as the accessible trigger and supports Escape focus return', async () => {
    using view = mounted();
    const trigger = view.wrapper.get('[data-testid="generation-speed-trigger"]');
    expect(trigger.text()).toBe('40 tok/s');
    expect(trigger.attributes('aria-label')).toContain('40 tok/s');
    expect(trigger.attributes('aria-expanded')).toBe('false');
    await trigger.trigger('click');
    await flushPromises();
    const panel = document.querySelector('[data-testid="generation-speed-details"]');
    expect(panel?.getAttribute('role')).toBe('dialog');
    expect(panel?.textContent).toContain('512');
    expect(panel?.textContent).toContain('100');
    expect(document.activeElement).toBe(panel);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    expect(view.wrapper.get('button').attributes('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger.element);
  });

  it('keeps an open detail panel while live values update, then removes provisional labeling at completion', async () => {
    using clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    using view = mounted({ value: presentation({ live: true }) });
    await view.wrapper.get('button').trigger('click');
    expect(view.wrapper.get('button').text()).toContain('≈');
    await view.wrapper.setProps({ presentation: presentation({ live: true, updatedAt: 1000 }) });
    expect(view.wrapper.get('button').attributes('aria-expanded')).toBe('true');
    await view.wrapper.setProps({ presentation: presentation({ live: false, updatedAt: 1100 }) });
    expect(view.wrapper.get('button').text()).toBe('40 tok/s');
    expect(view.wrapper.get('button').attributes('aria-expanded')).toBe('true');
    void clock;
  });

  it('expires stalled live telemetry, closes its panel and revives on a new sample', async () => {
    using timers = fakeTimers();
    let now = 0;
    using clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    using view = mounted({ value: presentation({ live: true }) });
    await view.wrapper.get('button').trigger('click');
    now = 5000;
    await vi.advanceTimersByTimeAsync(5000);
    expect(view.wrapper.find('button').exists()).toBe(false);
    expect(document.querySelector('[data-testid="generation-speed-details"]')).toBeNull();
    await view.wrapper.setProps({ presentation: presentation({ live: true, updatedAt: now }) });
    expect(view.wrapper.get('button').attributes('aria-expanded')).toBe('false');
    void clock;
    void timers;
  });

  it('does not reschedule its timer on unrelated text-render updates and cleans it on unmount', async () => {
    using timers = fakeTimers();
    using clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    using view = mounted({ value: presentation({ live: true }) });
    using schedule = vi.spyOn(globalThis, 'setTimeout');
    await view.wrapper.setProps({ presentation: { ...presentation({ live: true }) } });
    expect(schedule).not.toHaveBeenCalled();
    view.wrapper.unmount();
    expect(vi.getTimerCount()).toBe(0);
    void clock;
    void timers;
  });

  it('keeps complete metrics visible indefinitely and closes details for a replacement run', async () => {
    using timers = fakeTimers();
    using view = mounted();
    await view.wrapper.get('button').trigger('click');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(view.wrapper.find('button').exists()).toBe(true);
    await view.wrapper.setProps({ presentation: presentation({ runId: 2 }) });
    expect(view.wrapper.get('button').attributes('aria-expanded')).toBe('false');
    void timers;
  });
});
