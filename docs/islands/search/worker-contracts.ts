import type { DocsLocale } from '../../site/routes';

export type SearchHit = { href: string; title: string; snippet: string };
export type SearchWorkerRequest = { requestId: number; locale: DocsLocale; query: string };
export type SearchWorkerResponse =
  | { kind: 'results'; requestId: number; results: SearchHit[] }
  | { kind: 'error'; requestId: number };

export function parseWorkerRequest({ value }: { value: unknown }): SearchWorkerRequest {
  if (typeof value !== 'object' || value === null
    || !('requestId' in value) || typeof value.requestId !== 'number' || !Number.isSafeInteger(value.requestId)
    || !('locale' in value) || (value.locale !== 'en' && value.locale !== 'ja')
    || !('query' in value) || typeof value.query !== 'string') throw new Error('Invalid Docs search request');
  return value as SearchWorkerRequest;
}

export function parseWorkerResponse({ value, locale }: { value: unknown; locale: DocsLocale }): SearchWorkerResponse {
  if (typeof value !== 'object' || value === null
    || !('requestId' in value) || typeof value.requestId !== 'number' || !Number.isSafeInteger(value.requestId)
    || !('kind' in value)) throw new Error('Invalid Docs search response');
  if (value.kind === 'error') return { kind: 'error', requestId: value.requestId };
  if (value.kind !== 'results' || !('results' in value) || !Array.isArray(value.results)
    || !value.results.every((item: unknown) => typeof item === 'object' && item !== null
      && 'href' in item && typeof item.href === 'string' && item.href.startsWith(`/docs/${locale}/`)
      && 'title' in item && typeof item.title === 'string'
      && 'snippet' in item && typeof item.snippet === 'string')) throw new Error('Invalid Docs search response');
  return { kind: 'results', requestId: value.requestId, results: value.results as SearchHit[] };
}
