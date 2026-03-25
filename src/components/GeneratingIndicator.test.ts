import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import GeneratingIndicator from './GeneratingIndicator.vue';

describe('GeneratingIndicator', () => {
  it('renders with the correct testid', () => {
    const wrapper = mount(GeneratingIndicator);
    expect(wrapper.find('[data-testid="generating-indicator"]').exists()).toBe(true);
  });

  it('renders exactly 4 particles', () => {
    const wrapper = mount(GeneratingIndicator);
    const particles = wrapper.findAll('.gi-p');
    expect(particles).toHaveLength(4);
  });

  it('is aria-hidden for accessibility', () => {
    const wrapper = mount(GeneratingIndicator);
    const indicator = wrapper.find('[data-testid="generating-indicator"]');
    expect(indicator.attributes('aria-hidden')).toBe('true');
  });

  it('renders as an inline-block element via class', () => {
    const wrapper = mount(GeneratingIndicator);
    // The outer span has the .generating-indicator class which sets display: inline-block
    const indicator = wrapper.find('[data-testid="generating-indicator"]');
    expect(indicator.classes()).toContain('generating-indicator');
  });

  it('has each particle with the gi-p class and a directional class', () => {
    const wrapper = mount(GeneratingIndicator);
    expect(wrapper.find('.gi-p1').exists()).toBe(true);
    expect(wrapper.find('.gi-p2').exists()).toBe(true);
    expect(wrapper.find('.gi-p3').exists()).toBe(true);
    expect(wrapper.find('.gi-p4').exists()).toBe(true);
  });
});
