import { z } from 'zod';

export const KnownWikipediaLanguageCodeSchema = z.enum([
  'en',
  'ja',
  'zh',
  'ko',
  'de',
  'fr',
  'es',
  'it',
  'pt',
  'ru',
  'ar',
  'hi',
  'id',
  'tr',
  'vi',
  'th',
  'pl',
  'nl',
  'uk',
  'he',
  'fa',
  'el',
  'cs',
  'sv',
  'da',
  'fi',
  'no',
  'ro',
  'hu',
]);

export const UnknownWikipediaLanguageCodeSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-z0-9-]+$/i);

export const WikipediaLanguageCodeSchema = z.union([
  KnownWikipediaLanguageCodeSchema,
  UnknownWikipediaLanguageCodeSchema,
]);

export const WikipediaSearchArgsSchema = z.object({
  lang: WikipediaLanguageCodeSchema.describe(
    'Wikipedia language code. Known examples: en, ja, zh, ko, de, fr, es, it, pt, ru, ar, hi, id, tr, vi, th, pl, nl, uk, he. Other Wikipedia language codes are also accepted.',
  ),
  query: z.string().min(1).max(120).describe(
    'Search query for Wikipedia.',
  ),
}).strict();

export const WikipediaGetPageArgsSchema = z.object({
  lang: WikipediaLanguageCodeSchema.describe(
    'Wikipedia language code returned or used by wikipedia_search.',
  ),
  pageId: z.number().int().positive().describe(
    'Wikipedia page ID returned by wikipedia_search.',
  ),
}).strict();

export const MediaWikiSearchItemSchema = z.object({
  ns: z.number(),
  title: z.string(),
  pageid: z.number().int().positive(),
}).passthrough();

export const MediaWikiSearchApiResponseSchema = z.object({
  batchcomplete: z.boolean().optional(),
  continue: z.unknown().optional(),
  query: z.object({
    search: z.array(MediaWikiSearchItemSchema),
  }),
}).passthrough();

export const MediaWikiExtractPageSchema = z.object({
  pageid: z.number().int().positive(),
  ns: z.number(),
  title: z.string(),
  extract: z.string().optional().default(''),
}).passthrough();

export const MediaWikiExtractApiResponseSchema = z.object({
  batchcomplete: z.boolean().optional(),
  query: z.object({
    pages: z.array(MediaWikiExtractPageSchema),
  }),
}).passthrough();

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
