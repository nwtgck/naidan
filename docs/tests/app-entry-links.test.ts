import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { JSDOM } from 'jsdom';
import AppEntryLink from '../site/AppEntryLink.vue';
import { appDestinationPath, appEntryFallbackUrl, appEntryUrl } from '../site/app-entry';
import { updateAppEntryLinks } from '../client/app-entry-enhancement';
import { createSiteFixture, startSiteDev } from './site.test-support';

describe('Docs app entry links', () => {
  it('uses app hash routes and preserves model launch query values', () => {
    expect(appDestinationPath({ destination: { kind: 'screen', screen: 'home' } })).toBe('/#/');
    expect(appDestinationPath({ destination: { kind: 'screen', screen: 'gguf-manager' } })).toBe('/#/settings/llama-cpp-browser');
    expect(appDestinationPath({ destination: { kind: 'screen', screen: 'transformers-js-manager' } })).toBe('/#/settings/transformers-js');
    expect(appDestinationPath({ destination: { kind: 'screen', screen: 'connection' } })).toBe('/#/settings/connection');
    expect(appDestinationPath({ destination: { kind: 'screen', screen: 'files-settings' } })).toBe('/#/settings/binary-objects');
    expect(appDestinationPath({ destination: { kind: 'screen', screen: 'folders-settings' } })).toBe('/#/settings/volumes');
    expect(appDestinationPath({ destination: { kind: 'screen', screen: 'image-generation' } })).toBe('/#/image-generation/');
    expect(appDestinationPath({ destination: { kind: 'screen', screen: 'audio-generation' } })).toBe('/#/audio-generation');
    const model = 'hf.co/LiquidAI/LFM2.5-230M-GGUF:Q4_K_M';
    const href = appEntryFallbackUrl({ destination: { kind: 'model', model } });
    const hashQuery = new URL(href).hash.split('?')[1];
    expect(new URLSearchParams(hashQuery).get('llama-cpp-browser-model')).toBe(model);
    expect(href).toMatch(/^https:\/\/naidan\.nwtgck\.org\/#\/\?/);
  });

  it.each([
    'https://naidan.pages.dev/docs/ja/images/create/',
    'https://naidan.nwtgck.org/docs/en/images/create/',
    'http://localhost:5173/docs/ja/images/create/',
  ])('resolves against the browsing origin from %s', locationHref => {
    const destination = { kind: 'screen', screen: 'image-generation' } as const;
    expect(appEntryUrl({ destination, base: locationHref })).toBe(`${new URL(locationHref).origin}/#/image-generation/`);
  });

  it.each(['en', 'ja'] as const)('shows the brand for the home link while retaining deep paths and model queries in %s', async locale => {
    const home = await renderToString(createSSRApp({ render: () => h(AppEntryLink, { destination: { kind: 'screen', screen: 'home' }, locale, display: 'path' }) }));
    const settings = await renderToString(createSSRApp({ render: () => h(AppEntryLink, { destination: { kind: 'screen', screen: 'gguf-manager' }, locale, display: 'path' }) }));
    const model = 'hf.co/owner/repository:Q4_K_M';
    const modelLink = await renderToString(createSSRApp({ render: () => h(AppEntryLink, { destination: { kind: 'model', model }, locale, display: 'path' }) }));
    const dom = new JSDOM(`${home}${settings}${modelLink}`, { url: `http://localhost:5173/docs/${locale}/` });
    try {
      const [homeAnchor, settingsAnchor, modelAnchor] = dom.window.document.querySelectorAll<HTMLAnchorElement>('a[data-docs-app-entry-path]');
      expect(homeAnchor?.textContent).toBe('Naidan');
      expect(homeAnchor?.getAttribute('data-docs-app-entry-path')).toBe('/#/');
      expect(homeAnchor?.getAttribute('href')).toBe('https://naidan.nwtgck.org/#/');
      expect(settingsAnchor?.textContent).toBe('/#/settings/llama-cpp-browser');
      expect(modelAnchor?.textContent).toBe(appDestinationPath({ destination: { kind: 'model', model } }));

      updateAppEntryLinks({ document: dom.window.document, locationHref: dom.window.location.href });

      expect(homeAnchor?.href).toBe('http://localhost:5173/#/');
      expect(homeAnchor?.textContent).toBe('Naidan');
      expect(settingsAnchor?.href).toBe('http://localhost:5173/#/settings/llama-cpp-browser');
      expect(new URLSearchParams(modelAnchor?.hash.split('?')[1]).get('llama-cpp-browser-model')).toBe(model);
    } finally {
      dom.window.close();
    }
  });

  it('rebases the link while keeping its visible path and SEO metadata unchanged', async () => {
    const destination = { kind: 'screen', screen: 'image-generation' } as const;
    const html = await renderToString(createSSRApp({ render: () => h(AppEntryLink, { destination, locale: 'ja', display: 'path' }) }));
    const dom = new JSDOM(`<!doctype html><head><link rel="canonical" href="https://naidan.nwtgck.org/docs/ja/images/create/"></head><body>${html}<a href="https://example.org/">Other site</a></body>`, { url: 'http://localhost:5173/docs/ja/images/create/' });
    try {
      const { document } = dom.window;
      const anchor = document.querySelector<HTMLAnchorElement>('a[data-docs-app-entry-path]');
      expect(anchor?.getAttribute('href')).toBe('https://naidan.nwtgck.org/#/image-generation/');
      expect(anchor?.querySelector('[data-docs-app-entry-path-text]')?.textContent).toBe('/#/image-generation/');
      expect(anchor?.querySelector('[data-docs-external-icon], .sr-only')).toBeNull();

      updateAppEntryLinks({ document, locationHref: dom.window.location.href });

      expect(anchor?.href).toBe('http://localhost:5173/#/image-generation/');
      expect(anchor?.querySelector('[data-docs-app-entry-path-text]')?.textContent).toBe('/#/image-generation/');
      expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe('https://naidan.nwtgck.org/docs/ja/images/create/');
      expect(document.querySelector('a[href="https://example.org/"]')).not.toBeNull();
    } finally {
      dom.window.close();
    }
  });

  it('updates a short model label while retaining its decoded launch value', async () => {
    const model = 'hf.co/ggml-org/gpt-oss-20b-GGUF:MXFP4';
    const html = await renderToString(createSSRApp({ render: () => h(AppEntryLink, { destination: { kind: 'model', model }, locale: 'en', display: 'label' }, () => 'gpt-oss-20b') }));
    const dom = new JSDOM(html, { url: 'https://naidan.pages.dev/docs/en/models/llama-cpp-browser/' });
    try {
      updateAppEntryLinks({ document: dom.window.document, locationHref: dom.window.location.href });
      const anchor = dom.window.document.querySelector<HTMLAnchorElement>('a[data-docs-app-entry-path]');
      expect(anchor?.href.startsWith('https://naidan.pages.dev/#/?')).toBe(true);
      expect(new URLSearchParams(anchor?.hash.split('?')[1]).get('llama-cpp-browser-model')).toBe(model);
      expect(anchor?.textContent).toContain('gpt-oss-20b');
      expect(anchor?.querySelector('[data-docs-app-entry-path-text]')).toBeNull();
      expect(anchor?.querySelector('[data-docs-external-icon], .sr-only')).toBeNull();
    } finally {
      dom.window.close();
    }
  });

  it('serves the independent enhancement only on pages with app entry links', async () => {
    await using fixture = await createSiteFixture();
    await using dev = await startSiteDev({ root: fixture.root });
    const article = new JSDOM(await (await dev.request({ url: '/docs/ja/images/create/' })).text());
    const transformersArticle = new JSDOM(await (await dev.request({ url: '/docs/ja/models/transformers-js/' })).text());
    const unrelated = new JSDOM(await (await dev.request({ url: '/docs/ja/about/open-source/' })).text());
    try {
      const anchor = article.window.document.querySelector('a[data-docs-app-entry-path]');
      expect(anchor?.getAttribute('href')).toBe('https://naidan.nwtgck.org/#/image-generation/');
      expect(anchor?.querySelector('[data-docs-app-entry-path-text]')?.textContent).toBe('/#/image-generation/');
      expect(anchor?.querySelector('[data-docs-external-icon], .sr-only')).toBeNull();
      expect(article.window.document.querySelector('script[src="/docs/client/app-entry.ts"]')).not.toBeNull();
      expect(transformersArticle.window.document.querySelector('a[data-docs-app-entry-path="/#/settings/transformers-js"] [data-docs-app-entry-path-text]')?.textContent).toBe('/#/settings/transformers-js');
      expect(transformersArticle.window.document.querySelector('script[src="/docs/client/app-entry.ts"]')).not.toBeNull();
      expect(unrelated.window.document.querySelector('script[src="/docs/client/app-entry.ts"]')).toBeNull();
    } finally {
      article.window.close();
      transformersArticle.window.close();
      unrelated.window.close();
    }
  });
});
