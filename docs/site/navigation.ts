import { DOCS_PAGES, docsHref } from './routes';
import type { DocsLocale, DocsPageId } from './routes';
import type { CommonMessages } from './messages';

export const DOCS_NAV_GROUPS = ['start', 'run', 'about', 'models', 'files', 'work', 'chat', 'settings', 'data', 'create'] as const;
export type DocsNavGroup = typeof DOCS_NAV_GROUPS[number];

type NavigationPage = { group: DocsNavGroup; order: number; parent?: DocsPageId };

// A route must be placed here before the Docs typecheck succeeds. This metadata
// has no imports of page components or their language dictionaries.
export const DOCS_NAV_PAGES: Record<DocsPageId, NavigationPage> = {
  index: { group: 'start', order: 0 },
  'about/open-source': { group: 'about', order: 0 },
  'models/in-browser': { group: 'models', order: 0 },
  'models/llama-cpp-browser': { group: 'models', order: 0, parent: 'models/in-browser' },
  'models/transformers-js': { group: 'models', order: 1, parent: 'models/in-browser' },
  'models/browser-provided': { group: 'models', order: 2, parent: 'models/in-browser' },
  'models/local-engines': { group: 'models', order: 1 },
  'models/ollama': { group: 'models', order: 0, parent: 'models/local-engines' },
  'models/openai-compatible': { group: 'models', order: 1, parent: 'models/local-engines' },
  'models/naidan-rpc': { group: 'models', order: 2 },
  'files/privacy': { group: 'files', order: 0 },
  'files/explorer': { group: 'files', order: 1 },
  'files/settings': { group: 'files', order: 2 },
  'work/app-permissions': { group: 'work', order: 0 },
  'work/boundary': { group: 'work', order: 1 },
  'work/local-only': { group: 'work', order: 2 },
  'work/browser-shell': { group: 'work', order: 3 },
  'work/wesh-sysfs': { group: 'work', order: 4 },
  'work/wikipedia': { group: 'work', order: 5 },
  'chat/branching': { group: 'chat', order: 0 },
  'chat/compact': { group: 'chat', order: 1 },
  'chat/groups': { group: 'chat', order: 2 },
  'chat/super-edit': { group: 'chat', order: 3 },
  'run/standalone': { group: 'run', order: 0 },
  'run/offline': { group: 'run', order: 1 },
  'settings/inheritance': { group: 'settings', order: 0 },
  'data/storage': { group: 'data', order: 0 },
  'data/backup': { group: 'data', order: 1 },
  'images/create': { group: 'create', order: 0 },
  'audio/speech': { group: 'create', order: 1 },
};

export function navigationGroups({ locale, copy }: { locale: DocsLocale; copy: CommonMessages['navigation'] }) {
  const pages = DOCS_PAGES.map(({ id }) => ({ id, ...DOCS_NAV_PAGES[id] }));
  return DOCS_NAV_GROUPS.map(group => ({
    id: group,
    label: copy.groups[group],
    pages: pages.filter(entry => entry.group === group && entry.parent === undefined)
      .sort((a, b) => a.order - b.order)
      .map(entry => ({
        id: entry.id,
        href: docsHref({ locale, page: entry.id }),
        label: copy.pages[entry.id],
        children: pages.filter(child => child.parent === entry.id)
          .sort((a, b) => a.order - b.order)
          .map(child => ({ id: child.id, href: docsHref({ locale, page: child.id }), label: copy.pages[child.id] })),
      })),
  })).filter(group => group.pages.length > 0);
}
