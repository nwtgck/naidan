export const DOCS_BASE = '/docs/';
export const DOCS_LOCALES = ['en', 'ja'] as const;
export type DocsLocale = typeof DOCS_LOCALES[number];
export const DOCS_LOCALE_NAMES = { en: 'English', ja: '日本語' } satisfies Record<DocsLocale, string>;

// One route declaration owns discovery, rendering, style entries and output paths.
export const DOCS_PAGES = [
  { id: 'index', path: '', source: 'pages/index.vue' },
  { id: 'files/privacy', path: 'files/privacy/', source: 'pages/files/privacy.vue' },
  { id: 'work/boundary', path: 'work/boundary/', source: 'pages/work/boundary.vue' },
  { id: 'chat/branching', path: 'chat/branching/', source: 'pages/chat/branching.vue' },
  { id: 'chat/compact', path: 'chat/compact/', source: 'pages/chat/compact.vue' },
  { id: 'chat/groups', path: 'chat/groups/', source: 'pages/chat/groups.vue' },
  { id: 'run/standalone', path: 'run/standalone/', source: 'pages/run/standalone.vue' },
  { id: 'models/in-browser', path: 'models/in-browser/', source: 'pages/models/in-browser.vue' },
  { id: 'models/llama-cpp-browser', path: 'models/llama-cpp-browser/', source: 'pages/models/llama-cpp-browser.vue' },
  { id: 'models/transformers-js', path: 'models/transformers-js/', source: 'pages/models/transformers-js.vue' },
  { id: 'models/browser-provided', path: 'models/browser-provided/', source: 'pages/models/browser-provided.vue' },
  { id: 'models/local-engines', path: 'models/local-engines/', source: 'pages/models/local-engines.vue' },
  { id: 'models/ollama', path: 'models/ollama/', source: 'pages/models/ollama.vue' },
  { id: 'models/openai-compatible', path: 'models/openai-compatible/', source: 'pages/models/openai-compatible.vue' },
  { id: 'settings/inheritance', path: 'settings/inheritance/', source: 'pages/settings/inheritance.vue' },
  { id: 'data/storage', path: 'data/storage/', source: 'pages/data/storage.vue' },
  { id: 'data/backup', path: 'data/backup/', source: 'pages/data/backup.vue' },
  { id: 'images/create', path: 'images/create/', source: 'pages/images/create.vue' },
  { id: 'audio/speech', path: 'audio/speech/', source: 'pages/audio/speech.vue' },
  { id: 'work/browser-shell', path: 'work/browser-shell/', source: 'pages/work/browser-shell.vue' },
] as const;
export type DocsPageId = typeof DOCS_PAGES[number]['id'];

export function docsHref({ locale, page }: { locale: DocsLocale; page: DocsPageId }): string {
  const definition = DOCS_PAGES.find(entry => entry.id === page);
  if (!definition) throw new Error(`Unregistered Docs page: ${page}`);
  return `${DOCS_BASE}${locale}/${definition.path}`;
}

export function otherLocale({ locale }: { locale: DocsLocale }): DocsLocale {
  switch (locale) {
  case 'en': return 'ja';
  case 'ja': return 'en';
  default: { const unreachable: never = locale; return unreachable; }
  }
}
