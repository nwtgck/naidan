import { describe, it, expect } from 'vitest';
import { matchRecipeModels, getAllMatchingModels, generateDefaultModelPatterns } from './recipe-matcher';
import type { RecipeModel } from '../models/recipe';

describe('recipe-matcher', () => {
  const availableModels = ['llama3:8b', 'llama3:70b', 'gpt-4o', 'gpt-3.5-turbo'];

  describe('matchRecipeModels', () => {
    it('should match a simple regex pattern', () => {
      const models: RecipeModel[] = [
        { kind: 'regex', pattern: 'gpt-4', flags: ['i'] }
      ];
      const result = matchRecipeModels(models, availableModels);
      expect(result.modelId).toBe('gpt-4o');
    });

    it('should match the first matching pattern in order', () => {
      const models: RecipeModel[] = [
        { kind: 'regex', pattern: 'llama3:70b', flags: ['i'] },
        { kind: 'regex', pattern: 'llama3', flags: ['i'] }
      ];
      const result = matchRecipeModels(models, availableModels);
      expect(result.modelId).toBe('llama3:70b');
    });

    it('should return undefined modelId if no match is found', () => {
      const models: RecipeModel[] = [
        { kind: 'regex', pattern: 'claude', flags: ['i'] }
      ];
      const result = matchRecipeModels(models, availableModels);
      expect(result.modelId).toBeUndefined();
    });

    it('should return an error for invalid regex', () => {
      const models: RecipeModel[] = [
        { kind: 'regex', pattern: '[', flags: ['i'] }
      ];
      const result = matchRecipeModels(models, availableModels);
      expect(result.error).toContain('Invalid regex');
    });
  });

  describe('getAllMatchingModels', () => {
    it('should return all matching models for multiple patterns', () => {
      const models: RecipeModel[] = [
        { kind: 'regex', pattern: 'llama3', flags: ['i'] },
        { kind: 'regex', pattern: 'gpt', flags: ['i'] }
      ];
      const result = getAllMatchingModels(models, availableModels);
      expect(result.matches).toContain('llama3:8b');
      expect(result.matches).toContain('llama3:70b');
      expect(result.matches).toContain('gpt-4o');
      expect(result.matches).toContain('gpt-3.5-turbo');
      expect(result.matches).toHaveLength(4);
    });

    it('should return unique matches even if patterns overlap', () => {
      const models: RecipeModel[] = [
        { kind: 'regex', pattern: 'llama3', flags: ['i'] },
        { kind: 'regex', pattern: 'llama3:8b', flags: ['i'] }
      ];
      const result = getAllMatchingModels(models, availableModels);
      expect(result.matches).toContain('llama3:8b');
      expect(result.matches).toContain('llama3:70b');
      expect(result.matches).toHaveLength(2);
    });
  });

  describe('generateDefaultModelPatterns', () => {
    it('should generate hierarchical patterns for a simple model ID', () => {
      const patterns = generateDefaultModelPatterns('llama3:8b');
      expect(patterns).toContain('^llama3:8b$');
      expect(patterns).toContain('^llama3$');
      expect(patterns).toContain('^llama3:.*');
      expect(patterns).toContain('^llama3.*');
    });

    it('should handle Hugging Face style paths', () => {
      const patterns = generateDefaultModelPatterns('mradermacher/model-GGUF');
      expect(patterns).toContain('^mradermacher/model-GGUF$');
      expect(patterns).toContain('^model-GGUF$');
      expect(patterns).toContain('^model$');
      expect(patterns).toContain('^model.*');
    });

    it('should strip common quantization suffixes', () => {
      const patterns = generateDefaultModelPatterns('bartowski/Llama-3-8B-Instruct-GGUF');
      expect(patterns).toContain('^Llama-3-8B-Instruct$');
      expect(patterns).toContain('^Llama-3-8B-Instruct.*');
    });

    it('should strip Ollama tags and generate prefix matches', () => {
      const patterns = generateDefaultModelPatterns('qwen2.5:7b-instruct-q4_K_M');
      expect(patterns).toContain('^qwen2\\.5$');
      expect(patterns).toContain('^qwen2\\.5:.*');
      expect(patterns).toContain('^qwen2\\.5.*');
    });

    it('should return empty array for empty input', () => {
      expect(generateDefaultModelPatterns('')).toEqual([]);
    });
  });
});
