import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Script } from 'node:vm';
import { JSDOM, VirtualConsole } from 'jsdom';
import { build } from 'vite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { docsBuildConfig } from '../build/production';
import { createSiteFixture, parsePage, startSiteDev } from './site.test-support';

type EntryFixture = { html: string; script: string; appEntryScript: string; en: string; ja: string; missing: string };
let compiled: EntryFixture | undefined;

function entry(): EntryFixture {
  if (!compiled) {
    throw new Error('Entry build has not completed');
  }
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

function setMotionMedia({ dom, narrow = false, reduced = false }: { dom: JSDOM; narrow?: boolean; reduced?: boolean }): void {
  Object.defineProperty(dom.window, 'matchMedia', {
    value: (query: string) => ({
      matches: query === '(max-width: 480px)' ? narrow : query === '(prefers-reduced-motion: reduce)' ? reduced : false,
    }),
  });
}

function parseBody({ target, source }: { target: JSDOM; source: string }): void {
  using page = parsePage({ html: source });
  target.window.document.head.replaceChildren(...Array.from(page.document.head.childNodes, node => target.window.document.importNode(node, true)));
  // Simulate the body arriving after the synchronous head bootstrap has executed.
  target.window.document.body.replaceChildren(...Array.from(page.document.body.childNodes, node => target.window.document.importNode(node, true)));
  target.window.document.dispatchEvent(new target.window.Event('DOMContentLoaded'));
}

function restoreFromCache({ dom }: { dom: JSDOM }): void {
  const restored = new dom.window.Event('pageshow');
  Object.defineProperty(restored, 'persisted', { value: true });
  dom.window.dispatchEvent(restored);
}

beforeAll(async () => {
  await using fixture = await createSiteFixture();
  await build({ ...docsBuildConfig({ root: fixture.docs }), configFile: false, logLevel: 'silent' });
  const dist = path.join(fixture.docs, 'dist');
  const html = await readFile(path.join(dist, 'index.html'), 'utf8');
  using parsed = parsePage({ html });
  const script = parsed.document.querySelector('script:not([type])[src]')?.getAttribute('src');
  if (!script) {
    throw new Error('Missing bootstrap script');
  }
  const appEntry = parsed.document.querySelector('script[src^="/docs/assets/app-entry-"]')?.getAttribute('src');
  if (!appEntry) {
    throw new Error('Missing app entry client');
  }
  compiled = {
    html,
    script: await readFile(path.join(dist, script.slice('/docs/'.length)), 'utf8'),
    appEntryScript: await readFile(path.join(dist, appEntry.slice('/docs/'.length)), 'utf8'),
    en: await readFile(path.join(dist, 'en/index.html'), 'utf8'),
    ja: await readFile(path.join(dist, 'ja/index.html'), 'utf8'),
    missing: await readFile(path.join(dist, '404.html'), 'utf8'),
  };
});

describe('language-neutral entrance without navigation', () => {
  it('uses a same-origin classic head script for locale selection and separate home clients', () => {
    using page = parsePage({ html: entry().html });
    const script = page.document.querySelector('script:not([type])');
    expect(script?.parentElement).toBe(page.document.head);
    expect(script?.hasAttribute('type')).toBe(false);
    expect(script?.hasAttribute('async')).toBe(false);
    expect(script?.hasAttribute('defer')).toBe(false);
    expect(script?.textContent).toBe('');
    expect(script?.getAttribute('src')).toMatch(/^\/docs\/assets\/locale-.+\.js$/);
    expect(page.document.querySelector('script[type="module"]')?.getAttribute('src')).toMatch(/^\/docs\/assets\/island-search-.+\.js$/);
    expect(page.document.querySelector('script[src^="/docs/assets/home-brand-"]')).not.toBeNull();
    expect(page.document.querySelectorAll('script[src^="/docs/assets/app-entry-"]')).toHaveLength(1);
    expect(page.document.querySelectorAll('template[data-docs-locale]')).toHaveLength(2);
  });

  it.each([
    { locale: 'en', languages: ['en-US'] },
    { locale: 'ja', languages: ['ja-JP'] },
  ] as const)('rebases the mounted $locale hero launch to the browsing origin after locale selection', ({ locale, languages }) => {
    using browser = createBrowser({ url: 'https://preview.example/docs/', languages: [...languages] });
    const { document } = browser.dom.window;
    new Script(entry().script).runInContext(browser.dom.getInternalVMContext());
    using staticPage = parsePage({ html: entry().html });
    const template = staticPage.document.querySelector<HTMLTemplateElement>(`template[data-docs-locale="${locale}"]`);
    expect(template?.content.querySelector('[data-testid="docs-hero-launch"]')?.getAttribute('href')).toBe('https://naidan.nwtgck.org/#/');
    document.head.replaceChildren(...Array.from(staticPage.document.head.childNodes, node => document.importNode(node, true)));
    document.body.replaceChildren(...Array.from(staticPage.document.body.childNodes, node => document.importNode(node, true)));
    Object.defineProperty(document, 'readyState', { value: 'interactive', configurable: true });
    new Script(entry().appEntryScript).runInContext(browser.dom.getInternalVMContext());
    expect(document.querySelector('[data-docs-language-fallback]')).not.toBeNull();
    document.dispatchEvent(new browser.dom.window.Event('DOMContentLoaded'));
    const launch = document.querySelector<HTMLAnchorElement>('[data-testid="docs-hero-launch"]');
    expect(launch?.getAttribute('href')).toBe('https://preview.example/#/');
    expect(launch?.getAttribute('data-docs-app-entry-path')).toBe('/#/');
    expect(document.querySelector('[data-docs-language-fallback]')).toBeNull();
    expect(browser.errors).toEqual([]);
  });

  it.each(['en', 'ja'] as const)('rebases an already rendered $locale home without waiting for another event', locale => {
    using browser = createBrowser({ url: `https://preview.example/docs/${locale}/`, languages: [locale] });
    using staticPage = parsePage({ html: entry()[locale] });
    const { document } = browser.dom.window;
    document.body.replaceChildren(...Array.from(staticPage.document.body.childNodes, node => document.importNode(node, true)));
    const launch = document.querySelector<HTMLAnchorElement>('[data-testid="docs-hero-launch"]');
    expect(launch?.getAttribute('href')).toBe('https://naidan.nwtgck.org/#/');
    Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true });
    new Script(entry().appEntryScript).runInContext(browser.dom.getInternalVMContext());
    expect(launch?.getAttribute('href')).toBe('https://preview.example/#/');
    expect(launch?.tagName).toBe('A');
    expect(browser.errors).toEqual([]);
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
    const languageMenu = document.querySelector('[data-testid="docs-language-menu"]');
    expect(languageMenu?.tagName).toBe('DETAILS');
    expect(languageMenu?.querySelector(`a[lang="${locale}"]`)?.getAttribute('href')).toBe(`/docs/${locale}/`);
    expect(languageMenu?.querySelector(`a[lang="${locale === 'en' ? 'ja' : 'en'}"]`)?.getAttribute('href'))
      .toBe(locale === 'en' ? '/docs/ja/' : '/docs/en/');
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

  it.each([
    { locale: 'en', path: '/docs/en/' },
    { locale: 'ja', path: '/docs/ja/' },
    { locale: 'en', path: '/docs/en/index.html' },
    { locale: 'ja', path: '/docs/ja/index.html' },
  ] as const)('keeps the $path home hero and native brand link in static HTML, then recovers if the brand module fails', ({ locale, path }) => {
    using staticPage = parsePage({ html: entry()[locale] });
    expect(staticPage.document.documentElement.hasAttribute('data-docs-home-brand-startup')).toBe(false);
    expect(staticPage.document.querySelector('[data-docs-hero-brand]')).not.toBeNull();
    expect(staticPage.document.querySelector('[data-docs-brand-link]')?.getAttribute('href')).toBe(`/docs/${locale}/`);

    using browser = createBrowser({ url: `https://example.test${path}`, languages: [locale] });
    setMotionMedia({ dom: browser.dom });
    new Script(entry().script).runInContext(browser.dom.getInternalVMContext());
    expect(browser.dom.window.document.documentElement.dataset.docsHomeBrandStartup).toBe('pending');
    parseBody({ target: browser.dom, source: entry()[locale] });
    expect(browser.dom.window.document.documentElement.dataset.docsHomeBrandStartup).toBe('pending');
    expect(browser.dom.window.document.querySelector('[data-docs-brand-link]')?.getAttribute('href')).toBe(`/docs/${locale}/`);
    browser.dom.window.dispatchEvent(new browser.dom.window.Event('load'));
    expect(browser.dom.window.document.documentElement.dataset.docsHomeBrandStartup).toBe('aborted');
    expect(browser.errors).toEqual([]);
  });

  it.each([
    { state: 'paused', narrow: false, reduced: false, paused: true },
    { state: 'narrow', narrow: true, reduced: false, paused: false },
    { state: 'reduced', narrow: false, reduced: true, paused: false },
  ] as const)('does not hide the static brand when motion is $state', ({ narrow, reduced, paused }) => {
    using browser = createBrowser({ url: 'https://example.test/docs/ja/', languages: ['ja'] });
    setMotionMedia({ dom: browser.dom, narrow, reduced });
    if (paused) {
      browser.dom.window.localStorage.setItem('naidan_docs:settings', JSON.stringify({ theme: 'dark', motion: 'paused' }));
    }
    new Script(entry().script).runInContext(browser.dom.getInternalVMContext());
    expect(browser.dom.window.document.documentElement.dataset.docsHomeBrandStartup).toBe('ready');
  });

  it('abandons delayed brand motion after the single startup watchdog expires', () => {
    using browser = createBrowser({ url: 'https://example.test/docs/en/', languages: ['en'] });
    setMotionMedia({ dom: browser.dom });
    let watchdog: (() => void) | undefined;
    Object.defineProperty(browser.dom.window, 'setTimeout', {
      value: (callback: () => void) => {
        watchdog = callback;
        return 1;
      },
    });
    new Script(entry().script).runInContext(browser.dom.getInternalVMContext());
    expect(browser.dom.window.document.documentElement.dataset.docsHomeBrandStartup).toBe('pending');
    expect(watchdog).toBeTypeOf('function');
    watchdog?.();
    expect(browser.dom.window.document.documentElement.dataset.docsHomeBrandStartup).toBe('aborted');
    parseBody({ target: browser.dom, source: entry().en });
    expect(browser.dom.window.document.querySelector('[data-docs-brand-link]')?.getAttribute('href')).toBe('/docs/en/');
  });

  it('uses the same pending recovery for the language-neutral home without hiding its fallback links', () => {
    using browser = createBrowser({ url: 'https://example.test/docs/', languages: ['ja'] });
    setMotionMedia({ dom: browser.dom });
    new Script(entry().script).runInContext(browser.dom.getInternalVMContext());
    const { document } = browser.dom.window;
    expect(document.documentElement.dataset.docsHomeBrandStartup).toBe('pending');
    parseBody({ target: browser.dom, source: entry().html });
    expect(document.querySelector('[data-docs-language-fallback]')).toBeNull();
    expect(document.querySelector('[data-docs-hero-brand]')).not.toBeNull();
    expect(document.documentElement.dataset.docsHomeBrandStartup).toBe('pending');
    browser.dom.window.dispatchEvent(new browser.dom.window.Event('load'));
    expect(document.documentElement.dataset.docsHomeBrandStartup).toBe('aborted');
  });

  it('leaves article brand motion untouched', () => {
    using browser = createBrowser({ url: 'https://example.test/docs/en/browser-boundaries/', languages: ['en'] });
    setMotionMedia({ dom: browser.dom });
    new Script(entry().script).runInContext(browser.dom.getInternalVMContext());
    expect(browser.dom.window.document.documentElement.hasAttribute('data-docs-home-brand-startup')).toBe(false);
  });

  it('still mounts the neutral home when media detection fails', () => {
    using browser = createBrowser({ url: 'https://example.test/docs/', languages: ['en'] });
    Object.defineProperty(browser.dom.window, 'matchMedia', {
      value: () => {
        throw new Error('Media detection failed');
      },
    });
    expect(() => new Script(entry().script).runInContext(browser.dom.getInternalVMContext())).not.toThrow();
    expect(browser.dom.window.document.documentElement.dataset.docsHomeBrandStartup).toBe('ready');
    parseBody({ target: browser.dom, source: entry().html });
    expect(browser.dom.window.document.querySelector('[data-docs-hero-brand]')).not.toBeNull();
    expect(browser.dom.window.document.querySelector('[data-docs-language-fallback]')).toBeNull();
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

  it('restores preferences before an article body arrives and saves native control changes across locales', async () => {
    using en = createBrowser({ url: 'https://example.test/docs/en/', languages: ['ja'] });
    en.dom.window.document.documentElement.lang = 'en';
    en.dom.window.localStorage.setItem('naidan_docs:settings', JSON.stringify({ theme: 'light', motion: 'paused' }));
    new Script(entry().script).runInContext(en.dom.getInternalVMContext());
    expect(en.dom.window.document.documentElement.dataset.theme).toBe('light');
    expect(en.dom.window.document.documentElement.lang).toBe('en');
    expect(en.dom.window.document.body.textContent).toBe('');
    parseBody({ target: en.dom, source: entry().en });
    await Promise.resolve();
    const light = en.dom.window.document.querySelector<HTMLInputElement>('#docs-light-theme');
    const pause = en.dom.window.document.querySelector<HTMLInputElement>('#docs-pause-motion');
    expect(light?.checked).toBe(true);
    expect(pause?.checked).toBe(true);
    expect(en.dom.window.document.querySelectorAll('h1')).toHaveLength(1);
    expect(en.dom.window.document.documentElement.hasAttribute('data-docs-starting')).toBe(false);
    if (!light || !pause) {
      throw new Error('Missing Docs preference controls');
    }
    light.checked = false;
    light.dispatchEvent(new en.dom.window.Event('change', { bubbles: true }));
    expect(en.dom.window.document.documentElement.dataset.theme).toBe('dark');
    expect(JSON.parse(en.dom.window.localStorage.getItem('naidan_docs:settings') ?? '')).toEqual({ theme: 'dark', motion: 'paused' });

    using ja = createBrowser({ url: 'https://example.test/docs/ja/', languages: ['en'] });
    ja.dom.window.document.documentElement.lang = 'ja';
    ja.dom.window.localStorage.setItem('naidan_docs:settings', en.dom.window.localStorage.getItem('naidan_docs:settings') ?? '');
    new Script(entry().script).runInContext(ja.dom.getInternalVMContext());
    parseBody({ target: ja.dom, source: entry().ja });
    await Promise.resolve();
    expect(ja.dom.window.document.documentElement.lang).toBe('ja');
    expect(ja.dom.window.document.querySelector<HTMLInputElement>('#docs-light-theme')?.checked).toBe(false);
    expect(ja.dom.window.document.querySelector<HTMLInputElement>('#docs-pause-motion')?.checked).toBe(true);
    expect(ja.dom.window.document.querySelector('h1')?.textContent).toBeTruthy();
    expect(en.errors).toEqual([]);
    expect(ja.errors).toEqual([]);
  });

  it('restores controls after mounting the language-neutral home template', async () => {
    using browser = createBrowser({ url: 'https://example.test/docs/', languages: ['ja'] });
    browser.dom.window.localStorage.setItem('naidan_docs:settings', JSON.stringify({ theme: 'light', motion: 'paused' }));
    new Script(entry().script).runInContext(browser.dom.getInternalVMContext());
    expect(browser.dom.window.document.documentElement.dataset.theme).toBe('light');
    parseBody({ target: browser.dom, source: entry().html });
    await Promise.resolve();
    expect(browser.dom.window.document.documentElement.lang).toBe('ja');
    expect(browser.dom.window.document.querySelector<HTMLInputElement>('#docs-light-theme')?.checked).toBe(true);
    expect(browser.dom.window.document.querySelector<HTMLInputElement>('#docs-pause-motion')?.checked).toBe(true);
    expect(browser.errors).toEqual([]);
  });

  it('refreshes a restored article from storage after a back-forward cache navigation', async () => {
    using browser = createBrowser({ url: 'https://example.test/docs/en/', languages: ['en'] });
    browser.dom.window.localStorage.setItem('naidan_docs:settings', JSON.stringify({ theme: 'dark', motion: 'auto' }));
    new Script(entry().script).runInContext(browser.dom.getInternalVMContext());
    parseBody({ target: browser.dom, source: entry().en });
    await Promise.resolve();
    const light = browser.dom.window.document.querySelector<HTMLInputElement>('#docs-light-theme');
    const pause = browser.dom.window.document.querySelector<HTMLInputElement>('#docs-pause-motion');
    expect(light?.checked).toBe(false);
    expect(pause?.checked).toBe(false);
    const changes: string[] = [];
    light?.addEventListener('change', () => changes.push('theme'));
    pause?.addEventListener('change', () => changes.push('motion'));
    expect(changes).toEqual([]);
    const write = vi.spyOn(browser.dom.window.Storage.prototype, 'setItem');
    using _restoreWrite = { [Symbol.dispose]: () => write.mockRestore() };

    browser.dom.window.localStorage.setItem('naidan_docs:settings', JSON.stringify({ theme: 'light', motion: 'paused' }));
    restoreFromCache({ dom: browser.dom });
    expect(browser.dom.window.document.documentElement.dataset.theme).toBe('light');
    expect(light?.checked).toBe(true);
    expect(pause?.checked).toBe(true);
    expect(changes).toEqual(['theme', 'motion']);
    expect(write).toHaveBeenCalledTimes(1);

    restoreFromCache({ dom: browser.dom });
    expect(changes).toEqual(['theme', 'motion']);
    expect(write).toHaveBeenCalledTimes(1);
    browser.dom.window.localStorage.setItem('naidan_docs:settings', JSON.stringify({ theme: 'dark', motion: 'paused' }));
    restoreFromCache({ dom: browser.dom });
    expect(changes).toEqual(['theme', 'motion', 'theme']);
    expect(write).toHaveBeenCalledTimes(2);
    expect(browser.dom.window.document.querySelector('h1')?.textContent).toBeTruthy();
    expect(browser.errors).toEqual([]);
  });

  it('keeps the current selection when a saved value becomes unreadable during cache restore', async () => {
    using browser = createBrowser({ url: 'https://example.test/docs/en/', languages: ['en'] });
    new Script(entry().script).runInContext(browser.dom.getInternalVMContext());
    parseBody({ target: browser.dom, source: entry().en });
    await Promise.resolve();
    const light = browser.dom.window.document.querySelector<HTMLInputElement>('#docs-light-theme');
    const pause = browser.dom.window.document.querySelector<HTMLInputElement>('#docs-pause-motion');
    if (!light || !pause) {
      throw new Error('Missing Docs preference controls');
    }
    light.checked = true;
    light.dispatchEvent(new browser.dom.window.Event('change', { bubbles: true }));
    pause.checked = true;
    pause.dispatchEvent(new browser.dom.window.Event('change', { bubbles: true }));
    const read = vi.spyOn(browser.dom.window.Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('Read denied');
    });
    using _restoreRead = { [Symbol.dispose]: () => read.mockRestore() };
    const write = vi.spyOn(browser.dom.window.Storage.prototype, 'setItem');
    using _restoreWrite = { [Symbol.dispose]: () => write.mockRestore() };

    restoreFromCache({ dom: browser.dom });
    expect(light.checked).toBe(true);
    expect(pause.checked).toBe(true);
    expect(browser.dom.window.document.documentElement.dataset.theme).toBe('light');
    expect(read).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    expect(browser.errors).toEqual([]);
  });

  it('keeps an unsaved selection instead of restoring an older stored value', async () => {
    using browser = createBrowser({ url: 'https://example.test/docs/en/', languages: ['en'] });
    browser.dom.window.localStorage.setItem('naidan_docs:settings', JSON.stringify({ theme: 'dark', motion: 'auto' }));
    new Script(entry().script).runInContext(browser.dom.getInternalVMContext());
    parseBody({ target: browser.dom, source: entry().en });
    await Promise.resolve();
    const light = browser.dom.window.document.querySelector<HTMLInputElement>('#docs-light-theme');
    const pause = browser.dom.window.document.querySelector<HTMLInputElement>('#docs-pause-motion');
    if (!light || !pause) {
      throw new Error('Missing Docs preference controls');
    }
    const write = vi.spyOn(browser.dom.window.Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Write denied');
    });
    using _restoreWrite = { [Symbol.dispose]: () => write.mockRestore() };
    light.checked = true;
    light.dispatchEvent(new browser.dom.window.Event('change', { bubbles: true }));
    pause.checked = true;
    pause.dispatchEvent(new browser.dom.window.Event('change', { bubbles: true }));
    expect(write).toHaveBeenCalledTimes(2);
    expect(JSON.parse(browser.dom.window.localStorage.getItem('naidan_docs:settings') ?? '')).toEqual({ theme: 'dark', motion: 'auto' });

    restoreFromCache({ dom: browser.dom });
    expect(light.checked).toBe(true);
    expect(pause.checked).toBe(true);
    expect(browser.dom.window.document.documentElement.dataset.theme).toBe('light');
    expect(write).toHaveBeenCalledTimes(2);
    expect(browser.errors).toEqual([]);
  });

  it('keeps the current selection when stored data becomes invalid during cache restore', async () => {
    using browser = createBrowser({ url: 'https://example.test/docs/en/', languages: ['en'] });
    browser.dom.window.localStorage.setItem('naidan_docs:settings', JSON.stringify({ theme: 'light', motion: 'paused' }));
    new Script(entry().script).runInContext(browser.dom.getInternalVMContext());
    parseBody({ target: browser.dom, source: entry().en });
    await Promise.resolve();
    browser.dom.window.localStorage.setItem('naidan_docs:settings', '{broken');
    const write = vi.spyOn(browser.dom.window.Storage.prototype, 'setItem');
    using _restoreWrite = { [Symbol.dispose]: () => write.mockRestore() };

    restoreFromCache({ dom: browser.dom });
    expect(browser.dom.window.document.querySelector<HTMLInputElement>('#docs-light-theme')?.checked).toBe(true);
    expect(browser.dom.window.document.querySelector<HTMLInputElement>('#docs-pause-motion')?.checked).toBe(true);
    expect(browser.dom.window.document.documentElement.dataset.theme).toBe('light');
    expect(write).not.toHaveBeenCalled();
    expect(browser.errors).toEqual([]);
  });

  it.each(['{broken', '{"theme":"blue","motion":"paused"}'])('keeps the article readable with invalid saved preferences: %s', async stored => {
    using browser = createBrowser({ url: 'https://example.test/docs/en/', languages: ['en'] });
    browser.dom.window.localStorage.setItem('naidan_docs:settings', stored);
    new Script(entry().script).runInContext(browser.dom.getInternalVMContext());
    parseBody({ target: browser.dom, source: entry().en });
    await Promise.resolve();
    expect(browser.dom.window.document.documentElement.dataset.theme).toBe('dark');
    expect(browser.dom.window.document.querySelector<HTMLInputElement>('#docs-light-theme')?.checked).toBe(false);
    expect(browser.dom.window.document.querySelector<HTMLInputElement>('#docs-pause-motion')?.checked).toBe(false);
    expect(browser.dom.window.document.querySelector('h1')?.textContent).toBeTruthy();
    expect(browser.errors).toEqual([]);
  });

  it('does not read or migrate the retired Docs preference key', async () => {
    using browser = createBrowser({ url: 'https://example.test/docs/en/', languages: ['en'] });
    browser.dom.window.localStorage.setItem('naidan-docs-preferences', JSON.stringify({ theme: 'light', motion: 'paused' }));
    new Script(entry().script).runInContext(browser.dom.getInternalVMContext());
    parseBody({ target: browser.dom, source: entry().en });
    await Promise.resolve();
    expect(browser.dom.window.document.documentElement.dataset.theme).toBe('dark');
    expect(browser.dom.window.document.querySelector<HTMLInputElement>('#docs-pause-motion')?.checked).toBe(false);
    expect(browser.dom.window.localStorage.getItem('naidan_docs:settings')).toBeNull();
    expect(browser.errors).toEqual([]);
  });

  it('keeps native controls usable when storage access fails', async () => {
    using browser = createBrowser({ url: 'https://example.test/docs/en/', languages: ['en'] });
    Object.defineProperty(browser.dom.window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('Storage denied');
      },
    });
    new Script(entry().script).runInContext(browser.dom.getInternalVMContext());
    parseBody({ target: browser.dom, source: entry().en });
    await Promise.resolve();
    const light = browser.dom.window.document.querySelector<HTMLInputElement>('#docs-light-theme');
    const pause = browser.dom.window.document.querySelector<HTMLInputElement>('#docs-pause-motion');
    expect(light?.checked).toBe(false);
    expect(pause?.checked).toBe(false);
    if (!light || !pause) {
      throw new Error('Missing Docs preference controls');
    }
    light.checked = true;
    light.dispatchEvent(new browser.dom.window.Event('change', { bubbles: true }));
    pause.checked = true;
    pause.dispatchEvent(new browser.dom.window.Event('change', { bubbles: true }));
    expect(browser.dom.window.document.documentElement.dataset.theme).toBe('light');
    expect(light.checked).toBe(true);
    expect(pause.checked).toBe(true);
    restoreFromCache({ dom: browser.dom });
    expect(light.checked).toBe(true);
    expect(pause.checked).toBe(true);
    expect(browser.dom.window.document.documentElement.dataset.theme).toBe('light');
    expect(browser.dom.window.document.querySelector('h1')?.textContent).toBeTruthy();
    expect(browser.errors).toEqual([]);
  });

  it('applies the saved theme to the static 404 without mounting a locale template', () => {
    using browser = createBrowser({ url: 'https://example.test/docs/missing/', languages: ['ja'] });
    browser.dom.window.localStorage.setItem('naidan_docs:settings', JSON.stringify({ theme: 'light', motion: 'paused' }));
    new Script(entry().script).runInContext(browser.dom.getInternalVMContext());
    expect(browser.dom.window.document.documentElement.dataset.theme).toBe('light');
    expect(browser.dom.window.document.documentElement.hasAttribute('data-docs-starting')).toBe(false);
    parseBody({ target: browser.dom, source: entry().missing });
    expect(browser.dom.window.document.querySelector('[data-docs-language-fallback]')).toBeNull();
    expect(browser.dom.window.document.querySelector('#docs-pause-motion')).toBeNull();
    expect(browser.dom.window.document.querySelector('h1')?.textContent).toBe('Naidan Docs');
    expect(browser.errors).toEqual([]);
  });

  it('serves the same compiled bootstrap and templates in development', async () => {
    await using fixture = await createSiteFixture();
    await using dev = await startSiteDev({ root: fixture.root });
    const response = await dev.request({ url: '/docs/' });
    using page = parsePage({ html: await response.text() });
    const bootstrap = page.document.querySelector('script:not([type])[src]')?.getAttribute('src');
    expect(bootstrap).toBe('/docs/__locale.js');
    expect(page.document.querySelectorAll('script[src="/docs/client/app-entry.ts"]')).toHaveLength(1);
    if (!bootstrap) {
      throw new Error('Missing development locale bootstrap');
    }
    const asset = await dev.request({ url: bootstrap });
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('text/javascript');
    expect(await asset.text()).toBe(entry().script);
    for (const locale of ['en', 'ja'] as const) {
      const template = page.document.querySelector<HTMLTemplateElement>(`template[data-docs-locale="${locale}"]`);
      expect(template?.content.querySelectorAll('[data-docs-animation]').length).toBeGreaterThan(0);
      expect(template?.content.querySelector('h1')?.textContent).toBe(locale === 'en' ? 'An easy-to-use AI environment, built around privacy.' : '安全性を徹底追求した、簡単に使えるAI環境。');
      using article = parsePage({ html: await (await dev.request({ url: `/docs/${locale}/` })).text() });
      expect(article.document.querySelector('script:not([type])[src]')?.getAttribute('src')).toBe(bootstrap);
    }
    using missing = parsePage({ html: await (await dev.request({ url: '/docs/missing/' })).text() });
    expect(missing.document.querySelector('script:not([type])[src]')?.getAttribute('src')).toBe(bootstrap);
    const head = await dev.request({ url: '/docs/__locale.js', method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const post = await dev.request({ url: '/docs/__locale.js', method: 'POST' });
    expect(post.status).toBe(405);
  });
});
