import { parseSearchIndex, purposeDocs, searchDocs, searchIndexHref } from '../../search/search';
import type { SearchIndex } from '../../search/search';
import type { DocsLocale } from '../../navigation/routes';
import { parseWorkerRequest } from './worker-contracts';
import type { SearchWorkerApi } from './worker-contracts';
import { exposeSearchWorker } from './transport';
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

const api: SearchWorkerApi = {
  async search({ request }) {
    const parsed = parseWorkerRequest({ value: request });
    try {
      const index = await loadIndex({ locale: parsed.locale });
      const results = parsed.query.trim()
        ? searchDocs({ index, query: parsed.query }).map(({ href, title, snippet }) => ({ href, title, snippet }))
        : purposeDocs({ index });
      return { kind: 'results', requestId: parsed.requestId, results };
    } catch (error) {
      console.error('[Docs search] Worker search failed.', error);
      return { kind: 'error', requestId: parsed.requestId };
    }
  },
};

exposeSearchWorker({ api });
