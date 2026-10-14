import { z } from 'zod';
import { DOCS_PAGES, docsHref } from '../../navigation/routes';
import type { DocsLocale } from '../../navigation/routes';

const searchHitSchema = z.object({ href: z.string(), title: z.string(), snippet: z.string() });
export type SearchHit = z.infer<typeof searchHitSchema>;

export const searchWorkerRequestSchema = z.object({
  requestId: z.number().int().safe(),
  locale: z.enum(['en', 'ja']),
  query: z.string(),
});
export type SearchWorkerRequest = z.infer<typeof searchWorkerRequestSchema>;

const searchWorkerResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('results'), requestId: z.number().int().safe(), results: z.array(searchHitSchema) }),
  z.object({ kind: z.literal('error'), requestId: z.number().int().safe() }),
]);
export type SearchWorkerResponse = z.infer<typeof searchWorkerResponseSchema>;

export type SearchWorkerApi = {
  search: ({ request }: { request: SearchWorkerRequest }) => Promise<SearchWorkerResponse>;
};

export function parseWorkerRequest({ value }: { value: unknown }): SearchWorkerRequest {
  return searchWorkerRequestSchema.parse(value);
}

export function parseWorkerResponse({ value, locale }: { value: unknown; locale: DocsLocale }): SearchWorkerResponse {
  const validHrefs = new Set(DOCS_PAGES.map(page => docsHref({ locale, page: page.id })));
  return searchWorkerResponseSchema.refine(response => response.kind === 'error'
    || response.results.every(hit => validHrefs.has(hit.href))).parse(value);
}
