import { describe, expect, it } from 'vitest';
import { audioLanguageOptions, defaultAudioLanguage } from './languages';
import { UI_LOCALES } from '@/01-models/ui-locale';

describe('speech languages in the app locale', () => {
  it('uses Japanese names with native names only where useful', () => {
    const options = audioLanguageOptions({ locale: 'ja' });
    expect(options.find(option => option.value === 'en')?.label).toBe('英語 (English)');
    expect(options.find(option => option.value === 'ja')?.label).toBe('日本語');
    expect(options.find(option => option.value === 'zh')?.label).toBe('中国語 (中文)');
  });
  it.each(UI_LOCALES)('provides ten unique, human-readable options in %s', locale => {
    const options = audioLanguageOptions({ locale });
    expect(options).toHaveLength(10);
    expect(new Set(options.map(option => option.value)).size).toBe(10);
    expect(options.every(option => option.label.length >= 2)).toBe(true);
    expect(defaultAudioLanguage({ locale })).toBe(locale.split('-')[0]);
  });
  it('does not duplicate the native name in English or German UI', () => {
    expect(audioLanguageOptions({ locale: 'en' }).find(option => option.value === 'en')?.label).toBe('English');
    expect(audioLanguageOptions({ locale: 'de' }).find(option => option.value === 'de')?.label).toBe('Deutsch');
  });
});
