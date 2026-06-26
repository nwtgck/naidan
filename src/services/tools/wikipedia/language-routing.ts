import { KnownWikipediaLanguageCodeSchema } from './schemas';
import type { WikipediaLanguageCode, WikipediaSearchLanguages } from './types';

function hasKana({ text }: { text: string }) {
  return /[\u3040-\u30ff]/u.test(text);
}

function hasHangul({ text }: { text: string }) {
  return /[\uac00-\ud7af]/u.test(text);
}

function hasThai({ text }: { text: string }) {
  return /[\u0e00-\u0e7f]/u.test(text);
}

function hasHebrew({ text }: { text: string }) {
  return /[\u0590-\u05ff]/u.test(text);
}

function hasGreek({ text }: { text: string }) {
  return /[\u0370-\u03ff]/u.test(text);
}

function hasCyrillic({ text }: { text: string }) {
  return /[\u0400-\u04ff]/u.test(text);
}

function hasArabicScript({ text }: { text: string }) {
  return /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/u.test(text);
}

function hasHan({ text }: { text: string }) {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(text);
}

function normalizeSupportedWikipediaLanguage({
  lang,
}: {
  lang: string | undefined,
}): WikipediaLanguageCode | undefined {
  if (lang === undefined) {
    // This currently has no tool-driven callers because wikipedia_search requires lang,
    // but keep the router fallback behavior for future internal use.
    return undefined;
  }

  const normalized = lang.trim().toLowerCase();
  const parsed = KnownWikipediaLanguageCodeSchema.safeParse(normalized);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data;
}

function dedupeLanguages({
  languages,
}: {
  languages: WikipediaLanguageCode[],
}): WikipediaSearchLanguages {
  const deduped: WikipediaLanguageCode[] = [];
  for (const lang of languages) {
    if (!deduped.includes(lang)) {
      deduped.push(lang);
    }
    if (deduped.length === 2) {
      break;
    }
  }

  if (deduped.length === 0) {
    return ['en'];
  }

  if (deduped.length === 1) {
    const first = deduped[0];
    if (first === undefined) {
      return ['en'];
    }
    return [first];
  }

  const first = deduped[0];
  const second = deduped[1];
  if (first === undefined) {
    return ['en'];
  }
  if (second === undefined) {
    return [first];
  }
  return [first, second];
}

export function resolveWikipediaSearchLanguages({
  query,
  contextLanguage,
}: {
  query: string,
  contextLanguage: string | undefined,
}): WikipediaSearchLanguages {
  if (hasKana({ text: query })) return ['ja', 'en'];
  if (hasHangul({ text: query })) return ['ko', 'en'];
  if (hasThai({ text: query })) return ['th', 'en'];
  if (hasHebrew({ text: query })) return ['he', 'en'];
  if (hasGreek({ text: query })) return ['el', 'en'];

  if (hasCyrillic({ text: query })) {
    if (contextLanguage === 'uk') return ['uk', 'en'];
    return ['ru', 'en'];
  }

  if (hasArabicScript({ text: query })) {
    if (contextLanguage === 'fa') return ['fa', 'en'];
    return ['ar', 'en'];
  }

  if (hasHan({ text: query })) {
    if (contextLanguage === 'ja') return ['ja', 'en'];
    if (contextLanguage === 'zh') return ['zh', 'en'];
    if (contextLanguage === 'ko') return ['ko', 'en'];
    return ['zh', 'en'];
  }

  const normalizedContext = normalizeSupportedWikipediaLanguage({
    lang: contextLanguage,
  });

  if (normalizedContext !== undefined && normalizedContext !== 'en') {
    return dedupeLanguages({ languages: [normalizedContext, 'en'] });
  }

  return ['en'];
}
