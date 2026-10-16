import type { DocsLocale } from './routes';

// Shared by DOM composition and hydrated links so their markup stays consistent.
export const EXTERNAL_LINK_PATH = 'M15 3h6v6m0-6L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5';
export const EXTERNAL_LINK_LABEL = {
  en: ' (external site)',
  ja: '（外部サイト）',
} satisfies Record<DocsLocale, string>;

export function isGitHubUrl({ href }: { href: string }): boolean {
  const hostname = new URL(href, 'https://naidan-docs.invalid').hostname;
  return hostname === 'github.com' || hostname === 'www.github.com';
}
