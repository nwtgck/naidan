import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ImageConjuringLoader from './ImageConjuringLoader.vue';

describe('ImageConjuringLoader', () => {
  it('renders correctly', () => {
    const wrapper = mount(ImageConjuringLoader);
    expect(wrapper.find('[data-testid="image-conjuring-loader"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('Generating image...');
  });

  it('contains magic particles', () => {
    const wrapper = mount(ImageConjuringLoader);
    const particles = wrapper.findAll('.magic-particle');
    expect(particles.length).toBeGreaterThan(0);
  });
});
