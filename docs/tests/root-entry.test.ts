import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Script } from 'node:vm';
import { JSDOM, VirtualConsole } from 'jsdom';
import { build } from 'vite';
import { beforeAll, describe, expect, it } from 'vitest';
import { docsBuildConfig } from '../build/production';
import { createSiteFixture, parsePage, startSiteDev } from './site.test-support';

type EntryFixture = { html: string; script: string; en: string; ja: string };
let compiled: EntryFixture | undefined;

function entry(): EntryFixture {
  if (!compiled) throw new Error('Entry build has not completed');
  return compiled;
}

function createBrowser({ url, languages }: { url: string; languages: string[] }) {
  const errors: unknown[] = [];
  const console = new VirtualConsole();
  console.on('jsdomError', error => errors.push(error));
  console.on('error', (...messages) => errors.push(messages));
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url,
    runScripts: 'outside-only',
    virtualConsole: console,
  });
  Object.defineProperty(dom.window.navigator, 'languages', { value: languages });
  return {
    dom,
    errors,
    [Symbol.dispose]: () => dom.window.close(),
  };
}

function parseBody({ target, source }: { target: JSDOM; source: string }): void {
  using page = parsePage({ html: source });
  target.window.document.head.replaceChildren(...Array.from(page.document.head.childNodes, node => target.window.document.importNode(node, true)));
  // Simulate the body arriving after the synchronous head bootstrap has executed.
  target.window.document.body.replaceChildren(...Array.from(page.document.body.childNodes, node => target.window.document.importNode(node, true)));
  target.window.document.dispatchEvent(new target.window.Event('DOMContentLoaded'));
}

beforeAll(async () => {
  await using fixture = await createSiteFixture();
  await build({ ...docsBuildConfig({ root: fixture.docs }), configFile: false, logLevel: 'silent' });
  const dist = path.join(fixture.docs, 'dist');
  const html = await readFile(path.join(dist, 'index.html'), 'utf8');
  using parsed = parsePage({ html });
  const script = parsed.document.querySelector('script:not([type])[src]')?.getAttribute('src');
  if (!script) throw new Error('Missing bootstrap script');
  compiled = {
    html,
    script: await readFile(path.join(dist, script.slice('/docs/'.length)), 'utf8'),
    en: await readFile(path.join(dist, 'en/index.html'), 'utf8'),
    ja: await readFile(path.join(dist, 'ja/index.html'), 'utf8'),
  };
});

describe('language-neutral entrance without navigation', () => {
  it('uses a same-origin classic head script for locale selection and a separate search entry', () => {
    using page = parsePage({ html: entry().html });
    const scripts = page.document.querySelectorAll('script');
    expect(scripts).toHaveLength(2);
    const script = page.document.querySelector('script:not([type])');
    expect(script?.parentElement).toBe(page.document.head);
    expect(script?.hasAttribute('type')).toBe(false);
    expect(script?.hasAttribute('async')).toBe(false);
    expect(script?.hasAttribute('defer')).toBe(false);
    expect(script?.textContent).toBe('');
    expect(script?.getAttribute('src')).toMatch(/^\/docs\/assets\/locale-.+\.js$/);
    expect(page.document.querySelector('script[type="module"]')?.getAttribute('src')).toMatch(/^\/docs\/assets\/island-search-.+\.js$/);
    expect(page.document.querySelectorAll('template[data-docs-locale]')).toHaveLength(2);
  });

  it.each([
    { languages: ['ja-JP', 'en'], locale: 'ja' },
    { languages: ['en-US', 'ja'], locale: 'en' },
    { languages: ['de', 'ja'], locale: 'ja' },
    { languages: ['fr'], locale: 'en' },
    { languages: ['malformed_locale', 'ja'], locale: 'ja' },
  ] as const)('selects $locale for $languages before mounting a body, without changing the URL', ({ languages, locale }) => {
    const url = 'https://example.test/docs/?ref=home#guides';
    using browser = createBrowser({ url, languages: [...languages] });
    const document = browser.dom.window.document;
    new Script(entry().script).runInContext(browser.dom.getInternalVMContext());
    expect(document.documentElement.dataset.docsStarting).toBe('');
    expect(document.documentElement.lang).toBe(locale);
    expect(document.body.textContent).toBe('');
    parseBody({ target: browser.dom, source: entry().html });
    expect(browser.dom.window.location.href).toBe(url);
    expect(document.querySelector('[data-docs-language-fallback]')).toBeNull();
    expect(document.querySelectorAll('template[data-docs-locale]')).toHaveLength(0);
    expect(document.documentElement.dataset.docsStarting).toBeUndefined();
    expect(document.querySelectorAll('h1')).toHaveLength(1);
    using expected = parsePage({ html: entry()[locale] });
    expect(document.querySelector('[data-testid="docs-main"]')?.outerHTML).toBe(expected.document.querySelector('[data-testid="docs-main"]')?.outerHTML);
    expect(document.querySelector('[data-testid="docs-language-switch"]')?.getAttribute('href')).toBe(locale === 'en' ? '/docs/ja/' : '/docs/en/');
    expect(document.title).toBe(expected.document.title);
    expect(browser.errors).toEqual([]);
  });

  it('preserves usable language links with JavaScript disabled or blocked', () => {
    using page = parsePage({ html: entry().html });
    const fallback = page.document.querySelector('[data-docs-language-fallback]');
    expect(fallback?.textContent).toContain('日本語');
    expect(fallback?.querySelector('a[lang="en"]')?.getAttribute('href')).toBe('/docs/en/');
    expect(page.document.documentElement.hasAttribute('data-docs-starting')).toBe(false);
    expect(page.document.querySelectorAll('[data-testid="docs-hero"]')).toHaveLength(0);
  });

  it('restores the fallback if a template is damaged', () => {
    using browser = createBrowser({ url: 'https://example.test/docs/', languages: ['ja'] });
    using damaged = parsePage({ html: entry().html });
    damaged.document.querySelector('template[data-docs-locale="ja"]')?.remove();
    new Script(entry().script).runInContext(browser.dom.getInternalVMContext());
    parseBody({ target: browser.dom, source: damaged.document.documentElement.outerHTML });
    expect(browser.dom.window.document.documentElement.hasAttribute('data-docs-starting')).toBe(false);
    expect(browser.dom.window.document.querySelector('[data-docs-language-fallback] a')).not.toBeNull();
    expect(browser.errors).toHaveLength(1);
  });

  it('does nothing to an explicit language URL', () => {
    using browser = createBrowser({ url: 'https://example.test/docs/en/', languages: ['ja'] });
    new Script(entry().script).runInContext(browser.dom.getInternalVMContext());
    expect(browser.dom.window.document.documentElement.hasAttribute('data-docs-starting')).toBe(false);
    expect(browser.dom.window.location.pathname).toBe('/docs/en/');
  });

  it('serves the same compiled bootstrap and templates in development', async () => {
    await using fixture = await createSiteFixture();
    await using dev = await startSiteDev({ root: fixture.root });
    const response = await dev.request({ url: '/docs/' });
    using page = parsePage({ html: await response.text() });
    const bootstrap = page.document.querySelector('script:not([type])[src]')?.getAttribute('src');
    expect(bootstrap).toBe('/docs/__locale.js');
    if (!bootstrap) throw new Error('Missing development locale bootstrap');
    const asset = await dev.request({ url: bootstrap });
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('text/javascript');
    expect(await asset.text()).toBe(entry().script);
    for (const locale of ['en', 'ja'] as const) {
      const template = page.document.querySelector<HTMLTemplateElement>(`template[data-docs-locale="${locale}"]`);
      expect(template?.content.querySelectorAll('[data-docs-animation]').length).toBeGreaterThan(0);
      expect(template?.content.querySelector('h1')?.textContent).toBe(locale === 'en' ? 'An easy-to-use AI environment, built around privacy.' : '安全性を徹底追求した、簡単に使えるAI環境。');
    }
    const head = await dev.request({ url: '/docs/__locale.js', method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const post = await dev.request({ url: '/docs/__locale.js', method: 'POST' });
    expect(post.status).toBe(405);
  });
});
