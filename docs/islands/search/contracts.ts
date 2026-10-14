import type { CommonMessages } from '../../site/messages';
import { DOCS_PAGES, docsHref } from '../../site/routes';
import type { DocsLocale, DocsPageId } from '../../site/routes';
import { PURPOSE_PAGES } from '../../site/search-purpose';
import type { PurposeGuide } from '../../site/search-purpose';
import { defineDocsIslandSpec } from '../spec';

export type SearchPayload = { locale: DocsLocale; currentPage: DocsPageId; copy: CommonMessages['searchUi']; purpose: PurposeGuide[] };

const copyFields = ['open', 'close', 'title', 'placeholder', 'purposeTitle', 'loading', 'noResults', 'count', 'previousResults', 'error', 'retry'] as const satisfies readonly (keyof CommonMessages['searchUi'])[];

export function parseSearchPayload({ serialized }: { serialized: string }): SearchPayload {
  const value: unknown = JSON.parse(serialized);
  if (typeof value !== 'object' || value === null || !('locale' in value) || (value.locale !== 'en' && value.locale !== 'ja')
    || !('currentPage' in value) || !DOCS_PAGES.some(page => page.id === value.currentPage)
    || !('copy' in value) || typeof value.copy !== 'object' || value.copy === null
    || !copyFields.every(field => typeof (value.copy as Record<string, unknown>)[field] === 'string')
    || !('purpose' in value) || !Array.isArray(value.purpose) || value.purpose.length !== PURPOSE_PAGES.length) {
    throw new Error('Invalid Docs search props');
  }
  const locale = value.locale;
  if (!value.purpose.every((entry, index) => {
    const page = PURPOSE_PAGES[index];
    return page !== undefined && typeof entry === 'object' && entry !== null
        && 'href' in entry && entry.href === docsHref({ locale, page })
        && 'title' in entry && typeof entry.title === 'string' && entry.title.trim().length > 0
        && 'snippet' in entry && typeof entry.snippet === 'string' && entry.snippet.trim().length > 0;
  })) {
    throw new Error('Invalid Docs search props');
  }
  return value as SearchPayload;
}

export const searchSpec = defineDocsIslandSpec<SearchPayload>({
  id: 'search',
  parse: parseSearchPayload,
  start: 'dom-content-loaded',
});
