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
  { id: 'run/standalone', path: 'run/standalone/', source: 'pages/run/standalone.vue' },
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
