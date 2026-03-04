import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ReasoningSettings from './ReasoningSettings.vue';
import { nextTick } from 'vue';

describe('ReasoningSettings Component', () => {
  const getWrapper = (selectedEffort: any = undefined) => mount(ReasoningSettings, {
    props: { selectedEffort }
  });

  it('renders all effort options with segmented control style', () => {
    const wrapper = getWrapper();
    // Labels are: Default, Off, Low, Medium, High -> toLowerCase()
    const options = ['default', 'off', 'low', 'medium', 'high'];

    options.forEach(opt => {
      expect(wrapper.find(`[data-testid="reasoning-effort-${opt}"]`).exists()).toBe(true);
    });
  });

  it('emits update:effort when a button is clicked', async () => {
    const wrapper = getWrapper();

    await wrapper.find('[data-testid="reasoning-effort-high"]').trigger('click');
    expect(wrapper.emitted('update:effort')).toEqual([['high']]);

    await wrapper.find('[data-testid="reasoning-effort-off"]').trigger('click');
    expect(wrapper.emitted('update:effort')).toContainEqual(['none']);
  });

  it('highlights the correctly selected effort button', () => {
    const wrapper = getWrapper('medium');

    const medBtn = wrapper.find('[data-testid="reasoning-effort-medium"]');
    expect(medBtn.classes()).toContain('text-blue-600');
    expect(medBtn.classes()).toContain('font-bold');

    const highBtn = wrapper.find('[data-testid="reasoning-effort-high"]');
    expect(highBtn.classes()).not.toContain('text-blue-600');
  });

  it('applies flex-[1.4] to the Default button for better readability', () => {
    const wrapper = getWrapper();
    const defaultBtn = wrapper.find('[data-testid="reasoning-effort-default"]');
    expect(defaultBtn.classes()).toContain('flex-[1.4]');

    const lowBtn = wrapper.find('[data-testid="reasoning-effort-low"]');
    expect(lowBtn.classes()).toContain('flex-1');
    expect(lowBtn.classes()).not.toContain('flex-[1.4]');
  });

  it('initializes slider position on mount', async () => {
    const wrapper = getWrapper('high');
    await nextTick();

    // Use a simpler class search for the slider background
    const slider = wrapper.find('.absolute.bottom-0\\.5');
    expect(slider.exists()).toBe(true);
    expect(slider.attributes('style')).toContain('opacity: 1');
  });
});
