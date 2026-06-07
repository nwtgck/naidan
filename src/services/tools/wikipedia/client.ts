import { resolveWikipediaSearchLanguages } from './language-routing';
import {
  MediaWikiExtractApiResponseSchema,
  MediaWikiSearchApiResponseSchema,
} from './schemas';
import type {
  WikipediaLanguageCode,
  WikipediaPageResult,
  WikipediaSearchGroup,
  WikipediaSearchResult,
} from './types';

function createWikipediaApiUrl({ lang }: { lang: string }) {
  return new URL(`https://${lang}.wikipedia.org/w/api.php`);
}

function normalizeWikipediaExtractText({
  text,
}: {
  text: string;
}): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchWikipediaJson({
  url,
  signal,
  fetchImpl,
}: {
  url: URL;
  signal: AbortSignal | undefined;
  fetchImpl: typeof fetch;
}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      credentials: 'omit',
      signal,
    });
  } catch (error) {
    throw new Error(`Wikipedia request failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response.ok) {
    throw new Error(`Wikipedia request failed with status ${response.status}`);
  }

  return response.json();
}

async function searchWikipediaLanguage({
  lang,
  query,
  signal,
  fetchImpl,
}: {
  lang: WikipediaLanguageCode;
  query: string;
  signal: AbortSignal | undefined;
  fetchImpl: typeof fetch;
}): Promise<WikipediaSearchGroup> {
  const url = createWikipediaApiUrl({ lang });
  url.searchParams.set('origin', '*');
  url.searchParams.set('action', 'query');
  url.searchParams.set('format', 'json');
  url.searchParams.set('formatversion', '2');
  url.searchParams.set('list', 'search');
  url.searchParams.set('srsearch', query);
  url.searchParams.set('srlimit', '5');
  url.searchParams.set('srnamespace', '0');
  url.searchParams.set('srprop', '');
  url.searchParams.set('srinfo', '');

  const raw = await fetchWikipediaJson({
    url,
    signal,
    fetchImpl,
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
  fetchImpl,
}: {
  lang: string | undefined;
  query: string;
  contextLanguage: string | undefined;
  signal: AbortSignal | undefined;
  fetchImpl: typeof fetch;
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
      fetchImpl,
    }));
  }

  return { groups };
}

export async function getWikipediaPage({
  lang,
  pageId,
  signal,
  fetchImpl,
}: {
  lang: string;
  pageId: number;
  signal: AbortSignal | undefined;
  fetchImpl: typeof fetch;
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

  const raw = await fetchWikipediaJson({
    url,
    signal,
    fetchImpl,
  });
  const parsed = MediaWikiExtractApiResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Wikipedia page response validation failed: ${parsed.error.message}`);
  }

  const page = parsed.data.query.pages.find((item) => item.pageid === pageId);
  if (page === undefined) {
    throw new Error(`Wikipedia page not found for pageId ${pageId}`);
  }

  return {
    lang,
    pageId: page.pageid,
    title: page.title,
    content: normalizeWikipediaExtractText({ text: page.extract }),
  };
}
