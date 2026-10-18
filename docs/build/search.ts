import { JSDOM } from 'jsdom';
import { DOCS_PAGES, docsHref } from '../navigation/routes';
import type { DocsLocale } from '../navigation/routes';
import type { RenderedPage } from './contracts';
import type { SearchEntry, SearchIndex } from '../search/search';

function cleanText({ element }: { element: Element }): string {
  return (element.textContent ?? '').replace(/\s+/gu, ' ').trim();
}

export function searchEntry({ page }: { page: RenderedPage }): SearchEntry {
  const fragment = JSDOM.fragment(page.body);
  const main = fragment.querySelector('#docs-main');
  if (!main) {
    throw new Error(`Missing search content for ${page.locale}/${page.page}`);
  }
  const selectors = main.querySelector('article.prose')
    ? 'article.prose'
    : '.hero-copy, .how-heading-row, .mechanism-list, .boundary-footnote, .browser-generation-copy, .models-section, .standalone-section > div:first-child, .storage-copy, #guides .section-top';
  const containers = [...main.querySelectorAll(selectors)];
  if (!containers.length) {
    throw new Error(`Missing search prose for ${page.locale}/${page.page}`);
  }
  const nodes = containers.flatMap(container => [...container.querySelectorAll('h1,h2,h3,p,li')]);
  const prose = nodes.filter(element => !element.closest('figure,[data-docs-island],[data-docs-animation],[data-docs-related-guide]'));
  const headings = prose.filter(element => /^H[1-3]$/u.test(element.tagName)).map(element => cleanText({ element })).filter(Boolean);
  const paragraphs = prose.filter(element => ['P', 'LI'].includes(element.tagName)).map(element => cleanText({ element })).filter(Boolean);
  if (!headings.length || !paragraphs.length) {
    throw new Error(`Empty search prose for ${page.locale}/${page.page}`);
  }
  return { href: docsHref({ locale: page.locale, page: page.page }), title: page.title, description: page.description, headings, paragraphs };
}

export function createSearchIndex({ locale, pages }: { locale: DocsLocale; pages: Map<string, RenderedPage> }): SearchIndex {
  const entries = DOCS_PAGES.map(page => {
    const href = docsHref({ locale, page: page.id });
    const rendered = pages.get(href);
    if (!rendered || rendered.locale !== locale || rendered.page !== page.id) {
      throw new Error(`Missing search page ${href}`);
    }
    return searchEntry({ page: rendered });
  });
  return { locale, entries };
}
