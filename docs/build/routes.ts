import { DOCS_BASE, DOCS_LOCALES, DOCS_PAGES, docsHref } from '../navigation/routes';
import type { DocsLocale, DocsPageId } from '../navigation/routes';

export type DocsRoute =
  | { kind: 'outside' }
  | { kind: 'asset' }
  | { kind: 'bootstrap' }
  | { kind: 'sitemap' }
  | { kind: 'search-index'; locale: DocsLocale }
  | { kind: 'invalid' }
  | { kind: 'missing' }
  | { kind: 'redirect'; location: string }
  | { kind: 'root' }
  | { kind: 'page'; locale: DocsLocale; page: DocsPageId };

const requestOrigin = 'http://naidan-docs.invalid';
const devDirectories = ['/@', '/assets/', '/client/', '/components/', '/islands/', '/messages/', '/navigation/', '/pages/', '/search/', '/styles/', '/node_modules/'];

export function resolveDocsRoute({ requestUrl }: { requestUrl: string }): DocsRoute {
  let url: URL;
  try {
    url = new URL(requestUrl, requestOrigin);
    // Accept origin-form request targets only. Do not trust Host for redirects.
    if (!requestUrl.startsWith('/') || requestUrl.startsWith('//') || url.origin !== requestOrigin
      || requestUrl.includes('\\') || [...requestUrl].some(char => char.charCodeAt(0) < 32)) {
      return { kind: 'invalid' };
    }
    decodeURIComponent(url.pathname);
  } catch {
    return { kind: 'invalid' };
  }
  const pathname = url.pathname;
  if (pathname === '/docs') {
    return { kind: 'redirect', location: `${DOCS_BASE}${url.search}` };
  }
  if (!pathname.startsWith(DOCS_BASE)) {
    return { kind: 'outside' };
  }
  const rest = pathname.slice(DOCS_BASE.length - 1);
  if (devDirectories.some(prefix => rest.startsWith(prefix))) {
    return { kind: 'asset' };
  }
  if (pathname === `${DOCS_BASE}__locale.js`) {
    return { kind: 'bootstrap' };
  }
  if (pathname === `${DOCS_BASE}sitemap.xml`) {
    return { kind: 'sitemap' };
  }
  for (const locale of DOCS_LOCALES) {
    if (pathname === `${DOCS_BASE}search-${locale}.json`) {
      return { kind: 'search-index', locale };
    }
  }
  if (pathname === DOCS_BASE) {
    return { kind: 'root' };
  }
  if (pathname === `${DOCS_BASE}index.html`) {
    return { kind: 'redirect', location: `${DOCS_BASE}${url.search}` };
  }
  for (const locale of DOCS_LOCALES) {
    for (const page of DOCS_PAGES) {
      const canonical = docsHref({ locale, page: page.id });
      if (pathname === canonical) {
        return { kind: 'page', locale, page: page.id };
      }
      if (pathname === canonical.slice(0, -1) || pathname === `${canonical}index.html`) {
        return { kind: 'redirect', location: `${canonical}${url.search}` };
      }
    }
  }
  // Paths are matched against known routes, never interpolated into filesystem reads.
  return { kind: 'missing' };
}
