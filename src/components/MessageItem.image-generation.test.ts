import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';

// --- Mocks must come BEFORE imports that use them ---

// Mock storage service
vi.mock('../services/storage', () => ({
  storageService: {
    getFile: vi.fn().mockResolvedValue(new Blob(['data'], { type: 'image/png' })),
    getBinaryObject: vi.fn().mockResolvedValue({
      id: 'default-id',
      name: 'default.png',
      mimeType: 'image/png',
      size: 100,
      createdAt: Date.now()
    }),
    subscribeToChanges: vi.fn(),
    loadSettings: vi.fn().mockResolvedValue({}),
    saveSettings: vi.fn(),
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

// --- Now import the component and other things ---

import MessageItem from './MessageItem.vue';
import ImageDownloadButton from './ImageDownloadButton.vue';
import { SENTINEL_IMAGE_PENDING, SENTINEL_IMAGE_PROCESSED, IMAGE_BLOCK_LANG } from '../utils/image-generation';
import { storageService } from '../services/storage';

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

    // Reset storage service mocks for each test
    vi.mocked(storageService.getFile).mockResolvedValue(new Blob(['data'], { type: 'image/png' }));
    vi.mocked(storageService.getBinaryObject).mockResolvedValue({
      id: 'default-id',
      name: 'test.png',
      mimeType: 'image/png',
      size: 100,
      createdAt: Date.now()
    });

    // Reset URL.createObjectURL for tests
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn().mockReturnValue('blob:mock-url'),
      revokeObjectURL: vi.fn(),
    });
  });

  it('shows ImageConjuringLoader when generation is pending', () => {
    const message = createMessage(SENTINEL_IMAGE_PENDING);
    const wrapper = mount(MessageItem, {
      props: { message, isCurrentChatStreaming: false }
    });

    expect(wrapper.findComponent({ name: 'ImageConjuringLoader' }).exists()).toBe(true);
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

    const wrapper = mount(MessageItem, {
      props: { message, isCurrentChatStreaming: false, chatId: 'test-chat' },
      global: {
        components: { ImageDownloadButton }
      }
    });

    await flushPromises();

    let hydrated = false;
    for (let i = 0; i < 40; i++) {
      await nextTick();
      if (wrapper.find('.naidan-generated-image img').exists()) {
        hydrated = true;
        break;
      }
      await new Promise(r => setTimeout(r, 20));
    }

    expect(hydrated).toBe(true);
    expect(wrapper.find('[data-testid="download-gen-image-button"]').exists()).toBe(true);
  });

  it('renders "With Metadata" option in the dropdown', async () => {
    const binaryObjectId = 'ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb';
    const block = {
      binaryObjectId,
      displayWidth: 400,
      displayHeight: 300,
      prompt: 'meta-test'
    };
    const content = `${SENTINEL_IMAGE_PROCESSED}\n\n\`\`\`${IMAGE_BLOCK_LANG}\n${JSON.stringify(block)}\n\`\`\``;
    const message = createMessage(content);

    vi.mocked(storageService.getFile).mockResolvedValue(new Blob(['data'], { type: 'image/png' }));
    vi.mocked(storageService.getBinaryObject).mockResolvedValue({
      id: binaryObjectId,
      name: 'test.png',
      mimeType: 'image/png',
      size: 100,
      createdAt: Date.now()
    });

    const wrapper = mount(MessageItem, {
      props: { message, isCurrentChatStreaming: false, chatId: 'test-chat' },
      global: {
        components: { ImageDownloadButton }
      }
    });

    await flushPromises();

    // Check if initial rendering logic worked (markdown parsing)
    if (!wrapper.html().includes('naidan-generated-image')) {
      console.log('MARKDOWN PARSING FAILED. HTML:', wrapper.html());
    }
    expect(wrapper.html()).toContain('naidan-generated-image');

    // Poll for hydration
    let hydrated = false;
    for (let i = 0; i < 60; i++) {
      await nextTick();
      if (wrapper.find('.naidan-generated-image img').exists()) {
        hydrated = true;
        break;
      }
      await new Promise(r => setTimeout(r, 20));
    }

    expect(hydrated).toBe(true);

    let metaOption = wrapper.find('[data-testid="download-with-metadata-option"]');
    if (!metaOption.exists()) {
      // Try to open via the portal's button group first
      const buttonGroup = wrapper.find('.naidan-download-portal > div');
      if (buttonGroup.exists()) {
        await buttonGroup.trigger('mouseenter');
      } else {
        await wrapper.find('.naidan-generated-image').trigger('mouseenter');
      }
      await nextTick();
      metaOption = wrapper.find('[data-testid="download-with-metadata-option"]');
    }

    expect(metaOption.exists()).toBe(true);
    expect(metaOption.text()).toContain('With Metadata');
  });

  it('handles invalid JSON in image block gracefully', async () => {
    const content = `${SENTINEL_IMAGE_PROCESSED}\n\n\`\`\`${IMAGE_BLOCK_LANG}\n{ "invalid": json }\n\`\`\``;
    const message = createMessage(content);

    const wrapper = mount(MessageItem, {
      props: { message, isCurrentChatStreaming: false }
    });

    await flushPromises();
    await nextTick();

    expect(wrapper.find('.naidan-generated-image').exists()).toBe(false);
    expect(wrapper.find('pre code').exists()).toBe(true);
  });

  it('handles Zod validation failure in image block gracefully', async () => {
    const content = `${SENTINEL_IMAGE_PROCESSED}\n\n\`\`\`${IMAGE_BLOCK_LANG}\n{ "width": 400 }\n\`\`\``;
    const message = createMessage(content);

    const wrapper = mount(MessageItem, {
      props: { message, isCurrentChatStreaming: false }
    });

    await flushPromises();
    expect(wrapper.find('.naidan-generated-image').exists()).toBe(false);
  });

  it('shows error message when storage fails to provide the image', async () => {
    const binaryObjectId = '4dbb8a9f-d41f-4d18-b145-73ffcbf1661a';
    const content = `${SENTINEL_IMAGE_PROCESSED}\n\n\`\`\`${IMAGE_BLOCK_LANG}\n{ "binaryObjectId": "${binaryObjectId}", "displayWidth": 100, "displayHeight": 100 }\n\`\`\``;
    const message = createMessage(content);

    vi.mocked(storageService.getFile).mockResolvedValue(null);

    const wrapper = mount(MessageItem, {
      props: { message, isCurrentChatStreaming: false, chatId: 'test-chat' }
    });

    await flushPromises();
    for (let i = 0; i < 40; i++) {
      await nextTick();
      if (wrapper.find('.naidan-generated-image').text().includes('Failed to load')) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    expect(wrapper.find('.naidan-generated-image').text()).toContain('Failed to load generated image');
  });

  it('revokes generated image URLs on unmount', async () => {
    const binaryObjectId = '4dbb8a9f-d41f-4d18-b145-73ffcbf1661a';
    const content = `${SENTINEL_IMAGE_PROCESSED}\n\n\`\`\`${IMAGE_BLOCK_LANG}\n{ "binaryObjectId": "${binaryObjectId}", "displayWidth": 100, "displayHeight": 100 }\n\`\`\``;
    const message = createMessage(content);

    const wrapper = mount(MessageItem, {
      props: { message, isCurrentChatStreaming: false, chatId: 'test-chat' }
    });

    await flushPromises();
    for (let i = 0; i < 40; i++) {
      await nextTick();
      if (wrapper.find('.naidan-generated-image img').exists()) break;
      await new Promise(r => setTimeout(r, 20));
    }

    wrapper.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
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

  it('uses correct extension from storage when downloading a generated image', async () => {
    const binaryObjectId = '4dbb8a9f-d41f-4d18-b145-73ffcbf1661a';
    const content = `${SENTINEL_IMAGE_PROCESSED}\n\n\`\`\`${IMAGE_BLOCK_LANG}\n{ "binaryObjectId": "${binaryObjectId}", "displayWidth": 100, "displayHeight": 100, "prompt": "blue cat" }\n\`\`\``;
    const message = createMessage(content);

    vi.mocked(storageService.getFile).mockResolvedValue(new Blob(['data'], { type: 'image/webp' }));
    vi.mocked(storageService.getBinaryObject).mockResolvedValue({
      id: binaryObjectId,
      name: 'blue cat.webp',
      mimeType: 'image/webp',
      size: 123,
      createdAt: Date.now()
    });

    const wrapper = mount(MessageItem, {
      props: { message, isCurrentChatStreaming: false, chatId: 'test-chat' },
      global: {
        components: { ImageDownloadButton }
      }
    });

    await flushPromises();

    // Wait for hydration
    for (let i = 0; i < 20; i++) {
      await nextTick();
      if (wrapper.find('.naidan-generated-image img').exists()) break;
      await new Promise(r => setTimeout(r, 20));
    }

    // Mock document.createElement for the link
    const link = {
      click: vi.fn(),
      download: '',
      href: '',
      style: {}
    };
    const createElementSpy = vi.spyOn(document, 'createElement').mockReturnValue(link as any);
    const appendChildSpy = vi.spyOn(document.body, 'appendChild').mockImplementation(() => link as any);
    const removeChildSpy = vi.spyOn(document.body, 'removeChild').mockImplementation(() => link as any);

    // Trigger download (Standard download button)
    const downloadBtn = wrapper.find('[data-testid="download-gen-image-button"]');
    expect(downloadBtn.exists()).toBe(true);
    await downloadBtn.trigger('click');

    // Should have called getBinaryObject
    expect(storageService.getBinaryObject).toHaveBeenCalledWith({ binaryObjectId });

    // Should have set correct filename with .webp extension
    expect(link.download).toBe('blue cat.webp');
    expect(link.click).toHaveBeenCalled();

    createElementSpy.mockRestore();
    appendChildSpy.mockRestore();
    removeChildSpy.mockRestore();
  });

  it('renders and hydrates ImageInfoDisplay with metadata', async () => {
    const binaryObjectId = 'info-test-id';
    const block = {
      binaryObjectId,
      displayWidth: 400,
      displayHeight: 300,
      prompt: 'a futuristic city',
      steps: 30,
      seed: 12345
    };
    const content = `${SENTINEL_IMAGE_PROCESSED}\n\n\`\`\`${IMAGE_BLOCK_LANG}\n${JSON.stringify(block)}\n\`\`\``;
    const message = createMessage(content);

    const wrapper = mount(MessageItem, {
      props: { message, isCurrentChatStreaming: false, chatId: 'test-chat' },
      global: {
        components: { ImageDownloadButton }
      }
    });

    await flushPromises();

    // Poll for hydration
    let hydrated = false;
    for (let i = 0; i < 40; i++) {
      await nextTick();
      if (wrapper.find('[data-testid="image-info-button"]').exists()) {
        hydrated = true;
        break;
      }
      await new Promise(r => setTimeout(r, 20));
    }

    expect(hydrated).toBe(true);

    const infoButton = wrapper.find('[data-testid="image-info-button"]');
    expect(infoButton.exists()).toBe(true);

    // Initial state: popup should not be visible (it's v-if based)
    expect(wrapper.text()).not.toContain('Steps');

    // Click to open
    await infoButton.trigger('click');
    await nextTick();

    // Verify content
    expect(wrapper.text()).toContain('a futuristic city');
    expect(wrapper.text()).toContain('Steps');
    expect(wrapper.text()).toContain('30');
    expect(wrapper.text()).toContain('Seed');
    expect(wrapper.text()).toContain('12345');
  });

  it('maintains layout stability with aspect-ratio skeleton and hydrates multiple images in parallel', async () => {
    const images = [
      { id: 'img-1', w: 512, h: 512 },
      { id: 'img-2', w: 1024, h: 768 }
    ];
    const content = SENTINEL_IMAGE_PROCESSED + '\n\n' + images.map(img => (
      `\`\`\`${IMAGE_BLOCK_LANG}\n${JSON.stringify({
        binaryObjectId: img.id,
        displayWidth: img.w,
        displayHeight: img.h,
        prompt: `image ${img.id}`
      })}\n\`\`\``
    )).join('\n\n');

    const message = createMessage(content);

    const wrapper = mount(MessageItem, {
      props: { message, isCurrentChatStreaming: false, chatId: 'parallel-test' }
    });

    // Check skeletons immediately after mount
    const skeletons = wrapper.findAll('.naidan-image-skeleton');
    expect(skeletons).toHaveLength(2);

    const skeleton0 = skeletons.at(0)?.element as HTMLElement;
    const skeleton1 = skeletons.at(1)?.element as HTMLElement;
    expect(skeleton0.style.aspectRatio).toBe('512 / 512');
    expect(skeleton0.style.maxWidth).toBe('100%');
    expect(skeleton1.style.aspectRatio).toBe('1024 / 768');
    expect(skeleton1.style.maxWidth).toBe('100%');
    await flushPromises();

    // Poll for hydration of all images
    let allHydrated = false;
    for (let i = 0; i < 50; i++) {
      await nextTick();
      const imgs = wrapper.findAll('.naidan-generated-image img.naidan-clickable-img');
      if (imgs.length === 2) {
        allHydrated = true;
        break;
      }
      await new Promise(r => setTimeout(r, 20));
    }

    expect(allHydrated).toBe(true);
    const hydratedImgs = wrapper.findAll('.naidan-generated-image img.naidan-clickable-img');
    expect(hydratedImgs[0]?.attributes('src')).toBe('blob:mock-url');
    expect(hydratedImgs[1]?.attributes('src')).toBe('blob:mock-url');

    // Skeletons should be gone
    expect(wrapper.find('.naidan-image-skeleton').exists()).toBe(false);
  });

  it('reuses existing image elements and avoids redundant storage reads (cache/idempotency)', async () => {
    const binaryObjectId = 'idempotency-test';
    const block = { binaryObjectId, displayWidth: 100, displayHeight: 100 };
    const content = `${SENTINEL_IMAGE_PROCESSED}\n\n\`\`\`${IMAGE_BLOCK_LANG}\n${JSON.stringify(block)}\n\`\`\``;

    // Create a reactive message object to trigger updates
    const message = {
      id: '1',
      role: 'assistant' as const,
      content,
      timestamp: Date.now(),
      replies: { items: [] }
    };

    const wrapper = mount(MessageItem, {
      props: { message, isCurrentChatStreaming: false, chatId: 'cache-test' }
    });

    // 1. Wait for first hydration
    for (let i = 0; i < 40; i++) {
      await nextTick();
      if (wrapper.find('img.naidan-clickable-img').exists()) break;
      await new Promise(r => setTimeout(r, 20));
    }

    const initialGetFileCount = vi.mocked(storageService.getFile).mock.calls.length;

    // 2. Trigger a message content update (e.g. streaming more text)
    // This will trigger the watch(parsedContent) and loadGeneratedImages again
    await wrapper.setProps({
      message: {
        ...message,
        content: content + '\n\nMore text added to message.'
      }
    });

    // Wait for potential re-hydration
    await flushPromises();
    await nextTick();

    // 3. Wait for re-hydration
    for (let i = 0; i < 40; i++) {
      await nextTick();
      if (wrapper.find('img.naidan-clickable-img').exists()) break;
      await new Promise(r => setTimeout(r, 20));
    }

    expect(wrapper.find('img.naidan-clickable-img').exists()).toBe(true);

    // 4. Verify no new getFile calls were made for metadata/image loading for this ID
    // The count should stay the same as after the first hydration due to caching
    const finalGetFileCount = vi.mocked(storageService.getFile).mock.calls.length;
    expect(finalGetFileCount).toBe(initialGetFileCount);
  });
});
