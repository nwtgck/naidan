import { DOCS_LOCALES, DOCS_PAGES, docsHref } from './routes';

export const DOCS_ARTICLE_PREFETCH_ATTRIBUTE = 'data-docs-guide-prefetch';

const articleHrefs = new Set(DOCS_LOCALES.flatMap(locale => DOCS_PAGES
  .filter(page => page.id !== 'index')
  .map(page => docsHref({ locale, page: page.id }))));

// Exact root-relative URLs resolve to the current origin, including preview hosts.
export function isDocsArticleHref({ href }: { href: string }): boolean {
  return articleHrefs.has(href);
}
