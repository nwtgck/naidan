import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import Logo from './Logo.vue';

describe('Logo', () => {
  it('renders with default size', () => {
    const wrapper = mount(Logo);
    const logoDiv = wrapper.find('[role="img"]');
    expect((logoDiv.element as HTMLElement).style.width).toBe('32px');
    expect((logoDiv.element as HTMLElement).style.height).toBe('32px');
  });

  it('renders with custom size', () => {
    const wrapper = mount(Logo, {
      props: {
        size: 48,
      },
    });
    const logoDiv = wrapper.find('[role="img"]');
    expect((logoDiv.element as HTMLElement).style.width).toBe('48px');
    expect((logoDiv.element as HTMLElement).style.height).toBe('48px');
  });

  it('applies custom className', () => {
    const wrapper = mount(Logo, {
      props: {
        className: 'custom-class',
      },
    });
    // The className is applied to the logoDiv in the new implementation
    const logoDiv = wrapper.find('[role="img"]');
    expect(logoDiv.classes()).toContain('custom-class');
  });
});
