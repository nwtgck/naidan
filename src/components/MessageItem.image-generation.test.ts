import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
import MessageItem from './MessageItem.vue';
import { SENTINEL_IMAGE_PENDING, SENTINEL_IMAGE_PROCESSED, IMAGE_BLOCK_LANG } from '../utils/image-generation';
import { storageService } from '../services/storage';
import { useGlobalEvents } from '../composables/useGlobalEvents';

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

// Mock global events
vi.mock('../composables/useGlobalEvents', () => ({
  useGlobalEvents: vi.fn().mockReturnValue({
    addErrorEvent: vi.fn(),
    addInfoEvent: vi.fn(),
    addSuccessEvent: vi.fn(),
  })
}));

// Mock storage service
vi.mock('../services/storage', () => ({
  storageService: {
    getFile: vi.fn()
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

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset URL.createObjectURL for tests
    global.URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    global.URL.revokeObjectURL = vi.fn();
  });

  it('shows ImageConjuringLoader when generation is pending', () => {
    const message = createMessage(SENTINEL_IMAGE_PENDING);
    const wrapper = mount(MessageItem, {
      props: { message, isCurrentChatStreaming: false }
    });
    
    expect(wrapper.findComponent({ name: 'ImageConjuringLoader' }).exists()).toBe(true);
    expect(wrapper.find('[data-testid="loading-indicator"]').exists()).toBe(false);
  });

  it('renders image when generation is processed (Legacy img tag)', () => {
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

  it('renders and hydrates JSON-based image block (New OPFS mode)', async () => {
    const binaryObjectId = '4dbb8a9f-d41f-4d18-b145-73ffcbf1661a';
    const block = {
      binaryObjectId,
      displayWidth: 400,
      displayHeight: 300,
      prompt: 'a beautiful sunset'
    };
    const content = `${SENTINEL_IMAGE_PROCESSED}\n\n\`\`\`${IMAGE_BLOCK_LANG}\n${JSON.stringify(block)}\n\`\`\``;
    const message = createMessage(content);

    // Mock storage to return a blob
    const mockBlob = new Blob(['mock-image-data'], { type: 'image/png' });
    vi.mocked(storageService.getFile).mockResolvedValue(mockBlob);

    const wrapper = mount(MessageItem, {
      props: { message, isCurrentChatStreaming: false }
    });

    // Initial render should show the placeholder div
    const placeholder = wrapper.find('.naidan-generated-image');
    expect(placeholder.exists()).toBe(true);
    expect(placeholder.attributes('data-id')).toBe(binaryObjectId);
    expect(placeholder.attributes('data-prompt')).toBe(block.prompt);

    // Wait for hydration (loadGeneratedImages)
    await flushPromises();

    // Should now contain the img tag
    const img = wrapper.find('.naidan-generated-image img');
    expect(img.exists()).toBe(true);
    expect(img.attributes('src')).toBe('blob:mock-url');
    expect(img.attributes('width')).toBe('400');
    expect(img.attributes('height')).toBe('300');

    // Should have download button
    expect(wrapper.find('.naidan-download-gen-image').exists()).toBe(true);
  });

  it('handles invalid JSON in image block gracefully', async () => {
    const { addErrorEvent } = vi.mocked(useGlobalEvents());
    const content = `${SENTINEL_IMAGE_PROCESSED}\n\n\`\`\`${IMAGE_BLOCK_LANG}\n{ "invalid": json }\n\`\`\``;
    const message = createMessage(content);

    const wrapper = mount(MessageItem, {
      props: { message, isCurrentChatStreaming: false }
    });

    await flushPromises();

    // Should fallback to showing raw code/JSON
    expect(wrapper.find('.naidan-generated-image').exists()).toBe(false);
    expect(wrapper.find('pre code').exists()).toBe(true);
    
    // Should notify error
    expect(addErrorEvent).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Failed to parse generated image metadata.'
    }));
  });

  it('handles Zod validation failure in image block gracefully', async () => {
    const { addErrorEvent } = vi.mocked(useGlobalEvents());
    // Missing required binaryObjectId, height
    const content = `${SENTINEL_IMAGE_PROCESSED}\n\n\`\`\`${IMAGE_BLOCK_LANG}\n{ "width": 400 }\n\`\`\``;
    const message = createMessage(content);

    const wrapper = mount(MessageItem, {
      props: { message, isCurrentChatStreaming: false }
    });

    await flushPromises();

    // Should fallback
    expect(wrapper.find('.naidan-generated-image').exists()).toBe(false);
    expect(wrapper.find('pre code').exists()).toBe(true);
    
    // Should notify error
    expect(addErrorEvent).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Failed to validate generated image metadata.'
    }));
  });

  it('shows error message when storage fails to provide the image', async () => {
    const binaryObjectId = '4dbb8a9f-d41f-4d18-b145-73ffcbf1661a';
    const content = `${SENTINEL_IMAGE_PROCESSED}\n\n\`\`\`${IMAGE_BLOCK_LANG}\n{ "binaryObjectId": "${binaryObjectId}", "displayWidth": 100, "displayHeight": 100 }\n\`\`\``;
    const message = createMessage(content);

    // Mock storage to return null (or throw)
    vi.mocked(storageService.getFile).mockResolvedValue(null);

    const wrapper = mount(MessageItem, {
      props: { message, isCurrentChatStreaming: false }
    });

    await flushPromises();
    await nextTick();

    expect(wrapper.find('.naidan-generated-image').text()).toContain('Failed to load generated image');
  });

  it('revokes generated image URLs on unmount', async () => {
    const binaryObjectId = '4dbb8a9f-d41f-4d18-b145-73ffcbf1661a'; // Use valid UUID
    const content = `${SENTINEL_IMAGE_PROCESSED}\n\n\`\`\`${IMAGE_BLOCK_LANG}\n{ "binaryObjectId": "${binaryObjectId}", "displayWidth": 100, "displayHeight": 100 }\n\`\`\``;
    const message = createMessage(content);

    vi.mocked(storageService.getFile).mockResolvedValue(new Blob(['data']));
    
    const wrapper = mount(MessageItem, {
      props: { message, isCurrentChatStreaming: false }
    });

    await flushPromises();

    const mockRevoke = vi.mocked(global.URL.revokeObjectURL);
    wrapper.unmount();

    expect(mockRevoke).toHaveBeenCalledWith('blob:mock-url');
  });

  it('hides speech controls for pending image generation', () => {
    const message = createMessage(SENTINEL_IMAGE_PENDING);
    const wrapper = mount(MessageItem, {
      props: { message, isCurrentChatStreaming: false }
    });
    
    // SpeechControl should be hidden or not rendered
    expect(wrapper.findComponent({ name: 'SpeechControl' }).exists()).toBe(false);
  });

  it('hides speech controls for processed image responses', () => {
    const content = `${SENTINEL_IMAGE_PROCESSED}<img src="blob:test">`;
    const message = createMessage(content);
    const wrapper = mount(MessageItem, {
      props: { message, isCurrentChatStreaming: false }
    });
    
    const speechControl = wrapper.findComponent({ name: 'SpeechControl' });
    expect(speechControl.exists()).toBe(false);
  });
});
