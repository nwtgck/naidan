import { describe, it, expect } from 'vitest';
import { 
  getImageGenerationModels, 
  createImageRequestMarker, 
  isImageRequest, 
  parseImageRequest, 
  stripNaidanSentinels,
  isImageGenerationPending,
  isImageGenerationProcessed,
  SENTINEL_IMAGE_PENDING,
  SENTINEL_IMAGE_PROCESSED
} from './image-generation';

describe('image-generation utilities', () => {
  describe('getImageGenerationModels', () => {
    it('should filter models starting with x/z-image-turbo:', () => {
      const models = [
        'llama3',
        'x/z-image-turbo:v1',
        'gpt-4',
        'x/z-image-turbo:v2',
        'mistral'
      ];
      expect(getImageGenerationModels(models)).toEqual([
        'x/z-image-turbo:v1',
        'x/z-image-turbo:v2'
      ]);
    });

    it('should return empty array if no matches', () => {
      expect(getImageGenerationModels(['llama3', 'gpt-4'])).toEqual([]);
    });
  });

  describe('createImageRequestMarker', () => {
    it('should create a correct sentinel string', () => {
      const marker = createImageRequestMarker({ width: 1024, height: 1024, model: 'test-model' });
      expect(marker).toBe('<!-- naidan_experimental_image_request {"width":1024,"height":1024,"model":"test-model"} -->');
    });
  });

  describe('isImageRequest', () => {
    it('should return true if content contains the request prefix', () => {
      expect(isImageRequest('some text <!-- naidan_experimental_image_request {"width":512} --> more text')).toBe(true);
    });

    it('should return false otherwise', () => {
      expect(isImageRequest('just regular text')).toBe(false);
    });
  });

  describe('parseImageRequest', () => {
    it('should parse valid request parameters', () => {
      const content = '<!-- naidan_experimental_image_request {"width":256,"height":256,"model":"turbo-1"} -->';
      expect(parseImageRequest(content)).toEqual({
        width: 256,
        height: 256,
        model: 'turbo-1',
        count: 1
      });
    });

    it('should return default values for missing properties', () => {
      const content = '<!-- naidan_experimental_image_request {"model":"turbo-1"} -->';
      expect(parseImageRequest(content)).toEqual({
        width: 512,
        height: 512,
        model: 'turbo-1',
        count: 1
      });
    });

    it('should return null for invalid format', () => {
      expect(parseImageRequest('not a marker')).toBeNull();
    });
  });

  describe('stripNaidanSentinels', () => {
    it('should remove all naidan technical comments', () => {
      const content = 'Hello <!-- naidan_foo --> world <!-- naidan_bar -->';
      expect(stripNaidanSentinels(content)).toBe('Hello  world ');
    });

    it('should leave other comments untouched', () => {
      const content = 'Hello <!-- other --> world';
      expect(stripNaidanSentinels(content)).toBe('Hello <!-- other --> world');
    });
  });

  describe('status checks', () => {
    it('isImageGenerationPending should identify pending sentinel', () => {
      expect(isImageGenerationPending(SENTINEL_IMAGE_PENDING)).toBe(true);
      expect(isImageGenerationPending('no')).toBe(false);
    });

    it('isImageGenerationProcessed should identify processed sentinel', () => {
      expect(isImageGenerationProcessed(SENTINEL_IMAGE_PROCESSED)).toBe(true);
      expect(isImageGenerationProcessed('no')).toBe(false);
    });
  });
});
