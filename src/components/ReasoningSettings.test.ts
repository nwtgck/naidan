import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { mount } from '@vue/test-utils';
import ReasoningSettings from './ReasoningSettings.vue';
import { nextTick } from 'vue';
import type { Reasoning } from '@/01-models/types';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

describe('ReasoningSettings Component', () => {
  const getWrapper = async (selectedEffort: Reasoning['effort'] = undefined) => {
    const wrapper = mount(ReasoningSettings, {
      props: { selectedEffort },
    });
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="reasoning-effort-default"]').exists()).toBe(true);
    });
    return wrapper;
  };

  it('renders all effort options with segmented control style', async () => {
    const wrapper = await getWrapper();
    // Labels are: Default, Off, Low, Medium, High -> toLowerCase()
    const options = ['default', 'off', 'low', 'medium', 'high'];

    options.forEach(opt => {
      expect(wrapper.find(`[data-testid="reasoning-effort-${opt}"]`).exists()).toBe(true);
    });
  });

  it('emits update:effort when a button is clicked', async () => {
    const wrapper = await getWrapper();

    await wrapper.find('[data-testid="reasoning-effort-high"]').trigger('click');
    expect(wrapper.emitted('update:effort')).toEqual([['high']]);

    await wrapper.find('[data-testid="reasoning-effort-off"]').trigger('click');
    expect(wrapper.emitted('update:effort')).toContainEqual(['none']);
  });

  it('highlights the correctly selected effort button', async () => {
    const wrapper = await getWrapper('medium');

    const medBtn = wrapper.find('[data-testid="reasoning-effort-medium"]');
    expect(medBtn.classes()).toContain('text-blue-600');
    expect(medBtn.classes()).toContain('font-bold');

    const highBtn = wrapper.find('[data-testid="reasoning-effort-high"]');
    expect(highBtn.classes()).not.toContain('text-blue-600');
  });

  it('applies flex-[1.4] to the Default button for better readability', async () => {
    const wrapper = await getWrapper();
    const defaultBtn = wrapper.find('[data-testid="reasoning-effort-default"]');
    expect(defaultBtn.classes()).toContain('flex-[1.4]');

    const lowBtn = wrapper.find('[data-testid="reasoning-effort-low"]');
    expect(lowBtn.classes()).toContain('flex-1');
    expect(lowBtn.classes()).not.toContain('flex-[1.4]');
  });


  it('renders and emits leading source options without emitting an effort', async () => {
    const wrapper = mount(ReasoningSettings, {
      props: {
        selectedEffort: undefined,
        selectedValue: 'inherit',
        leadingOptions: [
          {
            value: 'inherit',
            label: 'Global: Default',
            shortLabel: 'Global: Default',
            testId: 'inherit',
          },
        ],
      },
    });

    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="reasoning-effort-inherit"]').exists()).toBe(true);
    });

    const inheritButton = wrapper.find('[data-testid="reasoning-effort-inherit"]');
    expect(inheritButton.classes()).toContain('text-blue-600');

    await inheritButton.trigger('click');

    expect(wrapper.emitted('update:value')).toEqual([['inherit']]);
    expect(wrapper.emitted('update:effort')).toBeUndefined();
  });

  it('initializes slider position on mount', async () => {
    const wrapper = await getWrapper('high');
    await nextTick();

    // Use a simpler class search for the slider background
    const slider = wrapper.find('.absolute.bottom-0\\.5');
    expect(slider.exists()).toBe(true);
    expect(slider.attributes('style')).toContain('opacity: 1');
  });
});
