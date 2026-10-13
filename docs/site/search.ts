import { DOCS_BASE, DOCS_PAGES, docsHref } from './routes';
import type { DocsLocale, DocsPageId } from './routes';

export type SearchEntry = { href: string; title: string; description: string; headings: string[]; paragraphs: string[] };
export type SearchIndex = { locale: DocsLocale; entries: SearchEntry[] };
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

export function searchDocs({ index, query }: { index: SearchIndex; query: string }): SearchResult[] {
  const terms = normalized({ text: query }).split(' ').filter(Boolean);
  if (!terms.length) return [];
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

export function purposeDocs({ index }: { index: SearchIndex }): Pick<SearchResult, 'href' | 'title' | 'snippet'>[] {
  return PURPOSE_PAGES.map(page => {
    const href = docsHref({ locale: index.locale, page });
    const entry = index.entries.find(item => item.href === href);
    if (!entry) throw new Error(`Missing Docs purpose guide: ${href}`);
    return { href, title: entry.title, snippet: entry.description };
  });
}

export function parseSearchIndex({ value, locale }: { value: unknown; locale: DocsLocale }): SearchIndex {
  if (typeof value !== 'object' || value === null || !('locale' in value) || value.locale !== locale
    || !('entries' in value) || !Array.isArray(value.entries)) throw new Error('Invalid Docs search index');
  const validHrefs = new Set(DOCS_PAGES.map(page => docsHref({ locale, page: page.id })));
  const entries: SearchEntry[] = [];
  for (const item of value.entries) {
    if (typeof item !== 'object' || item === null
      || !('href' in item) || typeof item.href !== 'string' || !validHrefs.has(item.href)
      || !('title' in item) || typeof item.title !== 'string'
      || !('description' in item) || typeof item.description !== 'string'
      || !('headings' in item) || !Array.isArray(item.headings) || !item.headings.every((text: unknown) => typeof text === 'string')
      || !('paragraphs' in item) || !Array.isArray(item.paragraphs) || !item.paragraphs.every((text: unknown) => typeof text === 'string')) {
      throw new Error('Invalid Docs search index');
    }
    entries.push({ href: item.href, title: item.title, description: item.description, headings: item.headings as string[], paragraphs: item.paragraphs as string[] });
  }
  if (entries.length !== validHrefs.size || new Set(entries.map(item => item.href)).size !== entries.length) {
    throw new Error('Incomplete Docs search index');
  }
  return { locale, entries };
}
