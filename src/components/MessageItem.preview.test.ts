import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
import MessageItem from './MessageItem.vue';
import { storageService } from '../services/storage';
import type { MessageNode } from '../models/types';

// --- Mocks ---

vi.mock('../services/storage', () => ({
  storageService: {
    getFile: vi.fn(),
    getBinaryObject: vi.fn(),
    subscribeToChanges: vi.fn(() => vi.fn()), // Returns an unsubscribe function
  },
}));

const mockOpenPreview = vi.fn();
vi.mock('../composables/useImagePreview', () => ({
  useImagePreview: vi.fn(() => ({
    openPreview: mockOpenPreview,
    closePreview: vi.fn(),
  })),
}));

// Mock URL.createObjectURL
vi.stubGlobal('URL', {
  createObjectURL: vi.fn(() => 'blob:mock-url'),
  revokeObjectURL: vi.fn(),
});

// --- Test Data ---

const mockMessage: MessageNode = {
  id: 'msg-1',
  role: 'user',
  content: 'Hello with image',
  timestamp: 1000,
  attachments: [
    {
      id: 'att-1',
      binaryObjectId: 'bin-1',
      originalName: 'test.png',
      mimeType: 'image/png',
      size: 100,
      uploadedAt: 1000,
      status: 'persisted'
    }
  ],
  replies: { items: [] }
};

describe('MessageItem.vue Preview Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('triggers preview when an attachment image is clicked', async () => {
    vi.mocked(storageService.getFile).mockResolvedValue(new Blob(['data'], { type: 'image/png' }));
    vi.mocked(storageService.getBinaryObject).mockResolvedValue({
      id: 'bin-1',
      name: 'test.png',
      mimeType: 'image/png',
      size: 100,
      createdAt: 1000
    });

    const wrapper = mount(MessageItem, {
      props: {
        message: mockMessage
      }
    });

    await flushPromises();

    const img = wrapper.find('img');
    expect(img.exists()).toBe(true);

    await img.trigger('click');
    await flushPromises();

    expect(mockOpenPreview).toHaveBeenCalledWith({
      objects: [
        expect.objectContaining({ id: 'bin-1', name: 'test.png' })
      ],
      initialId: 'bin-1'
    });
  });

  it('triggers preview when a generated image is clicked', async () => {
    const genId = '00000000-0000-4000-8000-000000000001';
    const genImageMsg: MessageNode = {
      id: 'msg-2',
      role: 'assistant',
      content: `Here is your image:\n\n\`\`\`naidan_experimental_image
{"binaryObjectId":"${genId}","displayWidth":512,"displayHeight":512,"prompt":"a sunset"}
\`\`\``,
      timestamp: 2000,
      replies: { items: [] }
    };

    vi.mocked(storageService.getFile).mockResolvedValue(new Blob(['data'], { type: 'image/png' }));
    vi.mocked(storageService.getBinaryObject).mockResolvedValue({
      id: genId,
      name: 'generated.png',
      mimeType: 'image/png',
      size: 500,
      createdAt: 2000
    });

    const wrapper = mount(MessageItem, {
      props: {
        message: genImageMsg
      },
      global: {
        stubs: {
          ImageConjuringLoader: true,
          SpeechControl: true,
          ChatToolsMenu: true
        }
      }
    });

    await flushPromises();

    // Poll for the image element to appear (hydration is async)
    for (let i = 0; i < 20; i++) {
      await nextTick();
      if (wrapper.find('.naidan-clickable-img').exists()) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    // The image is rendered via loadGeneratedImages
    const img = wrapper.find('.naidan-clickable-img');
    expect(img.exists()).toBe(true);

    await img.trigger('click');
    await flushPromises();

    expect(mockOpenPreview).toHaveBeenCalledWith({
      objects: [
        expect.objectContaining({ id: genId })
      ],
      initialId: genId
    });
  });
});
