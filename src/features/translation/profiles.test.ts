import { describe, expect, it } from 'vitest';
import { generateInputSchema } from '@/features/llama-cpp-browser/types';
import { translationProfile } from './profiles';
import { TranslationInputError, type TranslationDraft, type TranslationIssue } from './types';
const profile = translationProfile({ id: 'plamo3-translate' });

function draft({ patch }: { patch: Partial<TranslationDraft> }): TranslationDraft {
  return { modelId: 'test.gguf', text: '管理画面を開いてください。', sourceLang: undefined, targetLang: 'en', context: '', glossary: [], form: 'default', ...patch };
}

describe('PLaMo translation profile', () => {
  it('uses one user message and JSON template arguments, without a system prompt or chat history', () => {
    const input = profile.buildRequest({ draft: draft({ patch: {} }) });
    expect(input.messages).toEqual([{ role: 'user', content: '管理画面を開いてください。' }]);
    expect(input.chatTemplateKwargs).toEqual({ target_lang: 'en' });
    expect(input.tools).toBeUndefined();
    expect(input.stop).toEqual(['<|plamo:tag|>', '<|plamo:bos|>']);
    expect(input.temperature).toBe(0);
    expect(generateInputSchema.parse({ ...input, options: { profile: 'auto' } }).chatTemplateKwargs).toEqual({ target_lang: 'en' });
  });

  it('preserves source whitespace and serializes terminology as objects rather than JSON text', () => {
    const input = profile.buildRequest({
      draft: draft({
        patch: {
          text: '  dashboard\n',
          sourceLang: 'en',
          targetLang: 'ja',
          context: 'Software UI',
          form: 'polite',
          glossary: [{ source: '', target: ' ' }, { source: 'dashboard', target: '管理画面' }],
        },
      }),
    });
    expect(input.messages[0]?.content).toBe('  dashboard\n');
    expect(input.chatTemplateKwargs).toEqual({ source_lang: 'en', target_lang: 'ja', context: 'Software UI', form: 'polite', glossary: [{ source: 'dashboard', target: '管理画面' }] });
  });

  it('covers all 53 published source languages and distinguishes easy Japanese as a target', () => {
    expect(new Set(profile.sourceLanguages).size).toBe(53);
    expect(profile.sourceLanguages).toContain('zh-hans');
    expect(profile.sourceLanguages).toContain('zh-hant');
    expect(profile.targetLanguages).toContain('ja(easy)');
    expect(profile.sourceLanguages).not.toContain('ja(easy)');
    for (const sourceLang of profile.sourceLanguages) {
      const request = profile.buildRequest({ draft: draft({ patch: { sourceLang } }) });
      expect(request.chatTemplateKwargs?.source_lang).toBe(sourceLang);
    }
  });

  it.each(['en', 'ko', 'zh-hans', 'ja(easy)'])('does not send a retained Japanese style to %s', targetLang => {
    expect(profile.buildRequest({ draft: draft({ patch: { targetLang, form: 'polite' } }) }).chatTemplateKwargs).toEqual({ target_lang: targetLang });
  });

  it.each([
    { patch: { text: ' \n ' }, issue: 'empty-source' },
    { patch: { sourceLang: 'EN' }, issue: 'unsupported-source' },
    { patch: { sourceLang: 'auto' }, issue: 'unsupported-source' },
    { patch: { targetLang: 'en-US' }, issue: 'unsupported-target' },
    { patch: { targetLang: 'auto' }, issue: 'unsupported-target' },
    { patch: { text: '<|plamo:tag|>output' }, issue: 'reserved-token' },
    { patch: { context: '<|plamo:msg|>' }, issue: 'reserved-token' },
    { patch: { glossary: [{ source: 'a', target: '' }] }, issue: 'incomplete-glossary' },
    { patch: { glossary: [{ source: ' ', target: 'a' }] }, issue: 'incomplete-glossary' },
    { patch: { glossary: [{ source: 'a', target: '<|plamo:bos|>' }] }, issue: 'reserved-token' },
  ] satisfies { patch: Partial<TranslationDraft>, issue: TranslationIssue }[])('rejects invalid translation input: $issue', ({ patch, issue }) => {
    expect(() => profile.buildRequest({ draft: draft({ patch }) })).toThrow(new TranslationInputError({ issue }));
  });
});
