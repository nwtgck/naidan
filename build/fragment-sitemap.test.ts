// @vitest-environment node
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { build, createServer, type ViteDevServer } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { parseQuery } from 'vue-router';
import { hfRepositories } from '../src/features/llama-cpp-browser/hugging-face/model-repositories';
import { modelSuggestions } from '../src/features/llama-cpp-browser/hugging-face/model-suggestions';
import { SITE_METADATA } from '../src/logic/document-metadata';
import { createFragmentSitemapPlugin, TEST_ONLY } from './fragment-sitemap';

// Removing every recommendation must still retain the registered launch URLs.
vi.mock('../src/features/llama-cpp-browser/hugging-face/model-suggestions', () => ({
  modelSuggestions: [],
  preferredQuantizationHint: () => {
    throw new Error('Sitemap must not select current recommendations');
  },
}));

// Keep this baseline independent of the registry so accidental deletions fail.
// New launch URLs may be added without removing these retained references.
const retainedLaunches = [
  'hf.co/ggml-org/gpt-oss-20b-GGUF:MXFP4',
  'hf.co/ggml-org/Qwen3.6-35B-A3B-GGUF:Q4_K_M',
  'hf.co/ggml-org/Qwen3.8-27B-GGUF:Q4_K_M',
  'hf.co/google/gemma-4-26B-A4B-it-qat-q4_0-gguf:Q4_0',
  'hf.co/google/gemma-4-E2B-it-qat-q4_0-gguf:Q4_0',
  'hf.co/google/gemma-4-E4B-it-qat-q4_0-gguf:Q4_0',
  'hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M',
  'hf.co/LiquidAI/LFM2.5-230M-GGUF:Q4_K_M',
  'hf.co/lmstudio-community/gemma-4-26B-A4B-it-GGUF:Q4_K_M',
  'hf.co/lmstudio-community/gemma-4-E2B-it-GGUF:Q4_K_M',
  'hf.co/lmstudio-community/gemma-4-E4B-it-GGUF:Q4_K_M',
  'hf.co/lmstudio-community/Qwen3.5-9B-GGUF:Q4_K_M',
  'hf.co/lmstudio-community/SmolLM2-135M-Instruct-GGUF:Q4_K_M',
  'hf.co/meta-models/Muse-Glimmer-30B-GGUF:Q4_K_M',
];

async function request({ server, method, url }: { server: ViteDevServer, method: string, url: string }) {
  const socket = new Socket();
  using _socket = { [Symbol.dispose]: () => socket.destroy() };
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = url;
  const res = new ServerResponse(req);
  let body: unknown;
  await new Promise<void>(resolve => {
    vi.spyOn(res, 'end').mockImplementation(chunk => {
      body = chunk;
      resolve();
      return res;
    });
    server.middlewares(req, res);
  });
  return { status: res.statusCode, contentType: res.getHeader('Content-Type'), length: res.getHeader('Content-Length'), body };
}

describe('fragment sitemap', () => {
  it('builds every registered launch and README link even when no model is recommended', async () => {
    expect(modelSuggestions).toEqual([]);
    const root = await mkdtemp(path.join(tmpdir(), 'naidan-fragment-sitemap-'));
    await using _fixture = { [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }) };
    await writeFile(path.join(root, 'index.html'), '<!doctype html><title>fixture</title>');
    await build({ configFile: false, root, mode: 'hosted', logLevel: 'silent', publicDir: false, plugins: [createFragmentSitemapPlugin()] });
    const sitemap = readFileSync(path.join(root, 'dist/sitemap.xml'), 'utf8');
    const dom = new JSDOM(sitemap, { contentType: 'application/xml' });
    using _dom = { [Symbol.dispose]: () => dom.window.close() };
    const document = dom.window.document;
    expect(document.documentElement.namespaceURI).toBe('http://www.sitemaps.org/schemas/sitemap/0.9');
    const urls = [...document.querySelectorAll('url > loc')].map(loc => new URL(loc.textContent ?? ''));
    const base = new URL('/', SITE_METADATA.url).href;
    expect(urls.slice(0, 3).map(url => url.href)).toEqual([base, `${base}#/image-generation`, `${base}#/audio-generation`]);
    expect(new Set(urls.map(url => url.href)).size).toBe(urls.length);
    for (const url of urls) {
      expect(url.origin).toBe(new URL(SITE_METADATA.url).origin);
      expect(url.pathname).toBe('/');
      expect(url.search).toBe('');
    }
    const modelUrls = urls.slice(3);
    const launches = modelUrls.map(url => {
      expect(url.hash.startsWith('#/?')).toBe(true);
      const query = parseQuery(url.hash.slice(3));
      expect(Object.keys(query)).toEqual(['llama-cpp-browser-model']);
      expect(query['llama-cpp-browser-model']).toMatch(/^hf\.co\/[^/]+\/[^/:]+:[^:]+$/);
      return query['llama-cpp-browser-model'];
    });
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const readmeLaunches = [...readme.matchAll(/\]\(https:\/\/naidan\.pages\.dev\/#\/\?llama-cpp-browser-model=([^\s)]+)\)/g)].map(match => decodeURIComponent(match[1] ?? ''));
    expect(readmeLaunches.length).toBeGreaterThan(0);
    expect(launches).toEqual(hfRepositories.flatMap(entry => entry.sitemapQuantizations.map(quantization => `hf.co/${entry.hfRepository}:${quantization}`)));
    for (const launch of retainedLaunches) {
      expect(launches).toContain(launch);
    }
    for (const launch of readmeLaunches) {
      expect(launches).toContain(launch);
    }
    expect(launches).toContain('hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M');
    expect(launches).toContain('hf.co/lmstudio-community/gemma-4-E2B-it-GGUF:Q4_K_M');
    const robots = readFileSync(new URL('../public/robots.txt', import.meta.url), 'utf8');
    expect(robots).toContain(`Sitemap: ${new URL('/sitemap.xml', SITE_METADATA.url).href}`);
  });

  it('retains distinct repositories and older quantizations while deduplicating identical URLs', () => {
    const sitemap = TEST_ONLY.createFragmentSitemap({
      repositories: [
        { hfRepository: 'LiquidAI/LFM2.5-2.6B-GGUF', sitemapQuantizations: ['Q4_K_M', 'Q8_0', 'Q4_K_M'] },
        { hfRepository: 'another-owner/LFM2.5-2.6B-GGUF', sitemapQuantizations: ['Q4_K_M'] },
        { hfRepository: 'LiquidAI/LFM2.5-2.6B-GGUF', sitemapQuantizations: ['Q4_K_M'] },
      ],
    });
    const dom = new JSDOM(sitemap, { contentType: 'application/xml' });
    using _dom = { [Symbol.dispose]: () => dom.window.close() };
    const launches = [...dom.window.document.querySelectorAll('url > loc')].slice(3).map(loc => {
      const url = new URL(loc.textContent ?? '');
      return parseQuery(url.hash.slice(3))['llama-cpp-browser-model'];
    });
    expect(launches).toEqual([
      'hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M',
      'hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q8_0',
      'hf.co/another-owner/LFM2.5-2.6B-GGUF:Q4_K_M',
    ]);
  });

  it('serves the same XML in development and leaves unrelated requests to Vite', async () => {
    const server = await createServer({
      configFile: false,
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true, hmr: false, watch: null },
      plugins: [createFragmentSitemapPlugin(), {
        name: 'sitemap-test-downstream',
        configureServer(server) {
          server.middlewares.use((_req, res) => {
            res.statusCode = 418;
            res.end('downstream');
          });
        },
      }],
    });
    await using _server = { [Symbol.asyncDispose]: () => server.close() };
    const get = await request({ server, method: 'GET', url: '/sitemap.xml?cache=1' });
    expect(get.status).toBe(200);
    expect(get.contentType).toBe('application/xml; charset=utf-8');
    expect(typeof get.body).toBe('string');
    if (typeof get.body !== 'string') {
      throw new Error('Expected XML response');
    }
    expect(get.body).toContain('hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M');
    expect(get.length).toBe(Buffer.byteLength(get.body));
    const head = await request({ server, method: 'HEAD', url: '/sitemap.xml' });
    expect(head).toEqual({ status: 200, contentType: get.contentType, length: get.length, body: undefined });
    for (const { method, url } of [{ method: 'POST', url: '/sitemap.xml' }, { method: 'GET', url: '/other.xml' }]) {
      expect(await request({ server, method, url })).toMatchObject({ status: 418, body: 'downstream' });
    }
  });

  it('does not emit a sitemap in the file protocol standalone build', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'naidan-fragment-sitemap-'));
    await using _fixture = { [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }) };
    await writeFile(path.join(root, 'index.html'), '<!doctype html><title>fixture</title>');
    await build({ configFile: false, root, mode: 'standalone', logLevel: 'silent', publicDir: false, plugins: [createFragmentSitemapPlugin()] });
    expect(() => readFileSync(path.join(root, 'dist/sitemap.xml'))).toThrow();
  });
});
