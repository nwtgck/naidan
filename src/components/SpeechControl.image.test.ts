import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import SpeechControl from './SpeechControl.vue';
import { SENTINEL_IMAGE_PENDING, SENTINEL_IMAGE_PROCESSED } from '../utils/image-generation';

// Mock speech service
vi.mock('../services/web-speech', () => ({
  webSpeechService: {
    state: { status: 'inactive' },
    isSupported: vi.fn().mockReturnValue(true)
  }
}));

describe('SpeechControl with Image Generation', () => {
  it('is hidden when content is image pending sentinel', () => {
    const wrapper = mount(SpeechControl, {
      props: { messageId: '1', content: SENTINEL_IMAGE_PENDING }
    });
    expect(wrapper.find('button').exists()).toBe(false);
  });

  it('is hidden when content is image processed sentinel', () => {
    const wrapper = mount(SpeechControl, {
      props: { messageId: '1', content: SENTINEL_IMAGE_PROCESSED + '<img>' }
    });
    expect(wrapper.find('button').exists()).toBe(false);
  });

  it('is visible for regular content', () => {
    const wrapper = mount(SpeechControl, {
      props: { messageId: '1', content: 'Hello' }
    });
    expect(wrapper.find('button').exists()).toBe(true);
  });
});
