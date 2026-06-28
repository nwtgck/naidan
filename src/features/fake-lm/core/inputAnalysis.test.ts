import { describe, expect, it } from 'vitest';

import { analyzeFakeLmInputFromMessages, analyzeFakeLmInputText } from '@/features/fake-lm/core/inputAnalysis';
import { generateFakeLmMarkdown } from '@/features/fake-lm/core/generate';

describe('analyzeFakeLmInputText', () => {
  it('extracts short deterministic keywords without keeping the full user sentence', () => {
    const analysis = analyzeFakeLmInputText({
      text: 'bundleサイズの増加を見積もって、highを短くして',
    });

    expect(analysis.toneScores.request).toBeGreaterThan(0);
    expect(analysis.toneScores.technical).toBeGreaterThan(0);
    expect(analysis.keywords.map((keyword) => keyword.text)).toEqual(expect.arrayContaining(['bundleサイズ', '増加', 'high']));
    expect(analysis.keywords.some((keyword) => keyword.text.includes('見積もって、highを短くして'))).toBe(false);
  });

  it('treats greetings as a soft tone hint instead of an echoed keyword requirement', () => {
    const analysis = analyzeFakeLmInputText({ text: 'こんにちは' });

    expect(analysis.toneScores.greeting).toBe(1);
    expect(analysis.greeting).toBe('generic');
    expect(analysis.toneScores.request).toBe(0);
    expect(analysis.keywords).toEqual([]);
  });

  it('uses only the last user message for runtime hints', () => {
    const analysis = analyzeFakeLmInputFromMessages({
      messages: [
        { role: 'user', content: '田植え 時期' },
        { role: 'assistant', content: 'old' },
        { role: 'user', content: 'JSON構造を整理して' },
      ],
    });

    const keywordTexts = analysis.keywords.map((keyword) => keyword.text);
    expect(keywordTexts.some((keyword) => keyword.startsWith('JSON'))).toBe(true);
    expect(keywordTexts).not.toContain('田植え');
  });
});

describe('fake LM generation input influence', () => {
  it('keeps the same request deterministic while mixing in a short input keyword', async () => {
    const inputAnalysis = analyzeFakeLmInputText({ text: 'bundleサイズの増加を見積もって' });
    const base = {
      language: 'ja' as const,
      mode: 'chat' as const,
      seed: 1234,
      thinkingEffort: 'off' as const,
      inputAnalysis,
      signal: undefined,
    };

    const first = await generateFakeLmMarkdown(base);
    const second = await generateFakeLmMarkdown(base);

    expect(second).toBe(first);
    expect(first).toMatch(/bundleサイズ|増加/u);
    expect(first).not.toContain('bundleサイズの増加を見積もって');
  });

  it('starts greeting-like when the last user message is a short greeting', async () => {
    const markdown = await generateFakeLmMarkdown({
      language: 'ja',
      mode: 'chat',
      seed: 2,
      thinkingEffort: 'off',
      inputAnalysis: analyzeFakeLmInputText({ text: 'こんにちは' }),
      signal: undefined,
    });

    expect(markdown).toMatch(/^こんにちは。/u);
  });

  it('normalizes a morning greeting without echoing the full input text', async () => {
    const markdown = await generateFakeLmMarkdown({
      language: 'ja',
      mode: 'chat',
      seed: 2,
      thinkingEffort: 'off',
      inputAnalysis: analyzeFakeLmInputText({ text: 'おはよう〜' }),
      signal: undefined,
    });

    expect(markdown).toMatch(/^おはようございます。/u);
    expect(markdown).not.toContain('おはよう〜');
  });
});
