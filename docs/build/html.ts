import { JSDOM } from 'jsdom';
import { EXTERNAL_LINK_PATH, EXTERNAL_LINK_LABEL } from '../site/external-link';
import { DOCS_BASE, DOCS_LOCALES, DOCS_LOCALE_NAMES, docsHref } from '../site/routes';
import type { PageAssets, RenderedPage } from './contracts';
import { ISLAND_ENTRIES } from './ids';
import { parseBranchingPayload } from '../islands/branching/contracts';
import { strings as entryEn } from '../strings/entry/en';
import { strings as entryJa } from '../strings/entry/ja';
import type { DocsLocale } from '../site/routes';

function appendAssets({ document, assets }: { document: Document; assets: PageAssets }): void {
  for (const href of new Set(assets.styles)) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.setAttribute('href', href);
    document.head.append(link);
  }
  for (const src of new Set(assets.scripts)) {
    const script = document.createElement('script');
    script.type = 'module';
    script.setAttribute('src', src);
    document.head.append(script);
  }
}

const islandPayloadParsers = { branching: parseBranchingPayload } satisfies Record<keyof typeof ISLAND_ENTRIES, ({ serialized }: { serialized: string }) => unknown>;

function isIslandName(name: string): name is keyof typeof ISLAND_ENTRIES {
  return Object.hasOwn(ISLAND_ENTRIES, name);
}

export function findIslands({ body }: { body: string }): Array<keyof typeof ISLAND_ENTRIES> {
  const fragment = JSDOM.fragment(body);
  const result = new Set<keyof typeof ISLAND_ENTRIES>();
  for (const element of fragment.querySelectorAll('[data-docs-island]')) {
    const name = element.getAttribute('data-docs-island');
    if (!name || !isIslandName(name)) throw new Error(`Unknown Docs island: ${String(name)}`);
    if (element.parentElement?.closest('[data-docs-island]')) throw new Error('Nested Docs islands are not supported');
    const serialized = element.getAttribute('data-docs-props');
    if (!serialized) throw new Error(`Missing props for Docs island ${name}`);
    islandPayloadParsers[name]({ serialized });
    result.add(name);
  }
  return [...result];
}

export function renderDocument({ page, assets }: { page: RenderedPage; assets: PageAssets }): string {
  const { body, title, description, locale, page: pageId, ...unhandledPage } = page;
  unhandledPage satisfies Record<PropertyKey, never>;
  const dom = new JSDOM('<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>');
  try {
    const document = dom.window.document;
    document.documentElement.lang = locale;
    document.title = `${title} | Naidan`;
    const meta = document.createElement('meta');
    meta.name = 'description';
    meta.content = description;
    document.head.append(meta);
    const color = document.createElement('meta');
    color.name = 'color-scheme';
    color.content = 'dark light';
    document.head.append(color);
    for (const lang of DOCS_LOCALES) {
      const link = document.createElement('link');
      link.rel = 'alternate';
      link.hreflang = lang;
      link.setAttribute('href', docsHref({ locale: lang, page: pageId }));
      document.head.append(link);
    }
    document.body.append(document.importNode(JSDOM.fragment(body), true));
    // Vue owns escaping. jsdom owns parsing/serialization; no HTML regex rewrites.
    validateBody({ document, locale });
    appendAssets({ document, assets });
    return dom.serialize();
  } finally {
    dom.window.close();
  }
}

function markExternalLink({ document, anchor, locale }: { document: Document; anchor: Element; locale: DocsLocale }): void {
  // Post-render additions inside an island would cause a hydration mismatch. Such
  // links must use ExternalLink.vue, which renders this same indication itself.
  const icons = anchor.querySelectorAll('[data-docs-external-icon]');
  if (icons.length) {
    if (icons.length !== 1 || icons[0]?.localName !== 'svg' || icons[0].getAttribute('aria-hidden') !== 'true' || icons[0].querySelector('path')?.getAttribute('d') !== EXTERNAL_LINK_PATH || !Array.from(anchor.querySelectorAll('.sr-only')).some(label => label.textContent === EXTERNAL_LINK_LABEL[locale])) {
      throw new Error('Invalid external-link indication; use ExternalLink.vue');
    }
    return;
  }
  if (anchor.closest('[data-docs-island]')) throw new Error('Use ExternalLink.vue for external links inside an island');
  anchor.setAttribute('data-docs-external', '');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('data-docs-external-icon', '');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', EXTERNAL_LINK_PATH);
  svg.append(path);
  const text = document.createElement('span');
  text.className = 'sr-only';
  text.textContent = EXTERNAL_LINK_LABEL[locale];
  anchor.append(svg, text);
}

function validateBody({ document, locale }: { document: Document; locale: DocsLocale }): void {
  if (document.querySelectorAll('h1').length !== 1) throw new Error('A Docs page must render exactly one h1');
  if (document.body.querySelector('script, iframe, object, embed, base')) throw new Error('Active content in static Docs body');
  const origin = 'https://naidan-docs.invalid';
  for (const element of document.body.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      if (attribute.name.toLowerCase().startsWith('on')) throw new Error('Inline event attribute in Docs HTML');
    }
  }
  for (const element of document.body.querySelectorAll('[href], [src], use')) {
    for (const attribute of ['href', 'src', 'xlink:href']) {
      const value = element.getAttribute(attribute);
      if (value === null) continue;
      const url = new URL(value, origin);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        // Media must use emitted local assets; no data-document exception.
        throw new Error(`Unsupported Docs URL protocol: ${url.protocol}`);
      }
      if ((attribute === 'src' || attribute === 'xlink:href' || element.tagName.toLowerCase() === 'use') && url.origin !== origin) throw new Error('Docs media must be local build assets');
      if (element.tagName === 'A' && url.origin !== origin) {
        element.setAttribute('rel', 'noopener noreferrer');
        element.setAttribute('referrerpolicy', 'no-referrer');
        markExternalLink({ document, anchor: element, locale });
      }
    }
  }
}

const entryMessages = { en: entryEn, ja: entryJa };

function renderEntryDocument({ assets, kind }: { assets: PageAssets; kind: 'language' | 'missing' }): string {
  const dom = new JSDOM('<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main class="language-page"><h1>Naidan Docs</h1><nav aria-label="Language"></nav></main></body></html>');
  try {
    const document = dom.window.document;
    const nav = document.querySelector('nav');
    if (!nav) throw new Error('Missing language navigation');
    switch (kind) {
    case 'language': document.title = 'Naidan Docs'; break;
    case 'missing': document.title = '404 | Naidan Docs'; break;
    default: { const unreachable: never = kind; throw new Error(`Unknown entry: ${unreachable}`); }
    }
    for (const locale of DOCS_LOCALES) {
      const messages = entryMessages[locale];
      const paragraph = document.createElement('p');
      paragraph.lang = locale;
      switch (kind) {
      case 'language': paragraph.textContent = messages.choose; break;
      case 'missing': paragraph.textContent = `${messages.missingTitle} — ${messages.missingBody}`; break;
      default: { const unreachable: never = kind; throw new Error(`Unknown entry: ${unreachable}`); }
      }
      nav.before(paragraph);
      const anchor = document.createElement('a');
      anchor.lang = locale;
      anchor.setAttribute('href', `${DOCS_BASE}${locale}/`);
      anchor.textContent = DOCS_LOCALE_NAMES[locale];
      nav.append(anchor);
    }
    appendAssets({ document, assets });
    return dom.serialize();
  } finally {
    dom.window.close();
  }
}

export function renderLocaleRoot({ assets, pages, bootstrap }: {
  assets: PageAssets;
  pages: Record<DocsLocale, RenderedPage>;
  bootstrap: string;
}): string {
  const dom = new JSDOM(renderEntryDocument({ assets, kind: 'language' }));
  try {
    const document = dom.window.document;
    document.querySelector('main')?.setAttribute('data-docs-language-fallback', '');
    const meta = document.createElement('meta');
    meta.name = 'description';
    document.head.append(meta);
    for (const locale of DOCS_LOCALES) {
      const page = pages[locale];
      if (page.page !== 'index' || page.locale !== locale) throw new Error('Invalid localized Docs home');
      if (findIslands({ body: page.body }).length) throw new Error('The language-neutral home requires static components');
      const localized = new JSDOM(renderDocument({ page, assets: { styles: [], scripts: [] } }));
      try {
        const template = document.createElement('template');
        template.dataset.docsLocale = locale;
        template.dataset.title = localized.window.document.title;
        template.dataset.description = page.description;
        for (const child of localized.window.document.body.childNodes) template.content.append(document.importNode(child, true));
        document.body.append(template);
      } finally {
        localized.window.close();
      }
    }
    const script = document.createElement('script');
    script.src = bootstrap;
    // This is deliberately classic and synchronous, rather than a deferred module.
    // External/self-hosted code works under the existing CSP without inline grants.
    document.head.append(script);
    return dom.serialize();
  } finally {
    dom.window.close();
  }
}

export function renderNotFound({ assets }: { assets: PageAssets }): string {
  return renderEntryDocument({ assets, kind: 'missing' });
}
