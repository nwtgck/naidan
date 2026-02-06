import { describe, it, expect, vi } from 'vitest';
import { useImageGeneration } from './useImageGeneration';

describe('useImageGeneration', () => {
  const chatId = 'test-chat-123';

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
        chatId,
        attachments: [],
        availableModels,
        sendMessage
      });

      expect(result).toBe(true);
      expect(sendMessage).toHaveBeenCalledWith({
        content: expect.stringContaining('<!-- naidan_experimental_image_request {"width":1024,"height":1024,"model":"x/z-image-turbo:v1"} -->a sunset'),
        parentId: undefined,
        attachments: []
      });
    });
  });
});
