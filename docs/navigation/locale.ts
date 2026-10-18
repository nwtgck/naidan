import { DOCS_LOCALES } from './routes';
import type { DocsLocale } from './routes';

export function selectDocsLocale({ languages }: { languages: readonly string[] }): DocsLocale {
  for (const language of languages) {
    let code: string;
    try {
      code = new Intl.Locale(language).language;
    } catch {
      continue;
    }
    const supported = DOCS_LOCALES.find(locale => locale === code);
    if (supported) {
      return supported;
    }
  }
  return 'en';
}
