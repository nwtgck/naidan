import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';
import { parse as parseCss } from 'postcss';
import { beforeAll, describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { docsBuildConfig } from '../build/production';
import { renderDocument } from '../build/html';
import { EXTERNAL_LINK_LABEL, EXTERNAL_LINK_PATH } from '../site/external-link';
import { DOCS_LOCALES, DOCS_PAGES, docsHref } from '../site/routes';
import type { DocsLocale } from '../site/routes';
import ExternalLink from '../site/ExternalLink.vue';
import { createSiteFixture, parsePage } from './site.test-support';

function compose({ body, locale }: { body: string; locale: DocsLocale }): string {
  return renderDocument({ page: { page: 'index', locale, body, title: 'Test', description: 'Description' }, assets: { styles: [], scripts: [] } });
}

describe('external link presentation', () => {
  it.each(DOCS_LOCALES)('always adds an accessible visible icon for external links in %s', locale => {
    using page = parsePage({ html: compose({ locale, body: '<h1>Links</h1><a href="https://example.org">Docs</a><a href="//example.org"><strong>Nested text</strong></a><a href="/">Naidan</a><a href="#section">Section</a>' }) });
    const external = page.document.querySelectorAll('[data-docs-external]');
    expect(external).toHaveLength(2);
    for (const anchor of external) {
      expect(anchor.querySelectorAll('[data-docs-external-icon]')).toHaveLength(1);
      expect(anchor.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
      expect(anchor.querySelector('svg path')?.getAttribute('d')).toBe(EXTERNAL_LINK_PATH);
      expect(anchor.querySelector('.sr-only')?.textContent).toBe(EXTERNAL_LINK_LABEL[locale]);
      expect(anchor.getAttribute('referrerpolicy')).toBe('no-referrer');
    }
    expect(page.document.querySelector('a[href="/"] svg')).toBeNull();
    expect(page.document.querySelector('a[href="#section"] svg')).toBeNull();
    // Recomposition is idempotent, including accessible labels.
    using repeated = parsePage({ html: compose({ locale, body: page.document.body.innerHTML }) });
    expect(repeated.document.querySelectorAll('[data-docs-external-icon]')).toHaveLength(2);
    expect(repeated.document.querySelectorAll('a .sr-only')).toHaveLength(2);
  });

  it.each(DOCS_LOCALES)('preserves ExternalLink.vue markup inside an island in %s', async locale => {
    const body = await renderToString(createSSRApp({ render: () => h(ExternalLink, { locale, href: 'https://example.org' }, { default: () => 'External reference' }) }));
    using rendered = parsePage({ html: compose({ locale, body: `<h1>Demo</h1><div data-docs-island="branching">${body}</div>` }) });
    using original = parsePage({ html: body });
    expect(rendered.document.querySelector('a')?.outerHTML).toBe(original.document.querySelector('a')?.outerHTML);
  });

  it('requires external-link markup in interactive islands rather than creating a hydration mismatch', () => {
    expect(() => compose({ locale: 'en', body: '<h1>Demo</h1><div data-docs-island="branching"><a href="https://example.org">External</a></div>' })).toThrow('Use ExternalLink.vue');
  });

  it('rejects empty indicators instead of silently treating them as valid external icons', () => {
    expect(() => compose({ locale: 'en', body: '<h1>Demo</h1><a href="https://example.org"><span data-docs-external-icon></span>External</a>' })).toThrow('Invalid external-link indication');
  });
});

const pages = new Map<string, { html: string; css: string }>();

beforeAll(async () => {
  await using fixture = await createSiteFixture();
  await build({ ...docsBuildConfig({ root: fixture.docs }), configFile: false, logLevel: 'silent' });
  for (const locale of DOCS_LOCALES) {
    for (const page of DOCS_PAGES) {
      const href = docsHref({ locale, page: page.id });
      const html = await readFile(path.join(fixture.docs, 'dist', href.slice('/docs/'.length), 'index.html'), 'utf8');
      using document = parsePage({ html });
      let css = '';
      for (const link of document.document.querySelectorAll('link[rel="stylesheet"]')) {
        const pathname = new URL(link.getAttribute('href') ?? '', 'https://example.test').pathname;
        css += await readFile(path.join(fixture.docs, 'dist', pathname.slice('/docs/'.length)), 'utf8');
      }
      pages.set(href, { html, css });
    }
  }
});

describe('automatically animated, accessible guides', () => {
  it.each(DOCS_PAGES)('ships native animated CSS for $id, without adding unnecessary JavaScript', page => {
    for (const locale of DOCS_LOCALES) {
      const output = pages.get(docsHref({ locale, page: page.id }));
      if (!output) throw new Error('Missing generated page');
      using document = parsePage({ html: output.html });
      expect(document.document.querySelectorAll('[data-docs-animation]').length).toBeGreaterThan(0);
      expect(document.document.querySelector('[data-testid="docs-motion-toggle"]')).toBeNull();
      const pause = document.document.querySelector<HTMLInputElement>('[data-testid="docs-pause-motion"]');
      expect(pause).not.toBeNull();
      expect(pause?.checked).toBe(false);
      expect(pause?.getAttribute('aria-label')).toBeTruthy();
      expect(document.document.querySelectorAll('script')).toHaveLength(page.id === 'chat/branching' ? 1 : 0);
      const tree = parseCss(output.css);
      const keyframes: string[] = [], motions: string[] = [], pauseRules: string[] = [], reduced: string[] = [];
      tree.walkAtRules('keyframes', rule => {
        keyframes.push(rule.params);
      });
      tree.walkDecls('animation', declaration => {
        if (declaration.value !== 'none') motions.push(declaration.value);
      });
      tree.walkDecls('animation-play-state', declaration => {
        pauseRules.push(declaration.parent?.toString() ?? '');
      });
      tree.walkAtRules('media', rule => {
        if (rule.params.includes('prefers-reduced-motion')) reduced.push(rule.toString());
      });
      expect(keyframes.length).toBeGreaterThan(0);
      expect(motions.length).toBeGreaterThan(0);
      expect(pauseRules.some(rule => rule.includes('#docs-pause-motion:checked') && rule.includes('paused'))).toBe(true);
      expect(reduced.some(rule => rule.includes('animation:none') || rule.includes('animation: none'))).toBe(true);
      for (const link of document.document.querySelectorAll('a[href]')) {
        const href = link.getAttribute('href') ?? '';
        if (!href.startsWith('https://')) continue;
        expect(link.querySelectorAll('[data-docs-external-icon]'), href).toHaveLength(1);
      }
    }
  });

  it('gives file:// a homepage entry and a complete localized standalone guide', () => {
    for (const locale of DOCS_LOCALES) {
      const home = pages.get(docsHref({ locale, page: 'index' }));
      const guide = pages.get(docsHref({ locale, page: 'run/standalone' }));
      if (!home || !guide) throw new Error('Missing standalone guide');
      using homePage = parsePage({ html: home.html });
      using guidePage = parsePage({ html: guide.html });
      const link = homePage.document.querySelector('[data-testid="docs-home-standalone"] a');
      expect(link?.getAttribute('href')).toBe(docsHref({ locale, page: 'run/standalone' }));
      const article = guidePage.document.querySelector('[data-testid="docs-standalone"]');
      expect(article?.textContent).toContain('file://');
      expect(article?.textContent).toContain('index.html');
      expect(article?.textContent).toContain('assets');
      expect(article?.textContent).toContain('Memory');
      expect(article?.textContent).toContain('llama.cpp server');
      expect(article?.querySelector('a[href="https://naidan.pages.dev/naidan-standalone.zip"]')).not.toBeNull();
    }
  });

  it.each(DOCS_LOCALES)('localizes diagrams and keeps authentic technical labels in %s', locale => {
    const expected = locale === 'ja'
      ? { os: 'このPCのOS', browser: 'ブラウザ', blocked: 'ブラウザの境界で止まる', folder: 'フォルダ（コピー）', access: '読み取り専用', open: 'ブラウザで開く', newChat: '新しいチャット' }
      : { os: 'The OS on this PC', browser: 'Browser', blocked: 'Stops at the browser boundary', folder: 'Folder (copy)', access: 'READ ONLY', open: 'Open in your browser', newChat: 'New Chat' };
    for (const page of ['index', 'work/boundary', 'files/privacy', 'run/standalone'] as const) {
      const output = pages.get(docsHref({ locale, page }));
      if (!output) throw new Error('Missing localized demonstration page');
      using document = parsePage({ html: output.html });
      expect(document.document.documentElement.lang).toBe(locale);
      const diagram = document.document.querySelector('[data-testid="boundary-diagram"]');
      if (page === 'index' || page === 'work/boundary') expect(diagram).not.toBeNull();
      if (diagram) {
        const os = diagram.querySelector('[data-testid="os-boundary"]');
        const browser = diagram.querySelector('[data-testid="browser-boundary"]');
        const app = diagram.querySelector('[data-testid="naidan-in-browser"]');
        expect(os?.textContent).toContain(expected.os);
        expect(browser?.closest('[data-testid="os-boundary"]')).toBe(os);
        expect(browser?.textContent).toContain(expected.browser);
        expect(app?.closest('[data-testid="browser-boundary"]')).toBe(browser);
        expect(browser?.querySelector('[data-testid="direct-os-stop"]')?.textContent).toContain(expected.blocked);
        expect(browser?.querySelector('[data-testid="browser-api-gateway"]')).not.toBeNull();
        expect(os?.querySelector('[data-testid="permitted-files"]')).not.toBeNull();
        expect(os?.querySelector('[data-testid="permitted-clipboard"]')).not.toBeNull();
        expect(diagram.querySelector('[data-testid="localhost-api-path"]')?.textContent).toContain('HTTP API');
        expect(diagram.querySelector('[data-testid="localhost-api-path"]')?.textContent).toContain('localhost');
        expect(diagram.hasAttribute('lang')).toBe(false);
      }
      const folder = document.document.querySelector('[data-testid="folder-access-demo"]');
      if (page === 'files/privacy') expect(folder).not.toBeNull();
      if (folder) {
        expect(folder.textContent).toContain(expected.folder);
        expect(folder.textContent).toContain(expected.access);
        expect(folder.textContent).toContain('notes.txt');
        expect(folder.textContent).toContain('plan.md');
        expect(folder.hasAttribute('lang')).toBe(false);
      }
      const standalone = document.document.querySelector('[data-testid="standalone-demo"]');
      if (page === 'run/standalone') expect(standalone).not.toBeNull();
      if (standalone) {
        expect(standalone.textContent).toContain(expected.open);
        expect(standalone.textContent).toContain(expected.newChat);
        expect(standalone.textContent).toContain('index.html');
        expect(standalone.textContent).toContain('assets/');
        expect(standalone.querySelector('[data-testid="standalone-explorer"]')).not.toBeNull();
        expect(standalone.querySelector('[data-testid="standalone-index-file"]')?.textContent).toContain('index.html');
        expect(standalone.querySelector('[data-testid="standalone-browser"]')).not.toBeNull();
        expect(standalone.hasAttribute('lang')).toBe(false);
      }
      const chrome = document.document.querySelector('[data-testid="replica-chrome"]');
      if (page === 'index') expect(chrome).not.toBeNull();
      if (chrome) {
        expect(chrome.textContent).toContain(expected.newChat);
        expect(chrome.hasAttribute('lang')).toBe(false);
      }
    }
  });

  it.each(DOCS_LOCALES)('links model choices to complete localized guides in %s', locale => {
    const output = pages.get(docsHref({ locale, page: 'index' }));
    if (!output) throw new Error('Missing homepage');
    using document = parsePage({ html: output.html });
    const links = [...document.document.querySelectorAll('[data-testid="docs-model-guide"]')];
    expect(links.map(link => link.getAttribute('href'))).toEqual([
      docsHref({ locale, page: 'models/in-browser' }),
      docsHref({ locale, page: 'models/local-engines' }),
    ]);
    for (const page of ['models/in-browser', 'models/local-engines'] as const) {
      const guide = pages.get(docsHref({ locale, page }));
      if (!guide) throw new Error('Missing model guide');
      using document = parsePage({ html: guide.html });
      expect(document.document.documentElement.lang).toBe(locale);
      expect(document.document.querySelector('article h1')?.textContent?.trim()).toBeTruthy();
      expect(document.document.querySelectorAll('article ol li').length).toBeGreaterThan(0);
    }
  });
});
