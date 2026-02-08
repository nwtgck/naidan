import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import MessageItem from './MessageItem.vue';
import { SENTINEL_IMAGE_PENDING, SENTINEL_IMAGE_RESPONSE_PREFIX } from '../utils/image-generation';

describe('MessageItem Image Generation Progress', () => {
  const createMessage = (content: string) => ({
    id: '1',
    role: 'assistant' as const,
    content,
    timestamp: Date.now(),
    replies: { items: [] }
  });

  it('shows progress when response marker is present in assistant message', () => {
    const responseMarker = `${SENTINEL_IMAGE_RESPONSE_PREFIX} {"count":3} -->`;
    const content = responseMarker + SENTINEL_IMAGE_PENDING;
    const message = createMessage(content);
    
    const wrapper = mount(MessageItem, {
      props: { message, isCurrentChatStreaming: false }
    });
    
    const loader = wrapper.findComponent({ name: 'ImageConjuringLoader' });
    expect(loader.exists()).toBe(true);
    
    expect(loader.props('totalCount')).toBe(3);
    expect(loader.props('remainingCount')).toBe(3);
    expect(loader.text()).toContain('Generating images (1 / 3)');
  });

  it('shows incremented progress after some images are generated (local mode)', () => {
    const responseMarker = `${SENTINEL_IMAGE_RESPONSE_PREFIX} {"count":3} -->`;
    // Simulate one image already generated (local mode uses <img> tags)
    const content = responseMarker + SENTINEL_IMAGE_PENDING + '\n\n<img src="blob:1">';
    const message = createMessage(content);
    
    const wrapper = mount(MessageItem, {
      props: { message, isCurrentChatStreaming: false }
    });
    
    const loader = wrapper.findComponent({ name: 'ImageConjuringLoader' });
    expect(loader.props('totalCount')).toBe(3);
    expect(loader.props('remainingCount')).toBe(2); // 3 - 1 = 2 remaining
    expect(loader.text()).toContain('Generating images (2 / 3)');
  });

  it('shows incremented progress after some images are generated (OPFS mode)', () => {
    const responseMarker = `${SENTINEL_IMAGE_RESPONSE_PREFIX} {"count":4} -->`;
    // Simulate two images already generated (OPFS mode uses markdown code blocks)
    const block = '```naidan_experimental_image\n{"binaryObjectId":"4dbb8a9f-d41f-4d18-b145-73ffcbf1661a", "displayWidth": 100, "displayHeight": 100, "prompt": "test"}\n```';
    const content = responseMarker + SENTINEL_IMAGE_PENDING + '\n\n' + block + '\n\n' + block;
    const message = createMessage(content);
    
    const wrapper = mount(MessageItem, {
      props: { message, isCurrentChatStreaming: false }
    });
    
    const loader = wrapper.findComponent({ name: 'ImageConjuringLoader' });
    expect(loader.props('totalCount')).toBe(4);
    expect(loader.props('remainingCount')).toBe(2); // 4 - 2 = 2 remaining
    expect(loader.text()).toContain('Generating images (3 / 4)');
  });
});
