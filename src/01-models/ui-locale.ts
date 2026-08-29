export const UI_LOCALES = ['en', 'ja', 'zh-Hans', 'pt-BR', 'es', 'ko', 'de'] as const;

export type UiLocale = (typeof UI_LOCALES)[number];

export function parseUiLocale({ value }: {
  value: string;
}): UiLocale | undefined {
  return UI_LOCALES.find(locale => locale === value);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
