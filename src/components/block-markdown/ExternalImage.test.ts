import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ExternalImage from './ExternalImage.vue';
import { useExternalResourceSettings } from '@/composables/useExternalResourceSettings';

describe('ExternalImage.vue', () => {
  const { __testOnlyReset } = useExternalResourceSettings();

  beforeEach(() => {
    __testOnlyReset();
  });

  const mountComponent = (props: { src: string; alt?: string; title?: string }) => {
    return mount(ExternalImage, {
      props: {
        src: props.src,
        alt: props.alt,
        title: props.title,
      }
    });
  };

  it('renders a placeholder for external images by default', () => {
    const wrapper = mountComponent({ src: 'https://other.com/img.png', alt: 'My Image' });
    expect(wrapper.find('.naidan-external-image-placeholder').exists()).toBe(true);
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.text()).toContain('My Image');
  });

  it('renders an img tag for internal resources', () => {
    const wrapper = mountComponent({ src: '/local-path.png' });
    expect(wrapper.find('.naidan-external-image-placeholder').exists()).toBe(false);
    expect(wrapper.find('img').exists()).toBe(true);
    expect(wrapper.find('img').attributes('src')).toBe('/local-path.png');
  });

  it('renders an img tag for data URLs', () => {
    const wrapper = mountComponent({ src: 'data:image/png;base64,xxxx' });
    expect(wrapper.find('.naidan-external-image-placeholder').exists()).toBe(false);
    expect(wrapper.find('img').exists()).toBe(true);
  });

  it('loads the image when clicked', async () => {
    const wrapper = mountComponent({ src: 'https://other.com/img.png' });
    await wrapper.find('.flex.items-center').trigger('click');
    expect(wrapper.find('img').exists()).toBe(true);
  });

  it('loads all external images when globe is clicked', async () => {
    const wrapper1 = mountComponent({ src: 'https://other1.com/img.png' });
    const wrapper2 = mountComponent({ src: 'https://other2.com/img.png' });

    expect(wrapper1.find('img').exists()).toBe(false);
    expect(wrapper2.find('img').exists()).toBe(false);

    await wrapper1.find('button[title*="Allow all"]').trigger('click');

    expect(wrapper1.find('img').exists()).toBe(true);
    expect(wrapper2.find('img').exists()).toBe(true);
  });

  it('fails safe: treats invalid URL as external', () => {
    // Using a URL that is definitely invalid for 'new URL()'
    const wrapper = mountComponent({ src: 'http://[' });

    // Check internal state exposed via __testOnly
    const internal = (wrapper.vm as any).__testOnly;
    expect(internal.isExternal.value).toBe(true);
    expect(internal.shouldShow.value).toBe(false);

    expect(wrapper.find('.naidan-external-image-placeholder').exists()).toBe(true);
  });
});
