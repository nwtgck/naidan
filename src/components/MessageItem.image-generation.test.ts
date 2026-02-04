import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import MessageItem from './MessageItem.vue';
import { SENTINEL_IMAGE_PENDING, SENTINEL_IMAGE_PROCESSED } from '../utils/image-generation';

// Mock speech service
vi.mock('../services/web-speech', () => ({
  webSpeechService: {
    state: { status: 'inactive' },
    isSupported: vi.fn().mockReturnValue(true),
    speak: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn()
  }
}));

describe('MessageItem Image Generation', () => {
  const createMessage = (content: string) => ({
    id: '1',
    role: 'assistant' as const,
    content,
    timestamp: Date.now(),
    replies: { items: [] }
  });

  it('shows ImageConjuringLoader when generation is pending', () => {
    const message = createMessage(SENTINEL_IMAGE_PENDING);
    const wrapper = mount(MessageItem, {
      props: { message, isCurrentChatStreaming: false }
    });
    
    expect(wrapper.findComponent({ name: 'ImageConjuringLoader' }).exists()).toBe(true);
    expect(wrapper.find('[data-testid="loading-indicator"]').exists()).toBe(false);
  });

  it('renders image when generation is processed', () => {
    const imageUrl = 'blob:test';
    const content = `${SENTINEL_IMAGE_PROCESSED}<img src="${imageUrl}" alt="generated image">`;
    const message = createMessage(content);
    
    const wrapper = mount(MessageItem, {
      props: { message, isCurrentChatStreaming: false }
    });
    
    const img = wrapper.find('img');
    expect(img.exists()).toBe(true);
    expect(img.attributes('src')).toBe(imageUrl);
    // Sentinel should be stripped and not visible in text
    expect(wrapper.text()).not.toContain('naidan_experimental');
  });

  it('hides speech controls for pending image generation', () => {
    const message = createMessage(SENTINEL_IMAGE_PENDING);
    const wrapper = mount(MessageItem, {
      props: { message, isCurrentChatStreaming: false }
    });
    
    // SpeechControl should be hidden or not rendered
    expect(wrapper.findComponent({ name: 'SpeechControl' }).exists()).toBe(false);
  });

  it('uses specific speech text for processed images', () => {
    const content = `${SENTINEL_IMAGE_PROCESSED}<img src="blob:test">`;
    const message = createMessage(content);
    const wrapper = mount(MessageItem, {
      props: { message, isCurrentChatStreaming: false }
    });
    
    const speechControl = wrapper.findComponent({ name: 'SpeechControl' });
    expect(speechControl.exists()).toBe(true);
    expect(speechControl.props('content')).toBe('Image generated.');
  });
});
