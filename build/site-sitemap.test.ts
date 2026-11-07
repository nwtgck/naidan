// @vitest-environment node
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { build } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { hfRepositories } from '../src/features/llama-cpp-browser/hugging-face/model-repositories';
import { modelSuggestions } from '../src/features/llama-cpp-browser/hugging-face/model-suggestions';
import { listModelSeoEntries, modelSeoEntries } from '../src/features/llama-cpp-browser/model-launch/seo-entries';
import { modelIdFromSeoPath } from '../src/features/llama-cpp-browser/model-launch/seo-url';
import { SITE_METADATA } from '../src/logic/document-metadata';
import { createSiteSitemap, createSiteSitemapPlugin } from './site-sitemap';

vi.mock('../src/features/llama-cpp-browser/hugging-face/model-suggestions', () => ({
  modelSuggestions: [],
  preferredQuantizationHint: () => {
    throw new Error('Sitemap must not select current recommendations');
  },
}));

// Retained publications are independent of the recommendation list.
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

describe('site sitemap', () => {
  it('includes every retained model and README reference using public paths even without recommendations', () => {
    expect(modelSuggestions).toEqual([]);
    const dom = new JSDOM(createSiteSitemap({ entries: listModelSeoEntries() }), { contentType: 'application/xml' });
    using _dom = { [Symbol.dispose]: () => dom.window.close() };
    expect(dom.window.document.documentElement.namespaceURI).toBe('http://www.sitemaps.org/schemas/sitemap/0.9');
    const urls = [...dom.window.document.querySelectorAll('url > loc')].map(loc => new URL(loc.textContent ?? ''));
    const root = new URL('/', SITE_METADATA.url).href;
    expect(urls.slice(0, 3).map(url => url.href)).toEqual([root, `${root}#/image-generation`, `${root}#/audio-generation`]);
    expect(new Set(urls.map(url => url.href)).size).toBe(urls.length);
    const launches = urls.slice(3).map(url => {
      expect(url.origin).toBe(new URL(SITE_METADATA.url).origin);
      expect(url.search).toBe('');
      expect(url.hash).toBe('');
      return modelIdFromSeoPath({ pathname: url.pathname });
    });
    expect(launches).toEqual(hfRepositories.flatMap(entry => entry.seoPageQuantizations.map(quantization => `hf.co/${entry.hfRepository}:${quantization}`)));
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const readmeLaunches = [...readme.matchAll(/\]\(https:\/\/naidan\.pages\.dev\/#\/\?llama-cpp-browser-model=([^\s)]+)\)/g)].map(match => decodeURIComponent(match[1] ?? ''));
    expect(readmeLaunches.length).toBeGreaterThan(0);
    for (const launch of [...retainedLaunches, ...readmeLaunches]) {
      expect(launches).toContain(launch);
    }
    expect(readFileSync(new URL('../public/robots.txt', import.meta.url), 'utf8')).toContain(`Sitemap: ${root}sitemap.xml`);
  });

  it('retains distinct repositories and older quantizations and deduplicates identical sitemap URLs', () => {
    const entries = modelSeoEntries({
      repositories: [
        { hfRepository: 'LiquidAI/LFM2.5-2.6B-GGUF', seoPageQuantizations: ['Q4_K_M', 'Q8_0'] },
        { hfRepository: 'another-owner/LFM2.5-2.6B-GGUF', seoPageQuantizations: ['Q4_K_M'] },
      ],
    });
    const dom = new JSDOM(createSiteSitemap({ entries: [...entries, ...entries] }), { contentType: 'application/xml' });
    using _dom = { [Symbol.dispose]: () => dom.window.close() };
    expect([...dom.window.document.querySelectorAll('url > loc')].slice(3).map(loc => modelIdFromSeoPath({ pathname: new URL(loc.textContent ?? '').pathname }))).toEqual([
      'hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M', 'hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q8_0', 'hf.co/another-owner/LFM2.5-2.6B-GGUF:Q4_K_M',
    ]);
  });

  it.each(['hosted', 'standalone'])('does not publish absent model pages in a portable %s build', async mode => {
    const root = await mkdtemp(path.join(tmpdir(), 'naidan-site-sitemap-'));
    await using _fixture = { [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }) };
    await writeFile(path.join(root, 'index.html'), '<!doctype html><title>fixture</title>');
    await build({ configFile: false, root, mode, logLevel: 'silent', publicDir: false, plugins: [createSiteSitemapPlugin()] });
    if (mode === 'standalone') {
      expect(() => readFileSync(path.join(root, 'dist/sitemap.xml'))).toThrow();
    } else {
      expect(readFileSync(path.join(root, 'dist/sitemap.xml'), 'utf8')).toBe(createSiteSitemap({ entries: [] }));
    }
  });
});
