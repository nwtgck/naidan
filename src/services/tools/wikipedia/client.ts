import { resolveWikipediaSearchLanguages } from './language-routing';
import { privacyFetchJson } from '@/services/privacy-fetch';
import {
  MediaWikiExtractApiResponseSchema,
  MediaWikiSearchApiResponseSchema,
} from './schemas';
import {
  countLines,
  saveWikipediaPageTextAsBinaryObject,
  WIKIPEDIA_INLINE_CONTENT_MAX_LINES,
} from './binary-object'
import type {
  WikipediaLanguageCode,
  WikipediaPageResult,
  WikipediaSearchGroup,
  WikipediaSearchResult,
} from './types';

export const WIKIPEDIA_SEARCH_LIMIT = 30;

type RequestWikipediaJsonImpl = ({
  url,
  signal,
}: {
  url: URL;
  signal: AbortSignal | undefined;
}) => Promise<unknown>

function createWikipediaApiUrl({ lang }: { lang: string }) {
  return new URL(`https://${lang}.wikipedia.org/w/api.php`);
}

async function requestWikipediaJson({
  url,
  signal,
}: {
  url: URL;
  signal: AbortSignal | undefined;
}): Promise<unknown> {
  try {
    return await privacyFetchJson({
      url: url.toString(),
      signal,
      timeoutMs: undefined,
    });
  } catch (error) {
    throw new Error(`Wikipedia request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function searchWikipediaLanguage({
  lang,
  query,
  signal,
  requestJsonImpl,
}: {
  lang: WikipediaLanguageCode;
  query: string;
  signal: AbortSignal | undefined;
  requestJsonImpl: RequestWikipediaJsonImpl | undefined;
}): Promise<WikipediaSearchGroup> {
  const url = createWikipediaApiUrl({ lang });
  url.searchParams.set('origin', '*');
  url.searchParams.set('action', 'query');
  url.searchParams.set('format', 'json');
  url.searchParams.set('formatversion', '2');
  url.searchParams.set('list', 'search');
  url.searchParams.set('srsearch', query);
  url.searchParams.set('srlimit', String(WIKIPEDIA_SEARCH_LIMIT));
  url.searchParams.set('srnamespace', '0');
  url.searchParams.set('srprop', '');
  url.searchParams.set('srinfo', '');

  const raw = await (requestJsonImpl ?? requestWikipediaJson)({
    url,
    signal,
  });
  const parsed = MediaWikiSearchApiResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Wikipedia search response validation failed: ${parsed.error.message}`);
  }

  return {
    lang,
    items: parsed.data.query.search.map((item) => ({
      title: item.title,
      pageId: item.pageid,
    })),
  };
}

export async function searchWikipedia({
  lang,
  query,
  contextLanguage,
  signal,
  requestJsonImpl,
}: {
  lang: string | undefined;
  query: string;
  contextLanguage: string | undefined;
  signal: AbortSignal | undefined;
  requestJsonImpl: RequestWikipediaJsonImpl | undefined;
}): Promise<WikipediaSearchResult> {
  // Tools currently require lang explicitly, so the undefined branch is unused today.
  // Keep the internal router fallback for future call sites that may want heuristic language selection.
  const languages = lang !== undefined
    ? [lang]
    : resolveWikipediaSearchLanguages({
      query,
      contextLanguage,
    }).filter((value): value is string => value !== undefined);

  const groups: WikipediaSearchGroup[] = [];
  for (const searchLang of languages) {
    groups.push(await searchWikipediaLanguage({
      lang: searchLang,
      query,
      signal,
      requestJsonImpl,
    }));
  }

  return { groups };
}

export async function getWikipediaPage({
  lang,
  pageId,
  signal,
  requestJsonImpl,
}: {
  lang: string;
  pageId: number;
  signal: AbortSignal | undefined;
  requestJsonImpl: RequestWikipediaJsonImpl | undefined;
}): Promise<WikipediaPageResult> {
  const url = createWikipediaApiUrl({ lang });
  url.searchParams.set('origin', '*');
  url.searchParams.set('action', 'query');
  url.searchParams.set('format', 'json');
  url.searchParams.set('formatversion', '2');
  url.searchParams.set('prop', 'extracts');
  url.searchParams.set('explaintext', '1');
  url.searchParams.set('exsectionformat', 'plain');
  url.searchParams.set('pageids', String(pageId));

  const raw = await (requestJsonImpl ?? requestWikipediaJson)({
    url,
    signal,
  });
  const parsed = MediaWikiExtractApiResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Wikipedia page response validation failed: ${parsed.error.message}`);
  }

  const page = parsed.data.query.pages.find((item) => item.pageid === pageId);
  if (page === undefined) {
    throw new Error(`Wikipedia page not found for pageId ${pageId}`);
  }

  const content = page.extract
  const lineCount = countLines({ text: content })
  if (lineCount <= WIKIPEDIA_INLINE_CONTENT_MAX_LINES) {
    return {
      kind: 'inline',
      lang,
      pageId: page.pageid,
      title: page.title,
      content,
    }
  }

  const saved = await saveWikipediaPageTextAsBinaryObject({
    lang,
    pageId: page.pageid,
    title: page.title,
    content,
    lineCount,
  })

  return {
    kind: 'binary_object',
    lang,
    pageId: page.pageid,
    title: page.title,
    lineCount: saved.lineCount,
    byteLength: saved.byteLength,
    sysfsNaidanDataFilePath: saved.sysfsNaidanDataFilePath,
  }
}
