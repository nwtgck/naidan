// @vitest-environment node
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { describe, expect, it } from 'vitest';
import { HOME_METADATA, SITE_METADATA } from '../src/logic/document-metadata';
import { createDocumentMetadataHtmlPlugin } from './document-metadata-html';

describe('initial document metadata', () => {
  it('generates the app head from shared copy in Vite while leaving the broker page alone', async () => {
    const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true }, plugins: [createDocumentMetadataHtmlPlugin()] });
    await using _cleanup = { [Symbol.asyncDispose]: () => server.close() };
    const template = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const html = await server.transformIndexHtml('/index.html', template);
    const dom = new JSDOM(html);
    using _documentCleanup = { [Symbol.dispose]: () => dom.window.close() };
    const document = dom.window.document;
    expect(document.title).toBe(HOME_METADATA.title);
    for (const selector of ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]']) {
      expect(document.querySelectorAll(selector)).toHaveLength(1);
      expect(document.querySelector(selector)?.getAttribute('content')).toBe(SITE_METADATA.description);
    }
    expect(document.querySelector('meta[property="og:title"]')?.getAttribute('content')).toBe(HOME_METADATA.title);
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(SITE_METADATA.url);
    expect(JSON.parse(document.querySelector('script[type="application/ld+json"]')?.textContent ?? '{}')).toMatchObject({ name: 'Naidan', description: SITE_METADATA.description });
    const broker = readFileSync(new URL('../privacy-fetch-broker.html', import.meta.url), 'utf8');
    const brokerHtml = await server.transformIndexHtml('/privacy-fetch-broker.html', broker);
    expect(brokerHtml).not.toContain(HOME_METADATA.title);
    expect(brokerHtml).not.toContain('application/ld+json');
  });
});
