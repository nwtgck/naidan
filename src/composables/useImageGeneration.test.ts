import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useImageGeneration } from './useImageGeneration';

import { SENTINEL_IMAGE_PROCESSED, IMAGE_BLOCK_LANG } from '../utils/image-generation';

// Mock storage service
vi.mock('../services/storage', () => ({
  storageService: {
    saveFile: vi.fn().mockResolvedValue(undefined)
  }
}));

// Mock global URL
global.URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
global.URL.revokeObjectURL = vi.fn();

// Mock LLM provider
vi.mock('../services/llm', () => {
  return {
    OllamaProvider: class {
      generateImage = vi.fn().mockResolvedValue(new Blob(['test-image'], { type: 'image/png' }))
    }
  };
});

describe('useImageGeneration', () => {
  const chatId = 'test-chat-123';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('toggles image mode', () => {
    const { isImageMode, toggleImageMode } = useImageGeneration();
    expect(isImageMode({ chatId })).toBe(false);
    
    toggleImageMode({ chatId });
    expect(isImageMode({ chatId })).toBe(true);
    
    toggleImageMode({ chatId });
    expect(isImageMode({ chatId })).toBe(false);
  });

  it('manages resolution', () => {
    const { getResolution, updateResolution } = useImageGeneration();
    expect(getResolution({ chatId })).toEqual({ width: 512, height: 512 });
    
    updateResolution({ chatId, width: 1024, height: 1024 });
    expect(getResolution({ chatId })).toEqual({ width: 1024, height: 1024 });
  });

  it('selects the correct image model', () => {
    const { getSelectedImageModel, setImageModel } = useImageGeneration();
    const availableModels = ['llama3', 'x/z-image-turbo:v1', 'x/z-image-turbo:v2'];
    
    // Default to first image model
    expect(getSelectedImageModel({ chatId, availableModels })).toBe('x/z-image-turbo:v1');
    
    // Manual override
    setImageModel({ chatId, modelId: 'x/z-image-turbo:v2' });
    expect(getSelectedImageModel({ chatId, availableModels })).toBe('x/z-image-turbo:v2');
    
    // Invalid override falls back
    setImageModel({ chatId, modelId: 'invalid' });
    expect(getSelectedImageModel({ chatId, availableModels })).toBe('x/z-image-turbo:v1');
  });

  it('sorts image models naturally', () => {
    const { getSortedImageModels } = useImageGeneration();
    const availableModels = ['x/z-image-turbo:10', 'x/z-image-turbo:2'];
    expect(getSortedImageModels({ availableModels })).toEqual(['x/z-image-turbo:2', 'x/z-image-turbo:10']);
  });

  describe('sendImageRequest', () => {
    it('prepends image marker and calls sendMessage', async () => {
      const { sendImageRequest } = useImageGeneration();
      const sendMessage = vi.fn().mockResolvedValue(true);
      const availableModels = ['x/z-image-turbo:v1'];
      
      const result = await sendImageRequest({
        prompt: 'a sunset',
        width: 1024,
        height: 1024,
        count: 1,
        chatId,
        attachments: [],
        availableModels,
        sendMessage
      });

      expect(result).toBe(true);
      expect(sendMessage).toHaveBeenCalledWith({
        content: expect.stringContaining('<!-- naidan_experimental_image_request {"width":1024,"height":1024,"model":"x/z-image-turbo:v1","count":1} -->a sunset'),
        parentId: undefined,
        attachments: []
      });
    });
  });

  describe('handleImageGeneration', () => {
    const assistantId = 'msg-assistant-1';
    const mockChat = {
      id: chatId,
      root: {
        items: [
          { id: assistantId, role: 'assistant', content: '', replies: { items: [] } }
        ]
      }
    };

    const commonParams = {
      chatId,
      assistantId,
      prompt: 'a futuristic city',
      width: 512,
      height: 512,
      count: 1,
      images: [],
      model: 'x/z-image-turbo:v1',
      availableModels: ['x/z-image-turbo:v1'],
      endpointUrl: 'http://localhost:11434',
      endpointHttpHeaders: undefined,
      signal: undefined,
      getLiveChat: () => mockChat as any,
      updateChatContent: vi.fn(),
      triggerChatRef: vi.fn(),
      incTask: vi.fn(),
      decTask: vi.fn(),
    };

    it('generates a specialized markdown block when using OPFS', async () => {
      const { handleImageGeneration } = useImageGeneration();
      
      await handleImageGeneration({
        ...commonParams,
        storageType: 'opfs'
      });

      const assistantNode = mockChat.root.items[0];
      expect(assistantNode).toBeDefined();
      expect(assistantNode!.content).toContain(SENTINEL_IMAGE_PROCESSED);
      expect(assistantNode!.content).toContain('```' + IMAGE_BLOCK_LANG);
      expect(assistantNode!.content).toContain('"binaryObjectId":');
      expect(assistantNode!.content).toContain('"displayWidth": 409.6');
      expect(assistantNode!.content).toContain('"displayHeight": 409.6');
      expect(assistantNode!.content).toContain('"prompt": "a futuristic city"');
    });

    it('generates a legacy img tag when using local storage', async () => {
      const { handleImageGeneration } = useImageGeneration();
      
      await handleImageGeneration({
        ...commonParams,
        storageType: 'local'
      });

      const assistantNode = mockChat.root.items[0];
      expect(assistantNode).toBeDefined();
      expect(assistantNode!.content).toContain(SENTINEL_IMAGE_PROCESSED);
      expect(assistantNode!.content).toContain('<img src="blob:');
      expect(assistantNode!.content).not.toContain('```' + IMAGE_BLOCK_LANG);
    });

    it('generates multiple images sequentially', async () => {
      const { handleImageGeneration } = useImageGeneration();
      const triggerChatRef = vi.fn();
      
      // Reset assistant content
      mockChat.root.items[0]!.content = '';

      await handleImageGeneration({
        ...commonParams,
        count: 3,
        storageType: 'local',
        triggerChatRef
      });

      const assistantNode = mockChat.root.items[0];
      
      // Should have 3 image tags
      const imgMatches = assistantNode!.content.match(/<img/g);
      expect(imgMatches?.length).toBe(3);
      
      // Should have triggered ref update at least once for each image + start/end
      expect(triggerChatRef).toHaveBeenCalled();
      
      // Verify final content has the processed sentinel
      expect(assistantNode!.content).toContain(SENTINEL_IMAGE_PROCESSED);
    });
  });
});
