import type { DocsPageId } from '../site/routes';

export const REGISTRY_ID = 'virtual:naidan-docs/registry';
export const ISLAND_ENTRIES = { branching: 'islands/branching/client.ts', search: 'islands/search/client.ts' } as const;
export const APP_ENTRY_CLIENT = 'client/app-entry.ts';
export const HOME_BRAND_CLIENT = 'client/home-brand.ts';

export function styleEntryId({ page }: { page: DocsPageId }): string {
  return `virtual:naidan-docs/styles/${page}`;
}

export function styleEntryName({ page }: { page: DocsPageId }): string {
  return `style-${page.replaceAll('/', '-')}`;
}
