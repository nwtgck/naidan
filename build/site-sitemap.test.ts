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
import { listModelPageEntries, modelPageEntries } from '../src/features/llama-cpp-browser/model-launch/page-entries';
import { modelIdFromPagePath } from '../src/features/llama-cpp-browser/model-launch/page-url';
import { SITE_METADATA } from '../src/logic/document-metadata';
import { createSiteSitemap } from './site-sitemap';
import { createModelPagesPlugin } from './model-pages';

vi.mock('../src/features/llama-cpp-browser/hugging-face/model-suggestions', () => ({
  modelSuggestions: [],
  preferredQuantizationHint: () => {
    throw new Error('Sitemap must not select current recommendations');
  },
}));

// Retained publications are independent of the recommendation list.
const retainedLaunches = [
  'hf.co/ggml-org/gpt-oss-20b-GGUF',
  'hf.co/ggml-org/Qwen3.6-35B-A3B-GGUF',
  'hf.co/ggml-org/Qwen3.8-27B-GGUF',
  'hf.co/google/gemma-4-12B-it-qat-q4_0-gguf',
  'hf.co/google/gemma-4-26B-A4B-it-qat-q4_0-gguf',
  'hf.co/google/gemma-4-E2B-it-qat-q4_0-gguf',
  'hf.co/google/gemma-4-E4B-it-qat-q4_0-gguf',
  'hf.co/ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF',
  'hf.co/LiquidAI/LFM2.5-2.6B-GGUF',
  'hf.co/LiquidAI/LFM2.5-230M-GGUF',
  'hf.co/LiquidAI/LFM3-1.7B-GGUF',
  'hf.co/LiquidAI/LFM3-VL-2B-GGUF',
  'hf.co/lmstudio-community/gemma-4-26B-A4B-it-GGUF',
  'hf.co/lmstudio-community/gemma-4-E2B-it-GGUF',
  'hf.co/lmstudio-community/gemma-4-E4B-it-GGUF',
  'hf.co/lmstudio-community/Qwen3.5-9B-GGUF',
  'hf.co/lmstudio-community/SmolLM2-135M-Instruct-GGUF',
  'hf.co/meta-models/Muse-Glimmer-30B-GGUF',
  'hf.co/unsloth/Qwen3.8-Flash-Next-GGUF',
];

describe('site sitemap', () => {
  it('includes every retained model and README reference using public paths even without recommendations', () => {
    expect(modelSuggestions).toEqual([]);
    const dom = new JSDOM(createSiteSitemap({ entries: listModelPageEntries() }), { contentType: 'application/xml' });
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
      return modelIdFromPagePath({ pathname: url.pathname });
    });
    expect(launches).toEqual(hfRepositories.map(entry => `hf.co/${entry.hfRepository}`));
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const readmeLaunches = [...readme.matchAll(/\]\(https:\/\/naidan\.pages\.dev\/llama-cpp-browser\/(hf\.co\/[^?\s)]+)(?:\?quant=[A-Za-z0-9_.-]+)?\)/g)].map(match => decodeURIComponent(match[1] ?? ''));
    expect(readmeLaunches.length).toBeGreaterThan(0);
    for (const launch of [...retainedLaunches, ...readmeLaunches]) {
      expect(launches).toContain(launch);
    }
    expect(readFileSync(new URL('../public/robots.txt', import.meta.url), 'utf8')).toContain(`Sitemap: ${root}sitemap.xml`);
  });

  it('retains distinct repositories independently of launch-time quantizations and deduplicates identical sitemap URLs', () => {
    const entries = modelPageEntries({
      repositories: [
        { hfRepository: 'LiquidAI/LFM2.5-2.6B-GGUF', modelNaming: { kind: 'base-model-aligned' } },
        { hfRepository: 'another-owner/LFM2.5-2.6B-GGUF', modelNaming: { kind: 'base-model-aligned' } },
      ],
    });
    const dom = new JSDOM(createSiteSitemap({ entries: [...entries, ...entries] }), { contentType: 'application/xml' });
    using _dom = { [Symbol.dispose]: () => dom.window.close() };
    expect([...dom.window.document.querySelectorAll('url > loc')].slice(3).map(loc => modelIdFromPagePath({ pathname: new URL(loc.textContent ?? '').pathname }))).toEqual([
      'hf.co/LiquidAI/LFM2.5-2.6B-GGUF', 'hf.co/another-owner/LFM2.5-2.6B-GGUF',
    ]);
  });

  it.each(['hosted', 'standalone'])('publishes model URLs only with their HTML in a %s build', async mode => {
    const root = await mkdtemp(path.join(tmpdir(), 'naidan-site-sitemap-'));
    await using _fixture = { [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }) };
    await writeFile(path.join(root, 'index.html'), '<!doctype html><title>fixture</title><div id="app"></div>');
    await build({ configFile: false, root, mode, logLevel: 'silent', publicDir: false, plugins: [createModelPagesPlugin()] });
    if (mode === 'standalone') {
      expect(() => readFileSync(path.join(root, 'dist/sitemap.xml'))).toThrow();
    } else {
      expect(readFileSync(path.join(root, 'dist/sitemap.xml'), 'utf8')).toBe(createSiteSitemap({ entries: listModelPageEntries() }));
    }
  });
});
