import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import Logo from './Logo.vue';

describe('Logo', () => {
  it('renders with default size', () => {
    const wrapper = mount(Logo);
    const logoImg = wrapper.find('img');
    expect((logoImg.element as HTMLElement).style.width).toBe('32px');
    expect((logoImg.element as HTMLElement).style.height).toBe('32px');
  });

  it('renders with custom size', () => {
    const wrapper = mount(Logo, {
      props: {
        size: 48,
      },
    });
    const logoImg = wrapper.find('img');
    expect((logoImg.element as HTMLElement).style.width).toBe('48px');
    expect((logoImg.element as HTMLElement).style.height).toBe('48px');
  });

  it('applies custom className', () => {
    const wrapper = mount(Logo, {
      props: {
        className: 'custom-class',
      },
    });
    const logoImg = wrapper.find('img');
    expect(logoImg.classes()).toContain('custom-class');
  });

  describe('file:// protocol compatibility (Regression Tests)', () => {
    it('uses a standard img tag instead of mask-image to ensure correct rendering of internal SVG gradients', () => {
      const wrapper = mount(Logo);
      const logoImg = wrapper.find('img');
      expect(logoImg.exists()).toBe(true);
      
      // Ensure we are NOT using the old div-mask approach
      const logoDiv = wrapper.find('div.logo-gradient');
      expect(logoDiv.exists()).toBe(false);
    });

    it('has a valid src attribute pointing to the logo asset', () => {
      const wrapper = mount(Logo);
      const logoImg = wrapper.find('img');
      const src = logoImg.attributes('src');
      expect(src).toBeDefined();
      expect(src?.length).toBeGreaterThan(0);
      
      // In a production build, this would be a data: URL or a relative path.
      // In tests, it depends on the mock, but the existence of the attribute is key.
    });

    it('sets height and width on the img element explicitly to prevent layout shift', () => {
      const wrapper = mount(Logo, { props: { size: 64 } });
      const logoImg = wrapper.find('img');
      expect(logoImg.attributes('width')).toBe('64');
      expect(logoImg.attributes('height')).toBe('64');
    });
  });
});
