// @vitest-environment node
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { createModelPageFixture, createModelPageDev, requestModelPage, replacePageSource } from './model-page.test-support';
import { createSiteSitemap } from './site-sitemap';
import { listModelPageEntries } from '../src/features/llama-cpp-browser/model-launch/page-entries';

const pathname = '/llama-cpp-browser/hf.co/LiquidAI/LFM2.5-230M-GGUF/';

describe('model page Vite development middleware', () => {
  it('serves real transformed HTML, HMR client and identical GET/HEAD sitemap metadata', async () => {
    await using fixture = await createModelPageFixture();
    await using dev = await createModelPageDev({ root: fixture.root });
    const response = await requestModelPage({ server: dev.server, method: 'GET', url: pathname });
    expect(response.status).toBe(200);
    expect(response.contentType).toBe('text/html; charset=utf-8');
    const dom = new JSDOM(String(response.body), { url: `http://localhost:5173${pathname}` });
    using _dom = { [Symbol.dispose]: () => dom.window.close() };
    expect(dom.window.document.title).toBe('LFM2.5-230M — Local LLM on your device, in your browser | Naidan');
    expect(dom.window.document.querySelector('script[src="/@vite/client"]')).not.toBeNull();
    expect(dom.window.document.querySelector('script[src="/entry.ts"]')).not.toBeNull();
    expect(dom.window.document.baseURI).toBe('http://localhost:5173/');
    const head = await requestModelPage({ server: dev.server, method: 'HEAD', url: pathname });
    expect(head).toEqual({ ...response, body: undefined });
    const sitemap = await requestModelPage({ server: dev.server, method: 'GET', url: '/sitemap.xml?cache=1' });
    expect(sitemap.status).toBe(200);
    expect(sitemap.contentType).toBe('application/xml; charset=utf-8');
    expect(sitemap.body).toBe(createSiteSitemap({ entries: listModelPageEntries() }));
    const sitemapHead = await requestModelPage({ server: dev.server, method: 'HEAD', url: '/sitemap.xml' });
    expect(sitemapHead).toEqual({ ...sitemap, body: undefined });
    expect(sitemap.length).toBe(Buffer.byteLength(String(sitemap.body)));
    for (const { method, url } of [{ method: 'POST', url: '/sitemap.xml' }, { method: 'GET', url: '/docs/en/' }, { method: 'GET', url: '/other.xml' }, { method: 'GET', url: '/' }]) {
      expect(await requestModelPage({ server: dev.server, method, url })).toMatchObject({ status: 418, body: 'downstream' });
    }
  });

  it('redirects only known noncanonical paths and serves the public shell for unlisted or invalid paths', async () => {
    await using fixture = await createModelPageFixture();
    await using dev = await createModelPageDev({ root: fixture.root });
    for (const url of [pathname.slice(0, -1), pathname.replace('LiquidAI', '%4CiquidAI')]) {
      expect(await requestModelPage({ server: dev.server, method: 'GET', url: `${url}?utm_source=x` })).toMatchObject({ status: 308, location: `${pathname}?utm_source=x` });
    }
    for (const url of ['/llama-cpp-browser', '/llama-cpp-browser/', '/llama-cpp-browser/hf.co/owner/Unknown/', pathname.replace('hf.co/', 'hf.co%2F'), pathname.replace('LiquidAI', 'Liquid%2541I')]) {
      const response = await requestModelPage({ server: dev.server, method: 'GET', url });
      expect(response.status).toBe(200);
      expect(response.body).toContain('src="/@vite/client"');
      expect(response.body).toContain('data-naidan-hosted-base');
      expect(response.body).not.toContain('This model page is not published');
    }
  });

  it('refreshes registry, document copy and sitemap after file changes without restarting Vite', async () => {
    await using fixture = await createModelPageFixture();
    await using dev = await createModelPageDev({ root: fixture.root });
    await requestModelPage({ server: dev.server, method: 'GET', url: pathname });
    const send = vi.spyOn(dev.server.ws, 'send');
    using _send = { [Symbol.dispose]: () => send.mockRestore() };
    const newPath = pathname.replace('LFM2.5-230M', 'LFM2.5-231M');
    const registryFile = await replacePageSource({ root: fixture.root, file: 'src/features/llama-cpp-browser/hugging-face/model-repositories.ts', before: 'LiquidAI/LFM2.5-230M-GGUF', after: 'LiquidAI/LFM2.5-231M-GGUF' });
    dev.server.watcher.emit('change', registryFile);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'full-reload' }));
    await vi.waitFor(async () => expect((await requestModelPage({ server: dev.server, method: 'GET', url: newPath })).status).toBe(200));
    const removed = await requestModelPage({ server: dev.server, method: 'GET', url: pathname });
    expect(removed.status).toBe(200);
    expect(removed.body).not.toContain('data-model-page-fallback');
    expect((await requestModelPage({ server: dev.server, method: 'GET', url: '/sitemap.xml' })).body).toContain('LFM2.5-231M');
    send.mockClear();
    const copyFile = await replacePageSource({ root: fixture.root, file: 'src/features/llama-cpp-browser/model-launch/document-metadata.ts', before: 'Local LLM on your device', after: 'Local LLM on this device' });
    dev.server.watcher.emit('change', copyFile);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'full-reload' }));
    await vi.waitFor(async () => expect((await requestModelPage({ server: dev.server, method: 'GET', url: newPath })).body).toContain('Local LLM on this device'));
    expect(dev.server.config.root).toBe(path.resolve(fixture.root));
  });
});
