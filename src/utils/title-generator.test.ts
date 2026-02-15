import { describe, it, expect } from 'vitest';
import { detectLanguage, getTitleSystemPrompt, cleanGeneratedTitle } from './title-generator';

describe('title-generator utilities', () => {
  describe('detectLanguage', () => {
    it('detects Japanese (Hiragana/Katakana)', () => {
      expect(detectLanguage({ content: 'こんにちは、元気ですか？' })).toBe('ja');
      expect(detectLanguage({ content: 'プログラミングの相談' })).toBe('ja');
    });

    it('detects Korean (Hangul)', () => {
      expect(detectLanguage({ content: '안녕하세요, 어떻게 지내세요?' })).toBe('ko');
    });

    it('detects Russian (Cyrillic)', () => {
      expect(detectLanguage({ content: 'Привет, как дела?' })).toBe('ru');
    });

    it('detects Arabic', () => {
      expect(detectLanguage({ content: 'مرحبا، كيف حالك؟' })).toBe('ar');
    });

    it('detects Hindi', () => {
      expect(detectLanguage({ content: 'नमस्ते, आप कैसे हैं?' })).toBe('hi');
    });

    it('detects Thai', () => {
      expect(detectLanguage({ content: 'สวัสดีครับ เป็นอย่างไรบ้าง?' })).toBe('th');
    });

    it('detects Chinese (Hanzi) and handles priority over Japanese', () => {
      // Pure Hanzi
      expect(detectLanguage({ content: '你好，最近怎么样？' })).toBe('zh');
      // Mixed Japanese (should be ja)
      expect(detectLanguage({ content: '今日は良い天気ですね。' })).toBe('ja');
    });

    it('handles mixed languages with script priority', () => {
      // English + Japanese
      expect(detectLanguage({ content: 'How to fix this error? このエラーの直し方は？' })).toBe('ja');

      // Russian + English
      expect(detectLanguage({ content: 'Explain the concept of "Recursion" in Russian (Пожалуйста, объясните рекурсию)' })).toBe('ru');

      // Mostly English, but with a Japanese particle at the end
      expect(detectLanguage({ content: 'This is a very long sentence in English but it ends with a Japanese particle ね' })).toBe('ja');
    });

    it('falls back to browser language if no specific script is detected', () => {
      expect(detectLanguage({ content: 'Hello, how are you?', fallbackLanguage: 'fr-FR' })).toBe('fr');
      expect(detectLanguage({ content: 'Hola, ¿cómo estás?', fallbackLanguage: 'es-ES' })).toBe('es');
    });

    it('defaults to English if detection and fallback fail', () => {
      expect(detectLanguage({ content: '1234567890', fallbackLanguage: 'unknown' })).toBe('en');
    });
  });

  describe('getTitleSystemPrompt', () => {
    it('returns the correct prompt for supported languages', () => {
      const jaPrompt = getTitleSystemPrompt('ja');
      expect(jaPrompt).toContain('主題');
      expect(jaPrompt).toContain('15文字以内');

      const enPrompt = getTitleSystemPrompt('en');
      expect(enPrompt).toContain('main topic');
      expect(enPrompt).toContain('3-5 words');
    });

    it('falls back to English for unsupported languages', () => {
      // @ts-expect-error testing fallback
      expect(getTitleSystemPrompt('unknown')).toBe(getTitleSystemPrompt('en'));
    });
  });

  describe('cleanGeneratedTitle', () => {
    it('removes surrounding quotes', () => {
      expect(cleanGeneratedTitle('"My Awesome Title"')).toBe('My Awesome Title');
      expect(cleanGeneratedTitle("'Single Quotes'")).toBe('Single Quotes');
    });

    it('removes common prefixes', () => {
      expect(cleanGeneratedTitle('Title: Hello World')).toBe('Hello World');
      expect(cleanGeneratedTitle('Topic: Vue.js Tips')).toBe('Vue.js Tips');
      expect(cleanGeneratedTitle('タイトル：今日の天気')).toBe('今日の天気');
      expect(cleanGeneratedTitle('Subject: Refactoring Plan')).toBe('Refactoring Plan');
    });

    it('trims whitespace', () => {
      expect(cleanGeneratedTitle('   Messy Title   ')).toBe('Messy Title');
    });

    it('handles mixed cleaning', () => {
      expect(cleanGeneratedTitle(' "Title: Mixed Cleanup" ')).toBe('Mixed Cleanup');
    });

    it('removes thinking tags and content', () => {
      expect(cleanGeneratedTitle('<think>Thinking about a title...</think>Final Title')).toBe('Final Title');
      expect(cleanGeneratedTitle('<think>Wrapped</think>')).toBe('');
      expect(cleanGeneratedTitle('Title with <think>some</think> thoughts')).toBe('Title with thoughts');
    });
  });
});
