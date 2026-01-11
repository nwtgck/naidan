import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import Logo from './Logo.vue';

describe('Logo', () => {
  it('renders with default size', () => {
    const wrapper = mount(Logo);
    const svg = wrapper.find('svg');
    expect(svg.attributes('width')).toBe('32');
    expect(svg.attributes('height')).toBe('32');
  });

  it('renders with custom size', () => {
    const wrapper = mount(Logo, {
      props: {
        size: 48,
      },
    });
    const svg = wrapper.find('svg');
    expect(svg.attributes('width')).toBe('48');
    expect(svg.attributes('height')).toBe('48');
  });

  it('applies custom className', () => {
    const wrapper = mount(Logo, {
      props: {
        className: 'custom-class',
      },
    });
    expect(wrapper.classes()).toContain('custom-class');
  });
});
