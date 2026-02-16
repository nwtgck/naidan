import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ImageConjuringLoader from './ImageConjuringLoader.vue';

describe('ImageConjuringLoader', () => {
  it('renders correctly', () => {
    const wrapper = mount(ImageConjuringLoader);
    expect(wrapper.find('[data-testid="image-conjuring-loader"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('Generating');
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
    expect(wrapper.find('[data-testid="image-count-label"]').text()).toBe('Image 3 / 3');
  });

  it('renders step progress when currentStep and totalSteps are provided', () => {
    const wrapper = mount(ImageConjuringLoader, {
      props: {
        currentStep: 5,
        totalSteps: 20
      }
    });
    expect(wrapper.find('[data-testid="step-display"]').text()).toContain('5/ 20');
    expect(wrapper.find('[data-testid="step-display"]').text()).toContain('steps');
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
    expect(wrapper.find('[data-testid="image-count-label"]').text()).toBe('Image 2 / 3');
    expect(wrapper.find('[data-testid="step-display"]').text()).toContain('10/ 50');
    expect(wrapper.find('[data-testid="step-display"]').text()).toContain('steps');
  });

  it('keys the progress bar by currentNumber to prevent backward animation', async () => {
    const wrapper = mount(ImageConjuringLoader, {
      props: {
        remainingCount: 3,
        totalCount: 3,
        currentStep: 10,
        totalSteps: 50
      }
    });

    // currentNumber = 3 - 3 + 1 = 1
    const progressBar1 = wrapper.find('[data-testid="step-progress-bar"]');
    // In Vue Test Utils, we can access the vnode through the wrapper's element or vm
    // @ts-expect-error - accessing internal vnode for testing purposes
    const key1 = progressBar1.element.__vnode.key;
    expect(key1).toBe(1);

    await wrapper.setProps({ remainingCount: 2 });
    // currentNumber = 3 - 2 + 1 = 2
    const progressBar2 = wrapper.find('[data-testid="step-progress-bar"]');
    // @ts-expect-error - accessing internal vnode for testing purposes
    const key2 = progressBar2.element.__vnode.key;
    expect(key2).toBe(2);
    expect(key1).not.toBe(key2);
  });
});
