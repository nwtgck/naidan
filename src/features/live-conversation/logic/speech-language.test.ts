import { describe, expect, it } from 'vitest';
import { defaultLiveSpeechLanguage, liveSpeechLanguageOptions } from './speech-language';

describe('continuous conversation language', () => {
  it.each([
    ['en', 'en'], ['ja', 'ja'], ['de', 'de'], ['es', 'es'],
    ['ko', 'ko'], ['pt-BR', 'pt'], ['zh-Hans', 'zh'],
  ] as const)('initializes %s display locale to %s without restricting the selection', (locale, language) => {
    expect(defaultLiveSpeechLanguage({ locale })).toBe(language);
  });

  it('offers all native dialogue languages with localized names', () => {
    const choices = liveSpeechLanguageOptions({ locale: 'ja' });
    expect(choices.map(choice => choice.value)).toEqual(['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh']);
    expect(choices.find(choice => choice.value === 'fr')?.label).toBe('フランス語');
  });
});
