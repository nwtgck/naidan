import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { docsBuildConfig } from '../build/production';
import { createDocsSitemap, DOCS_PUBLIC_ORIGIN, docsSeoLinks } from '../build/seo';
import { DOCS_LOCALES, DOCS_PAGES, docsHref } from '../navigation/routes';
import { SITE_METADATA } from '../../src/logic/document-metadata';
import { createSiteFixture, parsePage, startSiteDev } from './site.test-support';

describe('Docs search metadata', () => {
  it('advertises the Docs sitemap from the public robots file', async () => {
    const robots = await readFile(new URL('../../public/robots.txt', import.meta.url), 'utf8');
    expect(DOCS_PUBLIC_ORIGIN).toBe(SITE_METADATA.url);
    expect(robots).toContain(`Sitemap: ${DOCS_PUBLIC_ORIGIN}/docs/sitemap.xml`);
  });

  it('emits a sitemap whose URLs and language clusters match every static HTML head', async () => {
    await using fixture = await createSiteFixture();
    await build({ ...docsBuildConfig({ root: fixture.docs }), configFile: false, logLevel: 'silent' });
    const output = path.join(fixture.docs, 'dist');
    const xml = await readFile(path.join(output, 'sitemap.xml'), 'utf8');
    expect(xml).toBe(createDocsSitemap());
    const sitemap = new JSDOM(xml, { contentType: 'application/xml' });
    using _sitemap = { [Symbol.dispose]: () => sitemap.window.close() };
    const document = sitemap.window.document;
    expect(document.querySelector('parsererror')).toBeNull();
    expect(document.documentElement.namespaceURI).toBe('http://www.sitemaps.org/schemas/sitemap/0.9');
    const entries = Array.from(document.getElementsByTagNameNS('http://www.sitemaps.org/schemas/sitemap/0.9', 'url'));
    expect(entries).toHaveLength(1 + DOCS_LOCALES.length * DOCS_PAGES.length);
    const urls = new Set<string>();
    const check = ({ html, canonical, alternates }: {
      html: string;
      canonical: string;
      alternates: Array<{ language: string; href: string }>;
    }) => {
      using page = parsePage({ html });
      expect(page.document.querySelectorAll('link[rel="canonical"]')).toHaveLength(1);
      expect(page.document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(canonical);
      const htmlAlternates = Array.from(page.document.querySelectorAll('link[rel="alternate"][hreflang]'), link => ({
        language: link.getAttribute('hreflang'),
        href: link.getAttribute('href'),
      }));
      expect(htmlAlternates).toEqual(alternates);
      const entry = entries.find(candidate => candidate.getElementsByTagNameNS('http://www.sitemaps.org/schemas/sitemap/0.9', 'loc')[0]?.textContent === canonical);
      expect(entry).toBeDefined();
      const xmlAlternates = Array.from(entry?.getElementsByTagNameNS('http://www.w3.org/1999/xhtml', 'link') ?? [], link => ({
        language: link.getAttribute('hreflang'),
        href: link.getAttribute('href'),
      }));
      expect(xmlAlternates).toEqual(alternates);
      expect(urls.has(canonical)).toBe(false);
      urls.add(canonical);
    };
    const root = docsSeoLinks({ route: { kind: 'root' } });
    check({ html: await readFile(path.join(output, 'index.html'), 'utf8'), ...root });
    for (const locale of DOCS_LOCALES) {
      for (const page of DOCS_PAGES) {
        const href = docsHref({ locale, page: page.id });
        const seo = docsSeoLinks({ route: { kind: 'page', locale, page: page.id } });
        expect(seo.canonical).toBe(`https://naidan.nwtgck.org${href}`);
        check({ html: await readFile(path.join(output, href.slice('/docs/'.length), 'index.html'), 'utf8'), ...seo });
      }
    }
    expect(urls.size).toBe(entries.length);
    using missing = parsePage({ html: await readFile(path.join(output, '404.html'), 'utf8') });
    expect(missing.document.querySelector('link[rel="canonical"], link[hreflang]')).toBeNull();
    expect(missing.document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex');
    expect(xml).not.toMatch(/<lastmod>|<priority>|<changefreq>/);
  });

  it('serves the same sitemap and static metadata in development', async () => {
    await using fixture = await createSiteFixture();
    await using dev = await startSiteDev({ root: fixture.root });
    const sitemap = await dev.request({ url: '/docs/sitemap.xml?check=1' });
    expect(sitemap.status).toBe(200);
    expect(sitemap.headers.get('content-type')).toContain('application/xml');
    expect(await sitemap.text()).toBe(createDocsSitemap());
    const head = await dev.request({ url: '/docs/sitemap.xml', method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const response = await dev.request({ url: '/docs/ja/endpoint-type-ollama/' });
    expect(response.status).toBe(200);
    using page = parsePage({ html: await response.text() });
    expect(page.document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe('https://naidan.nwtgck.org/docs/ja/endpoint-type-ollama/');
    expect(Array.from(page.document.querySelectorAll('link[hreflang]'), link => link.getAttribute('href'))).toEqual([
      'https://naidan.nwtgck.org/docs/en/endpoint-type-ollama/',
      'https://naidan.nwtgck.org/docs/ja/endpoint-type-ollama/',
    ]);
  });
});
