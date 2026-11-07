// @vitest-environment node
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { createModelSeoFixture, createModelSeoDev, requestModelSeo, replaceSeoSource } from './model-seo.test-support';
import { createSiteSitemap } from './site-sitemap';
import { listModelSeoEntries } from '../src/features/llama-cpp-browser/model-launch/seo-entries';

const pathname = '/llama-cpp-browser/hf.co/LiquidAI/LFM2.5-230M-GGUF:Q4_K_M/';

describe('model SEO Vite development middleware', () => {
  it('serves real transformed HTML, HMR client and identical GET/HEAD sitemap metadata', async () => {
    await using fixture = await createModelSeoFixture();
    await using dev = await createModelSeoDev({ root: fixture.root });
    const response = await requestModelSeo({ server: dev.server, method: 'GET', url: pathname });
    expect(response.status).toBe(200);
    expect(response.contentType).toBe('text/html; charset=utf-8');
    const dom = new JSDOM(String(response.body), { url: `http://localhost:5173${pathname}` });
    using _dom = { [Symbol.dispose]: () => dom.window.close() };
    expect(dom.window.document.title).toBe('LFM2.5-230M Q4_K_M — Local LLM on your device, in your browser | Naidan');
    expect(dom.window.document.querySelector('script[src="/@vite/client"]')).not.toBeNull();
    expect(dom.window.document.querySelector('script[src="/entry.ts"]')).not.toBeNull();
    expect(dom.window.document.baseURI).toBe('http://localhost:5173/');
    const head = await requestModelSeo({ server: dev.server, method: 'HEAD', url: pathname });
    expect(head).toEqual({ ...response, body: undefined });
    const sitemap = await requestModelSeo({ server: dev.server, method: 'GET', url: '/sitemap.xml?cache=1' });
    expect(sitemap.status).toBe(200);
    expect(sitemap.contentType).toBe('application/xml; charset=utf-8');
    expect(sitemap.body).toBe(createSiteSitemap({ entries: listModelSeoEntries() }));
    const sitemapHead = await requestModelSeo({ server: dev.server, method: 'HEAD', url: '/sitemap.xml' });
    expect(sitemapHead).toEqual({ ...sitemap, body: undefined });
    expect(sitemap.length).toBe(Buffer.byteLength(String(sitemap.body)));
    for (const { method, url } of [{ method: 'POST', url: '/sitemap.xml' }, { method: 'GET', url: '/docs/en/' }, { method: 'GET', url: '/other.xml' }, { method: 'GET', url: '/' }]) {
      expect(await requestModelSeo({ server: dev.server, method, url })).toMatchObject({ status: 418, body: 'downstream' });
    }
  });

  it('redirects only known noncanonical paths and returns real 404 responses for invalid or unpublished paths', async () => {
    await using fixture = await createModelSeoFixture();
    await using dev = await createModelSeoDev({ root: fixture.root });
    for (const url of [pathname.slice(0, -1), pathname.replace(':', '%3A')]) {
      expect(await requestModelSeo({ server: dev.server, method: 'GET', url: `${url}?utm_source=x` })).toMatchObject({ status: 308, location: `${pathname}?utm_source=x` });
    }
    for (const url of ['/llama-cpp-browser', '/llama-cpp-browser/', '/llama-cpp-browser/hf.co/owner/Unknown:Q4_K_M/', pathname.replace('hf.co/', 'hf.co%2F'), pathname.replace(':', '%253A')]) {
      const response = await requestModelSeo({ server: dev.server, method: 'GET', url });
      expect(response.status).toBe(404);
      expect(response.body).toContain('noindex');
    }
  });

  it('refreshes registry, document copy and sitemap after file changes without restarting Vite', async () => {
    await using fixture = await createModelSeoFixture();
    await using dev = await createModelSeoDev({ root: fixture.root });
    await requestModelSeo({ server: dev.server, method: 'GET', url: pathname });
    const send = vi.spyOn(dev.server.ws, 'send');
    using _send = { [Symbol.dispose]: () => send.mockRestore() };
    const newPath = pathname.replace('LFM2.5-230M', 'LFM2.5-231M');
    const registryFile = await replaceSeoSource({ root: fixture.root, file: 'src/features/llama-cpp-browser/hugging-face/model-repositories.ts', before: 'LiquidAI/LFM2.5-230M-GGUF', after: 'LiquidAI/LFM2.5-231M-GGUF' });
    dev.server.watcher.emit('change', registryFile);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'full-reload' }));
    await vi.waitFor(async () => expect((await requestModelSeo({ server: dev.server, method: 'GET', url: newPath })).status).toBe(200));
    expect((await requestModelSeo({ server: dev.server, method: 'GET', url: pathname })).status).toBe(404);
    expect((await requestModelSeo({ server: dev.server, method: 'GET', url: '/sitemap.xml' })).body).toContain('LFM2.5-231M');
    send.mockClear();
    const copyFile = await replaceSeoSource({ root: fixture.root, file: 'src/features/llama-cpp-browser/model-launch/document-metadata.ts', before: 'Local LLM on your device', after: 'Local LLM on this device' });
    dev.server.watcher.emit('change', copyFile);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'full-reload' }));
    await vi.waitFor(async () => expect((await requestModelSeo({ server: dev.server, method: 'GET', url: newPath })).body).toContain('Local LLM on this device'));
    expect(dev.server.config.root).toBe(path.resolve(fixture.root));
  });
});
