import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DOMWrapper, mount, flushPromises } from '@vue/test-utils';
import { nextTick, ref } from 'vue';
import type { GenerationMetricsPresentation } from '@/01-models/generation-metrics';
import { createTokenMetrics } from '@/logic/generation-metrics/measurement';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import GenerationSpeed from './GenerationSpeed.vue';

const status = ref<'enabled' | 'disabled'>('enabled');
const inlineStats = ref<'on_demand' | 'always'>('on_demand');
const saving = ref(false);
const update = vi.fn(async ({ patch }: { patch: { status?: 'enabled' | 'disabled', inlineStats?: 'on_demand' | 'always' } }) => {
  if (patch.status !== undefined) {
    status.value = patch.status;
  }
  if (patch.inlineStats !== undefined) {
    inlineStats.value = patch.inlineStats;
  }
});
vi.mock('@/composables/useGenerationSpeedSettings', () => ({ useGenerationSpeedSettings: () => ({ status, inlineStats, saving, update }) }));

beforeEach(async () => {
  status.value = 'enabled';
  inlineStats.value = 'on_demand';
  saving.value = false;
  update.mockClear();
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
  it('expands inline statistics before opening details and returns focus to the details trigger', async () => {
    using view = mounted();
    const trigger = view.wrapper.get('[data-testid="generation-speed-trigger"]');
    expect(trigger.text()).toBe('40 tok/s');
    expect(trigger.attributes('aria-label')).toContain('40 tok/s');
    expect(trigger.attributes('aria-expanded')).toBe('false');
    await trigger.trigger('click');
    await flushPromises();
    expect(view.wrapper.get('[data-testid="generation-speed-inline-stats"]').text()).toContain('Output 100 tok');
    expect(view.wrapper.get('[data-testid="generation-speed-inline-stats"]').text()).toContain('Measured 2.5 s');
    expect(document.querySelector('[data-testid="generation-speed-details"]')).toBeNull();
    const detailsTrigger = view.wrapper.get('[data-testid="generation-speed-details-trigger"]');
    await detailsTrigger.trigger('click');
    await flushPromises();
    const panel = document.querySelector('[data-testid="generation-speed-details"]');
    expect(panel?.getAttribute('role')).toBe('dialog');
    expect(panel?.textContent).toContain('512');
    expect(panel?.textContent).toContain('100');
    expect(document.activeElement).toBe(panel);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    expect(detailsTrigger.attributes('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(detailsTrigger.element);
    await trigger.trigger('click');
    expect(view.wrapper.find('[data-testid="generation-speed-inline-stats"]').exists()).toBe(false);
  });

  it('keeps details open and the speed unprefixed while live values update and complete', async () => {
    using clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    using view = mounted({ value: presentation({ live: true }) });
    await view.wrapper.get('button').trigger('click');
    await view.wrapper.get('[data-testid="generation-speed-details-trigger"]').trigger('click');
    expect(view.wrapper.get('[data-testid="generation-speed-trigger"]').text()).toBe('40 tok/s');
    await view.wrapper.setProps({ presentation: presentation({ live: true, updatedAt: 1000 }) });
    expect(view.wrapper.get('button').attributes('aria-expanded')).toBe('true');
    expect(document.querySelector('[data-testid="generation-speed-details"]')).not.toBeNull();
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
    await view.wrapper.get('[data-testid="generation-speed-details-trigger"]').trigger('click');
    now = 5000;
    await vi.advanceTimersByTimeAsync(5000);
    expect(view.wrapper.find('button').exists()).toBe(false);
    expect(document.querySelector('[data-testid="generation-speed-details"]')).toBeNull();
    await view.wrapper.setProps({ presentation: presentation({ live: true, updatedAt: now }) });
    expect(view.wrapper.get('[data-testid="generation-speed-details-trigger"]').attributes('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-testid="generation-speed-details"]')).toBeNull();
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
    await view.wrapper.get('[data-testid="generation-speed-details-trigger"]').trigger('click');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(view.wrapper.find('button').exists()).toBe(true);
    await view.wrapper.setProps({ presentation: presentation({ runId: 2 }) });
    expect(view.wrapper.get('button').attributes('aria-expanded')).toBe('false');
    void timers;
  });

  it('shows persistent inline statistics and returns focus to the primary trigger when it opens details', async () => {
    inlineStats.value = 'always';
    using view = mounted();
    expect(view.wrapper.get('[data-testid="generation-speed-inline-stats"]').text()).toContain('100');
    const trigger = view.wrapper.get('[data-testid="generation-speed-trigger"]');
    await trigger.trigger('click');
    await flushPromises();
    expect(document.querySelector('[data-testid="generation-speed-details"]')).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    expect(document.activeElement).toBe(trigger.element);
    expect(view.wrapper.find('[data-testid="generation-speed-inline-stats"]').exists()).toBe(true);
  });

  it('closes persistent-mode details when the primary trigger is clicked again', async () => {
    inlineStats.value = 'always';
    using view = mounted();
    const trigger = view.wrapper.get('[data-testid="generation-speed-trigger"]');
    await trigger.trigger('pointerdown');
    await trigger.trigger('click');
    await flushPromises();
    expect(document.querySelector('[data-testid="generation-speed-details"]')).not.toBeNull();
    // Separate user clicks run in separate tasks, beyond VueUse's same-task guard.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    await trigger.trigger('pointerdown');
    await trigger.trigger('click');
    await flushPromises();
    expect(document.querySelector('[data-testid="generation-speed-details"]')).toBeNull();
    expect(trigger.attributes('aria-expanded')).toBe('false');
  });

  it('keeps the details anchor while switching persistent inline statistics off', async () => {
    inlineStats.value = 'always';
    using view = mounted();
    await view.wrapper.get('[data-testid="generation-speed-details-trigger"]').trigger('click');
    await flushPromises();
    const input = document.querySelector('[data-testid="generation-speed-always-show-toggle"]');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('Missing inline preference switch');
    }
    await new DOMWrapper(input).setValue(false);
    await flushPromises();
    expect(update).toHaveBeenCalledWith({ patch: { inlineStats: 'on_demand' } });
    expect(view.wrapper.find('[data-testid="generation-speed-details-trigger"]').exists()).toBe(true);
    expect(document.querySelector('[data-testid="generation-speed-details"]')).not.toBeNull();
  });

  it('hides all speed UI and restores the same measurement when enabled from settings', async () => {
    using view = mounted();
    await view.wrapper.get('[data-testid="generation-speed-trigger"]').trigger('click');
    await view.wrapper.get('[data-testid="generation-speed-details-trigger"]').trigger('click');
    await flushPromises();
    const input = document.querySelector('[data-testid="generation-speed-visible-toggle"]');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('Missing visibility switch');
    }
    await new DOMWrapper(input).setValue(false);
    await flushPromises();
    expect(view.wrapper.find('[data-testid="generation-speed"]').exists()).toBe(false);
    expect(document.querySelector('[data-testid="generation-speed-details"]')).toBeNull();
    status.value = 'enabled';
    await nextTick();
    expect(view.wrapper.get('[data-testid="generation-speed-trigger"]').text()).toBe('40 tok/s');
  });

  it('does not invent output tokens for character-based measurements', async () => {
    const value = presentation();
    value.metrics = { speed: { unit: 'characters', measurement: 'received_text', perSecond: 40, interval: { nUnits: 100, durationMs: 2500 } } };
    using view = mounted({ value });
    await view.wrapper.get('[data-testid="generation-speed-trigger"]').trigger('click');
    expect(view.wrapper.get('[data-testid="generation-speed-inline-stats"]').text()).toContain('Output — tok');
    expect(view.wrapper.get('[data-testid="generation-speed-trigger"]').text()).toBe('40 chars/s');
  });
});
