import { speechDialogueLanguages } from '@/features/speech-cpp-browser/types';
import type { UiLocale } from '@/strings';

export function defaultLiveSpeechLanguage({ locale }: { locale: UiLocale }): string {
  const language = locale.split('-')[0];
  return speechDialogueLanguages.find(value => value === language) ?? 'en';
}

export function liveSpeechLanguageOptions({ locale }: { locale: UiLocale }): { value: string, label: string }[] {
  const names = new Intl.DisplayNames([locale], { type: 'language', languageDisplay: 'standard' });
  return speechDialogueLanguages.map(value => ({ value, label: names.of(value) ?? value }));
}

export const TEST_ONLY = {
};
