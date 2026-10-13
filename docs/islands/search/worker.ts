import { parseSearchIndex, purposeDocs, searchDocs, searchIndexHref } from '../../site/search';
import type { SearchIndex } from '../../site/search';
import type { DocsLocale } from '../../site/routes';
import { sendSearchResponse, subscribeSearchRequests } from './transport';
import type { SearchWorkerRequest } from './worker-contracts';
const indexes = new Map<DocsLocale, Promise<SearchIndex>>();

async function loadIndex({ locale }: { locale: DocsLocale }): Promise<SearchIndex> {
  let pending = indexes.get(locale);
  if (!pending) {
    pending = (async () => {
      const response = await fetch(searchIndexHref({ locale }));
      if (!response.ok) throw new Error(`Docs search index returned ${response.status}`);
      return parseSearchIndex({ value: await response.json() as unknown, locale });
    })();
    indexes.set(locale, pending);
    pending.catch(() => indexes.delete(locale));
  }
  return pending;
}

async function respond({ request }: { request: SearchWorkerRequest }): Promise<void> {
  try {
    const index = await loadIndex({ locale: request.locale });
    const results = request.query.trim()
      ? searchDocs({ index, query: request.query }).map(({ href, title, snippet }) => ({ href, title, snippet }))
      : purposeDocs({ index });
    sendSearchResponse({ response: { kind: 'results', requestId: request.requestId, results } });
  } catch (error) {
    console.error('[Docs search] Worker search failed.', error);
    sendSearchResponse({ response: { kind: 'error', requestId: request.requestId } });
  }
}

subscribeSearchRequests({
  onRequest: ({ request }) => {
    void respond({ request });
  },
});
