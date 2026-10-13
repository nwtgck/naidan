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
});
