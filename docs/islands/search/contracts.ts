import type { CommonMessages } from '../../site/messages';
import type { DocsLocale } from '../../site/routes';

export type SearchPayload = { locale: DocsLocale; copy: CommonMessages['searchUi'] };

const copyFields = ['open', 'close', 'title', 'placeholder', 'purposeTitle', 'loading', 'noResults', 'count', 'previousResults', 'error', 'retry'] as const satisfies readonly (keyof CommonMessages['searchUi'])[];

export function parseSearchPayload({ serialized }: { serialized: string }): SearchPayload {
  const value: unknown = JSON.parse(serialized);
  if (typeof value !== 'object' || value === null || !('locale' in value) || (value.locale !== 'en' && value.locale !== 'ja')
    || !('copy' in value) || typeof value.copy !== 'object' || value.copy === null
    || !copyFields.every(field => typeof (value.copy as Record<string, unknown>)[field] === 'string')) {
    throw new Error('Invalid Docs search props');
  }
  return value as SearchPayload;
}
