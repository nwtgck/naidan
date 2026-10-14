import { docsHref } from './routes';
import type { DocsLocale, DocsPageId } from './routes';

export const PURPOSE_PAGES = ['run/standalone', 'models/ollama', 'chat/branching', 'images/create', 'data/backup'] as const satisfies readonly DocsPageId[];
export type PurposePageId = typeof PURPOSE_PAGES[number];
export type PurposeGuide = { href: string; title: string; snippet: string };

export function purposeGuides({ locale, titles, descriptions }: {
  locale: DocsLocale;
  titles: Record<DocsPageId, string>;
  descriptions: Record<PurposePageId, string>;
}): PurposeGuide[] {
  return PURPOSE_PAGES.map(page => ({
    href: docsHref({ locale, page }),
    title: titles[page],
    snippet: descriptions[page],
  }));
}
