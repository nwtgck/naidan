export const DOCS_BASE = '/docs/';
export const DOCS_LOCALES = ['en', 'ja'] as const;
export type DocsLocale = typeof DOCS_LOCALES[number];
export const DOCS_LOCALE_NAMES = { en: 'English', ja: '日本語' } satisfies Record<DocsLocale, string>;

// Use singular feature or concept IDs; keep established plurals such as settings and permissions.
// Each ID matches pages/<id>/ and /docs/{locale}/<id>/ (index uses the locale root).
// IDs stay independent of article titles and example counts.
export const DOCS_PAGE_IDS = [
  'index',
  'open-source',
  'file-access',
  'file-explorer',
  'file-and-folder-settings',
  'web-and-native-app-permissions',
  'browser-boundary',
  'csp-edition',
  'chat-branching',
  'chat-context-compaction',
  'chat-group',
  'chat-super-edit',
  'chat-search',
  'image-understanding',
  'live-conversation',
  'standalone',
  'hosted',
  'pwa',
  'in-browser-model',
  'endpoint-type-llama-cpp-browser',
  'endpoint-type-transformers-js',
  'endpoint-type-browser-provided-lm',
  'local-ai-server',
  'endpoint-type-ollama',
  'endpoint-type-openai',
  'endpoint-type-naidan-rpc',
  'settings-inheritance',
  'data-storage',
  'data-backup',
  'image-generation',
  'image-generation-multi-prompt',
  'audio-generation',
  'translation',
  'workflow',
  'tool-browser-shell',
  'wesh-sysfs',
  'tool-wikipedia',
] as const;
export type DocsPageId = typeof DOCS_PAGE_IDS[number];

function articlePath({ id }: { id: string }): string {
  return id === 'index' ? '' : `${id}/`;
}

export const DOCS_PAGES = DOCS_PAGE_IDS.map(id => ({
  id,
  path: articlePath({ id }),
  source: `pages/${id}/index.vue`,
}));

export function docsHref({ locale, page }: { locale: DocsLocale; page: DocsPageId }): string {
  const definition = DOCS_PAGES.find(entry => entry.id === page);
  if (!definition) {
    throw new Error(`Unregistered Docs page: ${page}`);
  }
  return `${DOCS_BASE}${locale}/${definition.path}`;
}

export function otherLocale({ locale }: { locale: DocsLocale }): DocsLocale {
  switch (locale) {
  case 'en': return 'ja';
  case 'ja': return 'en';
  default: {
    const unreachable: never = locale;
    return unreachable;
  }
  }
}
