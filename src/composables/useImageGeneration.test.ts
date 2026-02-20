import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useImageGeneration } from './useImageGeneration';

import { SENTINEL_IMAGE_PROCESSED, IMAGE_BLOCK_LANG } from '../utils/image-generation';

// Mock storage service
vi.mock('../services/storage', () => ({
  storageService: {
    getFile: vi.fn(),
    saveFile: vi.fn().mockResolvedValue(undefined)
  }
}));

// Mock image processing
const mockReencodeImage = vi.fn().mockImplementation(({ format }) => {
  return Promise.resolve(new Blob([`reencoded-${format}`], { type: `image/${format}` }));
});
vi.mock('../utils/image-processing', () => ({
  reencodeImage: (...args: any[]) => mockReencodeImage(...args)
}));

// Mock global URL
global.URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
global.URL.revokeObjectURL = vi.fn();

// Mock crypto
if (!global.crypto) {
  (global as any).crypto = {
    getRandomValues: (arr: Uint32Array) => {
      for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 1000000);
      return arr;
    }
  };
}

// Mock LLM provider
vi.mock('../services/llm', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    OllamaProvider: class {
      generateImage() {
        return Promise.resolve({
          image: new Blob(['test-image'], { type: 'image/png' }),
          totalSteps: 10
        });
      }
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
        steps: undefined,
        seed: undefined,
        persistAs: 'original',
        chatId,
        attachments: [],
        availableModels,
        sendMessage
      });

      expect(result).toBe(true);
      expect(sendMessage).toHaveBeenCalledWith({
        content: expect.stringContaining('<!-- naidan_experimental_image_request {"width":1024,"height":1024,"model":"x/z-image-turbo:v1","count":1,"persistAs":"original"} -->a sunset'),
        parentId: undefined,
        attachments: []
      });
    });

    it('includes steps and seed in the request marker', async () => {
      const { sendImageRequest } = useImageGeneration();
      const sendMessage = vi.fn().mockResolvedValue(true);
      const availableModels = ['x/z-image-turbo:v1'];

      await sendImageRequest({
        prompt: 'a snowy mountain',
        width: 1024,
        height: 1024,
        count: 1,
        steps: 35,
        seed: 12345,
        persistAs: 'original',
        chatId,
        attachments: [],
        availableModels,
        sendMessage
      });

      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('"steps":35,"seed":12345')
      }));
    });

    it('handles browser_random seed in sendImageRequest', async () => {
      const { sendImageRequest } = useImageGeneration();
      const sendMessage = vi.fn().mockResolvedValue(true);
      const availableModels = ['x/z-image-turbo:v1'];

      await sendImageRequest({
        prompt: 'a rainy street',
        width: 512,
        height: 512,
        count: 1,
        steps: undefined,
        seed: 'browser_random',
        persistAs: 'original',
        chatId,
        attachments: [],
        availableModels,
        sendMessage
      });

      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining('"seed":"browser_random"')
      }));
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
      steps: undefined,
      seed: undefined,
      persistAs: 'original' as const,
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

    it('converts image to requested format when persistAs is specified', async () => {
      const { handleImageGeneration } = useImageGeneration();
      const { storageService } = await import('../services/storage');

      await handleImageGeneration({
        ...commonParams,
        persistAs: 'webp',
        storageType: 'opfs'
      });

      // Should have called reencodeImage
      expect(mockReencodeImage).toHaveBeenCalledWith({
        blob: expect.any(Blob),
        format: 'webp'
      });

      // Should have saved with .webp extension
      expect(storageService.saveFile).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'image/webp' }),
        expect.any(String),
        expect.stringMatching(/\.webp$/)
      );
    });

    it('falls back to original format if re-encoding fails', async () => {
      const { handleImageGeneration } = useImageGeneration();
      const { storageService } = await import('../services/storage');

      // Force failure
      mockReencodeImage.mockRejectedValueOnce(new Error('Canvas failure'));

      await handleImageGeneration({
        ...commonParams,
        persistAs: 'jpeg',
        storageType: 'opfs'
      });

      // Should have saved original blob with .png extension (default)
      expect(storageService.saveFile).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'image/png' }),
        expect.any(String),
        expect.stringMatching(/\.png$/)
      );
    });

    it('generates a random numeric seed when "browser_random" is specified and includes it in blocks and prompt', async () => {
      const { handleImageGeneration } = useImageGeneration();

      await handleImageGeneration({
        ...commonParams,
        seed: 'browser_random',
        storageType: 'opfs'
      });

      const assistantNode = mockChat.root.items[0];
      // Find the JSON block content (more flexible regex)
      const blockMatch = assistantNode!.content.match(/```naidan_experimental_image\s+([\s\S]*?)\s+```/);
      expect(blockMatch).not.toBeNull();
      const blockData = JSON.parse(blockMatch![1]!);

      // Verify seed is a number
      expect(typeof blockData.seed).toBe('number');
      expect(blockData.seed).toBeGreaterThan(0);

      // Verify prompt in block does NOT contain the seed anymore
      expect(blockData.prompt).not.toMatch(/\(seed: \d+\)$/);
      expect(blockData.prompt).toBe('a futuristic city');
    });

    it('uses steps and totalSteps from the provider in the final output blocks', async () => {
      const { handleImageGeneration } = useImageGeneration();

      await handleImageGeneration({
        ...commonParams,
        steps: 42,
        seed: 1337,
        storageType: 'opfs'
      });

      const assistantNode = mockChat.root.items[0];
      const blockMatch = assistantNode!.content.match(/```naidan_experimental_image\s+([\s\S]*?)\s+```/);
      expect(blockMatch).not.toBeNull();
      const blockData = JSON.parse(blockMatch![1]!);

      expect(blockData.steps).toBe(10); // Mock returns 10
      expect(blockData.seed).toBe(1337);
      expect(blockData.prompt).not.toContain('(seed: 1337)');
      expect(blockData.prompt).toBe('a futuristic city');
    });

    it('uses undefined for steps in the final output blocks if provider returns UNKNOWN_STEPS', async () => {
      const { handleImageGeneration } = useImageGeneration();
      const { OllamaProvider } = await import('../services/llm');
      const { UNKNOWN_STEPS } = await import('../services/llm');

      const generateImageSpy = vi.spyOn(OllamaProvider.prototype, 'generateImage')
        .mockResolvedValueOnce({
          image: new Blob(['test'], { type: 'image/png' }),
          totalSteps: UNKNOWN_STEPS as any
        });

      await handleImageGeneration({
        ...commonParams,
        steps: 42,
        storageType: 'opfs'
      });

      const assistantNode = mockChat.root.items[0];
      const blockMatch = assistantNode!.content.match(/```naidan_experimental_image\s+([\s\S]*?)\s+```/);
      const blockData = JSON.parse(blockMatch![1]!);

      expect(blockData.steps).toBeUndefined();
      generateImageSpy.mockRestore();
    });

    it('updates and then clears imageProgressMap during generation', async () => {
      const { handleImageGeneration, imageProgressMap } = useImageGeneration();

      // We need to capture the progress map state DURING generation.
      // Since generateImage is async, we can check it after the first updateChatContent call if we're careful,
      // but a more robust way is to verify it was set and then is gone.

      await handleImageGeneration({
        ...commonParams,
        chatId: 'progress-test-chat',
        storageType: 'opfs'
      });

      // After generation, it should be cleared
      expect(imageProgressMap.value['progress-test-chat']).toBeUndefined();
    });

    it('clears imageProgressMap at the start of each image in a batch', async () => {
      const { handleImageGeneration, imageProgressMap } = useImageGeneration();
      const { OllamaProvider } = await import('../services/llm');

      // Set stale progress
      imageProgressMap.value[chatId] = { currentStep: 50, totalSteps: 50 };

      // Spy on generateImage and check progress map state when it's called
      const generateImageSpy = vi.spyOn(OllamaProvider.prototype, 'generateImage')
        .mockImplementation(async ({ onProgress }) => {
          // When this is called, the progress map should have been cleared by the loop
          expect(imageProgressMap.value[chatId]).toBeUndefined();

          // Simulate some progress
          if (onProgress) onProgress({ currentStep: 1, totalSteps: 10 });
          return {
            image: new Blob(['test'], { type: 'image/png' }),
            totalSteps: 10
          };
        });

      await handleImageGeneration({
        ...commonParams,
        count: 2,
        storageType: 'opfs'
      });

      expect(generateImageSpy).toHaveBeenCalledTimes(2);
      generateImageSpy.mockRestore();
    });
  });
});
