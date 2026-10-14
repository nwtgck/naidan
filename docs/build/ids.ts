import type { DocsPageId } from '../site/routes';
import { islandSpecs } from '../islands/registry';
import type { DocsIslandId } from '../islands/registry';

export const REGISTRY_ID = 'virtual:naidan-docs/registry';

export function islandEntryId({ id }: { id: DocsIslandId }): string {
  return `virtual:naidan-docs/island/${id}`;
}

export function islandDevHref({ id }: { id: DocsIslandId }): string {
  return `/@id/__x00__${islandEntryId({ id })}`;
}

export const ISLAND_ENTRIES = Object.fromEntries(
  Object.keys(islandSpecs).map(id => [id, `virtual:naidan-docs/island/${id}`]),
) as Record<DocsIslandId, string>;
export const APP_ENTRY_CLIENT = 'client/app-entry.ts';
export const HOME_BRAND_CLIENT = 'client/home-brand.ts';

export function styleEntryId({ page }: { page: DocsPageId }): string {
  return `virtual:naidan-docs/styles/${page}`;
}

export function styleEntryName({ page }: { page: DocsPageId }): string {
  return `style-${page.replaceAll('/', '-')}`;
}
