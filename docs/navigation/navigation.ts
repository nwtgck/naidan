import { DOCS_PAGES, docsHref } from './routes';
import type { DocsLocale, DocsPageId } from './routes';
import type { CommonMessages } from '../messages/types';

export const DOCS_NAV_GROUPS = ['start', 'run', 'about', 'models', 'files', 'work', 'chat', 'settings', 'data', 'create'] as const;
export type DocsNavGroup = typeof DOCS_NAV_GROUPS[number];

type NavigationPage = { group: DocsNavGroup; order: number; parent?: DocsPageId };

// A route must be placed here before the Docs typecheck succeeds. This metadata
// has no imports of page components or their language dictionaries.
export const DOCS_NAV_PAGES: Record<DocsPageId, NavigationPage> = {
  index: { group: 'start', order: 0 },
  'open-source': { group: 'about', order: 0 },
  'in-browser-models': { group: 'models', order: 0 },
  'endpoint-type-llama-cpp-browser': { group: 'models', order: 0, parent: 'in-browser-models' },
  'endpoint-type-transformers-js': { group: 'models', order: 1, parent: 'in-browser-models' },
  'endpoint-type-browser-provided-lm': { group: 'models', order: 2, parent: 'in-browser-models' },
  'local-ai-servers': { group: 'models', order: 1 },
  'endpoint-type-ollama': { group: 'models', order: 0, parent: 'local-ai-servers' },
  'endpoint-type-openai': { group: 'models', order: 1, parent: 'local-ai-servers' },
  'endpoint-type-naidan-rpc': { group: 'models', order: 2 },
  'file-access': { group: 'files', order: 0 },
  'file-explorer': { group: 'files', order: 1 },
  'files-and-folders-settings': { group: 'files', order: 2 },
  'web-and-native-app-permissions': { group: 'work', order: 0 },
  'browser-boundaries': { group: 'work', order: 1 },
  'csp-editions': { group: 'work', order: 2 },
  'tool-browser-shell': { group: 'work', order: 3 },
  'wesh-sysfs': { group: 'work', order: 4 },
  'tool-wikipedia': { group: 'work', order: 5 },
  'chat-branching': { group: 'chat', order: 0 },
  'chat-context-compaction': { group: 'chat', order: 1 },
  'chat-groups': { group: 'chat', order: 2 },
  'chat-super-edit': { group: 'chat', order: 3 },
  'standalone': { group: 'run', order: 0 },
  'hosted': { group: 'run', order: 1 },
  'pwa': { group: 'run', order: 2 },
  'settings-inheritance': { group: 'settings', order: 0 },
  'data-storage': { group: 'data', order: 0 },
  'data-backup': { group: 'data', order: 1 },
  'image-generation': { group: 'create', order: 0 },
  'audio-generation': { group: 'create', order: 1 },
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
