import type { UiLocale } from '@/strings';

const languages = [
  { value: 'en', native: 'English' }, { value: 'ja', native: '日本語' }, { value: 'zh', native: '中文' },
  { value: 'de', native: 'Deutsch' }, { value: 'it', native: 'Italiano' }, { value: 'pt', native: 'Português' },
  { value: 'es', native: 'Español' }, { value: 'ko', native: '한국어' }, { value: 'fr', native: 'Français' }, { value: 'ru', native: 'Русский' },
] as const;
export type ExplicitAudioLanguage = typeof languages[number]['value'];

/** Locale names come from the app's explicit locale, never the browser locale.
 * Keep self-names as a second cue, but do not repeat the user's own language. */
export function audioLanguageOptions({ locale }: { locale: UiLocale }): { value: ExplicitAudioLanguage, label: string }[] {
  const names = new Intl.DisplayNames([locale], { type: 'language', languageDisplay: 'standard' });
  const ownLanguage = locale.split('-')[0];
  return languages.map(({ value, native }) => {
    const translated = names.of(value) ?? native;
    return { value, label: ownLanguage === value || translated === native ? translated : `${translated} (${native})` };
  });
}

export function defaultAudioLanguage({ locale }: { locale: UiLocale }): ExplicitAudioLanguage {
  const language = locale.split('-')[0];
  return languages.find(entry => entry.value === language)?.value ?? 'en';
}
export const TEST_ONLY = {
};
