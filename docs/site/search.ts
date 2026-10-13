import { z } from 'zod';
import { DOCS_BASE, DOCS_LOCALES, DOCS_PAGES, docsHref } from './routes';
import type { DocsLocale, DocsPageId } from './routes';

const searchEntrySchema = z.object({
  href: z.string(),
  title: z.string(),
  description: z.string(),
  headings: z.array(z.string()),
  paragraphs: z.array(z.string()),
});
const searchIndexSchema = z.object({ locale: z.enum(DOCS_LOCALES), entries: z.array(searchEntrySchema) });
export type SearchEntry = z.infer<typeof searchEntrySchema>;
export type SearchIndex = z.infer<typeof searchIndexSchema>;
export type SearchResult = SearchEntry & { snippet: string; score: number };
const PURPOSE_PAGES = ['run/standalone', 'models/ollama', 'chat/branching', 'images/create', 'data/backup'] as const satisfies readonly DocsPageId[];

export function searchIndexHref({ locale }: { locale: DocsLocale }): string {
  return `${DOCS_BASE}search-${locale}.json`;
}

function normalized({ text }: { text: string }): string {
  return text.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
}

function snippet({ paragraphs, terms }: { paragraphs: string[]; terms: string[] }): string {
  const paragraph = paragraphs.find(item => terms.some(term => normalized({ text: item }).includes(term))) ?? paragraphs[0] ?? '';
  if (paragraph.length <= 170) return paragraph;
  const start = Math.max(0, normalized({ text: paragraph }).indexOf(terms[0] ?? '') - 45);
  const excerpt = paragraph.slice(start, start + 170).trim();
  return `${start > 0 ? '…' : ''}${excerpt}${start + 170 < paragraph.length ? '…' : ''}`;
}

function rankedMatches({ index, terms }: { index: SearchIndex; terms: string[] }): SearchResult[] {
  return index.entries.flatMap(entry => {
    const title = normalized({ text: entry.title });
    const headings = entry.headings.map(text => normalized({ text }));
    const paragraphs = entry.paragraphs.map(text => normalized({ text }));
    let score = 0;
    for (const term of terms) {
      if (title === term) score += 100;
      else if (title.includes(term)) score += 35;
      else if (headings.some(text => text.includes(term))) score += 16;
      else if (paragraphs.some(text => text.includes(term))) score += 3;
      else return [];
    }
    return [{ ...entry, score, snippet: snippet({ paragraphs: entry.paragraphs, terms }) }];
  }).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

function japaneseIntentTerms({ query }: { query: string }): string[] | undefined {
  const sentence = query.replace(/[。！？!?]+$/u, '').replace(/です$/u, '');
  if (!sentence.endsWith('たい')) return undefined;
  return sentence.split(/[をがはにでへと\s]+/u).filter(Boolean).map(clause => {
    if (clause === 'たい' || clause === 'したい') return '';
    return clause.endsWith('したい') && clause.length > 4 ? clause.slice(0, -3) : clause;
  }).filter(Boolean);
}

function hasProminentTerm({ entry, term }: { entry: SearchEntry; term: string }): boolean {
  return normalized({ text: entry.title }).includes(term)
    || entry.headings.some(heading => normalized({ text: heading }).includes(term));
}

export function searchDocs({ index, query }: { index: SearchIndex; query: string }): SearchResult[] {
  const text = normalized({ text: query });
  const terms = text.split(' ').filter(Boolean);
  if (!terms.length) return [];
  const intentTerms = (() => {
    switch (index.locale) {
    case 'ja': return japaneseIntentTerms({ query: text });
    case 'en': return undefined;
    default: {
      const unreachable: never = index.locale;
      throw new Error(`Unsupported Docs search locale: ${unreachable}`);
    }
    }
  })();
  if (intentTerms !== undefined && (!intentTerms[0] || intentTerms[0].length < 2)) return [];
  const exact = rankedMatches({ index, terms });
  if (exact.length || intentTerms === undefined) return exact;
  const head = intentTerms[0];
  if (!head) return [];
  const matches = rankedMatches({ index, terms: intentTerms }).filter(entry => hasProminentTerm({ entry, term: head }));
  if (matches.length) return matches.slice(0, 5);
  if (head.length < 3) return [];
  return rankedMatches({ index, terms: [head] }).filter(entry => hasProminentTerm({ entry, term: head })).slice(0, 5);
}

export function purposeDocs({ index }: { index: SearchIndex }): Pick<SearchResult, 'href' | 'title' | 'snippet'>[] {
  return PURPOSE_PAGES.map(page => {
    const href = docsHref({ locale: index.locale, page });
    const entry = index.entries.find(item => item.href === href);
    if (!entry) throw new Error(`Missing Docs purpose guide: ${href}`);
    return { href, title: entry.title, snippet: entry.description };
  });
}

export function parseSearchIndex({ value, locale }: { value: unknown; locale: DocsLocale }): SearchIndex {
  const index = searchIndexSchema.refine(candidate => candidate.locale === locale).parse(value);
  const validHrefs = new Set(DOCS_PAGES.map(page => docsHref({ locale, page: page.id })));
  if (index.entries.some(item => !validHrefs.has(item.href))) throw new Error('Invalid Docs search index href');
  if (index.entries.length !== validHrefs.size || new Set(index.entries.map(item => item.href)).size !== index.entries.length) {
    throw new Error('Incomplete Docs search index');
  }
  return index;
}
