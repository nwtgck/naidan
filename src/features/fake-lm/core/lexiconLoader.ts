import { z } from 'zod';
import type { FakeLmLanguage } from '@/features/fake-lm/core/markdownTypes';
import type { TextPattern } from '@/features/fake-lm/core/textPattern';
import type { WeightedValue } from '@/features/fake-lm/core/weighted';

const WeightedTextSchema = z.object({
  value: z.string(),
  weight: z.number().positive(),
}).strict();

const ToneAffinitySchema = z.object({
  greeting: z.number().min(0).max(1).optional(),
  question: z.number().min(0).max(1).optional(),
  request: z.number().min(0).max(1).optional(),
  technical: z.number().min(0).max(1).optional(),
}).strict();

const TextPatternPartSchema = z.union([
  z.string(),
  z.object({
    slot: z.enum([
      'nounPhrase',
      'abstractNoun',
      'physicalNoun',
      'livingNoun',
      'timeNoun',
      'normalAdjective',
      'wrongAdjective',
      'connector',
      'inputKeyword',
      'inputKeywordPhrase',
      'inputReference',
      'inputGreeting',
    ]),
  }).strict(),
]);

const TextPatternSchema = z.object({
  weight: z.number().positive(),
  affinity: ToneAffinitySchema.optional(),
  requires: z.array(z.enum(['inputKeyword', 'inputGreeting'])).optional(),
  parts: z.array(TextPatternPartSchema).min(1),
  containsNotAlways: z.boolean().optional(),
}).strict();

const NounsLexiconFileSchema = z.object({
  abstractNouns: z.array(WeightedTextSchema).min(1),
  physicalNouns: z.array(WeightedTextSchema).min(1),
  livingNouns: z.array(WeightedTextSchema).min(1),
  timeNouns: z.array(WeightedTextSchema).min(1),
}).strict();

const PhrasesLexiconFileSchema = z.object({
  normalAdjectives: z.array(WeightedTextSchema).min(1),
  wrongAdjectives: z.array(WeightedTextSchema).min(1),
  plainVerbs: z.array(WeightedTextSchema).min(1),
  softVerbs: z.array(WeightedTextSchema).min(1),
  headings: z.array(WeightedTextSchema).min(1),
  tableCells: z.array(WeightedTextSchema).min(1),
  listItems: z.array(WeightedTextSchema).min(1),
}).strict();

const TransitionsLexiconFileSchema = z.object({
  connectors: z.array(WeightedTextSchema).min(1),
}).strict();

const InputReferencesLexiconFileSchema = z.object({
  inputReferences: z.array(WeightedTextSchema).min(1),
}).strict();

const PatternSectionFileSchema = z.object({
  items: z.array(TextPatternSchema).min(1),
}).strict();

const LanguageJsonSchema = z.object({
  lexicons: z.object({
    nouns: NounsLexiconFileSchema,
    phrases: PhrasesLexiconFileSchema,
    transitions: TransitionsLexiconFileSchema,
    inputReferences: InputReferencesLexiconFileSchema,
  }).strict(),
  patterns: z.object({
    openings: PatternSectionFileSchema,
    bodySentences: PatternSectionFileSchema,
    thinkingSentences: PatternSectionFileSchema,
    closings: PatternSectionFileSchema,
  }).strict(),
}).strict();

type LanguageJson = z.infer<typeof LanguageJsonSchema>;

type FakeLmLanguageJsonModule = {
  fakeLmLanguageJson: unknown,
};

export type LoadedLexicons = {
  abstractNouns: WeightedValue<string>[],
  physicalNouns: WeightedValue<string>[],
  livingNouns: WeightedValue<string>[],
  timeNouns: WeightedValue<string>[],
  normalAdjectives: WeightedValue<string>[],
  wrongAdjectives: WeightedValue<string>[],
  plainVerbs: WeightedValue<string>[],
  softVerbs: WeightedValue<string>[],
  connectors: WeightedValue<string>[],
  headings: WeightedValue<string>[],
  tableCells: WeightedValue<string>[],
  listItems: WeightedValue<string>[],
  inputReferences: WeightedValue<string>[],
  openingPatterns: TextPattern[],
  bodySentencePatterns: TextPattern[],
  thinkingSentencePatterns: TextPattern[],
  closingPatterns: TextPattern[],
};

const fakeLmLanguageJsonLoaders = {
  ja: () => import('@/features/fake-lm/languages/ja'),
  en: () => import('@/features/fake-lm/languages/en'),
} satisfies Record<FakeLmLanguage, () => Promise<FakeLmLanguageJsonModule>>;

const languagePackCache = new Map<FakeLmLanguage, Promise<LoadedLexicons>>();

export async function preloadFakeLmLanguagePacks(): Promise<void> {
  await Promise.all([
    loadLanguageLexicons({ language: 'ja' }),
    loadLanguageLexicons({ language: 'en' }),
  ]);
}

export async function loadLanguageLexicons({ language }: {
  language: FakeLmLanguage,
}): Promise<LoadedLexicons> {
  const cached = languagePackCache.get(language);
  if (cached !== undefined) {
    return cached;
  }

  const promise = loadAndParseLanguageLexicons({ language });
  languagePackCache.set(language, promise);
  try {
    return await promise;
  } catch (error) {
    if (languagePackCache.get(language) === promise) {
      languagePackCache.delete(language);
    }
    throw error;
  }
}

async function loadAndParseLanguageLexicons({ language }: {
  language: FakeLmLanguage,
}): Promise<LoadedLexicons> {
  const loader = fakeLmLanguageJsonLoaders[language];
  const module = await loader();
  const languageJson = LanguageJsonSchema.parse(module.fakeLmLanguageJson);
  return toLoadedLexicons({ languageJson });
}

function toLoadedLexicons({ languageJson }: {
  languageJson: LanguageJson,
}): LoadedLexicons {
  return {
    abstractNouns: languageJson.lexicons.nouns.abstractNouns,
    physicalNouns: languageJson.lexicons.nouns.physicalNouns,
    livingNouns: languageJson.lexicons.nouns.livingNouns,
    timeNouns: languageJson.lexicons.nouns.timeNouns,
    normalAdjectives: languageJson.lexicons.phrases.normalAdjectives,
    wrongAdjectives: languageJson.lexicons.phrases.wrongAdjectives,
    plainVerbs: languageJson.lexicons.phrases.plainVerbs,
    softVerbs: languageJson.lexicons.phrases.softVerbs,
    connectors: languageJson.lexicons.transitions.connectors,
    headings: languageJson.lexicons.phrases.headings,
    tableCells: languageJson.lexicons.phrases.tableCells,
    listItems: languageJson.lexicons.phrases.listItems,
    inputReferences: languageJson.lexicons.inputReferences.inputReferences,
    openingPatterns: languageJson.patterns.openings.items,
    bodySentencePatterns: languageJson.patterns.bodySentences.items,
    thinkingSentencePatterns: languageJson.patterns.thinkingSentences.items,
    closingPatterns: languageJson.patterns.closings.items,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
