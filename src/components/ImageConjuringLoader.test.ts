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

  it('renders progress with current/total images', () => {
    const wrapper = mount(ImageConjuringLoader, {
      props: {
        remainingCount: 1,
        totalCount: 3
      }
    });
    // currentNumber = totalCount - remainingCount + 1 = 3 - 1 + 1 = 3
    expect(wrapper.text()).toBe('Generating images (3 / 3)');
  });

  it('renders step progress when currentStep and totalSteps are provided', () => {
    const wrapper = mount(ImageConjuringLoader, {
      props: {
        currentStep: 5,
        totalSteps: 20
      }
    });
    expect(wrapper.text()).toContain('[5/20]');
    expect(wrapper.text()).toContain('Generating image...');
  });

  it('combines image count and step progress', () => {
    const wrapper = mount(ImageConjuringLoader, {
      props: {
        remainingCount: 2,
        totalCount: 3,
        currentStep: 10,
        totalSteps: 50
      }
    });
    // currentNumber = 3 - 2 + 1 = 2
    expect(wrapper.text()).toBe('Generating images (2 / 3) [10/50]');
  });
});
