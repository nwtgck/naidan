import { describe, expect, it } from 'vitest';
import { hfRepositories } from '@/features/llama-cpp-browser/hugging-face/model-repositories';
import { findModelSeoEntry, listModelSeoEntries, modelSeoEntries } from './seo-entries';
import { modelIdFromSeoPath, modelSeoPath } from './seo-url';
import { modelLaunchMetadata } from './document-metadata';
import { SITE_METADATA } from '@/logic/document-metadata';

const modelId = 'hf.co/LiquidAI/LFM2.5-230M-GGUF:Q4_K_M';
const pathname = `/llama-cpp-browser/${modelId}/`;

describe('model SEO publication registry', () => {
  it('derives every page, canonical and metadata from the shared registry', () => {
    const entries = listModelSeoEntries();
    expect(entries).toHaveLength(hfRepositories.reduce((count, entry) => count + entry.seoPageQuantizations.length, 0));
    expect(new Set(entries.map(entry => entry.pathname)).size).toBe(entries.length);
    for (const entry of entries) {
      expect(entry.pathname).toBe(`/llama-cpp-browser/${entry.modelId}/`);
      expect(modelIdFromSeoPath({ pathname: entry.pathname })).toBe(entry.modelId);
      expect(findModelSeoEntry({ pathname: entry.pathname })).toEqual(entry);
      expect(entry.canonicalUrl).toBe(new URL(entry.pathname, SITE_METADATA.url).href);
      expect(entry.metadata).toEqual(modelLaunchMetadata({ repository: entry.repository, variant: entry.quantization }));
    }
  });

  it('supports multiple published quantizations without changing repository identity', () => {
    const entries = modelSeoEntries({ repositories: [{ hfRepository: 'owner/Exact-it-GGUF', seoPageQuantizations: ['Q4_K_M', 'Q8_0'] }] });
    expect(entries.map(entry => entry.modelId)).toEqual(['hf.co/owner/Exact-it-GGUF:Q4_K_M', 'hf.co/owner/Exact-it-GGUF:Q8_0']);
    expect(entries[0]?.metadata.title).toContain('Exact-it Q4_K_M');
  });

  it('fails duplicate output paths instead of silently overwriting pages', () => {
    expect(() => modelSeoEntries({ repositories: [{ hfRepository: 'owner/Model', seoPageQuantizations: ['Q4_K_M', 'Q4_K_M'] }] })).toThrow('Duplicate');
    const entry = { hfRepository: 'owner/Model', seoPageQuantizations: ['Q4_K_M'] } as const;
    expect(() => modelSeoEntries({ repositories: [entry, entry] })).toThrow('Duplicate');
  });

  it('retains slashes, colon and original spelling in generated public paths', () => {
    expect(modelSeoPath({ modelId })).toBe(pathname);
    expect(modelIdFromSeoPath({ pathname: pathname.slice(0, -1) })).toBe(modelId);
    expect(modelIdFromSeoPath({ pathname: pathname.replace(':', '%3A') })).toBe(modelId);
    expect(findModelSeoEntry({ pathname: pathname.replace('LiquidAI', 'liquidai') })).toBeUndefined();
    expect(findModelSeoEntry({ pathname: '/llama-cpp-browser/hf.co/owner/Unknown:Q4_K_M/' })).toBeUndefined();
  });

  it.each([
    'hf.co/../Model:Q4_K_M', 'hf.co/owner/../Model:Q4_K_M',
    'hf.co/owner/Model:imatrix/Q4_K_M', 'hf.co/owner/Model',
    'hf.co/owner/Model:', 'hf.co/owner/Model:Q4 K M',
    'hf.co/owner/Model:Q4_K_M?x', 'https://hf.co/owner/Model:Q4_K_M',
    'hf.co/owner/Model:Q4_K_M#x', 'hf.co/owner/Model%20:Q4_K_M',
  ])('rejects unsafe or unsupported public ID %s', input => {
    expect(() => modelSeoPath({ modelId: input })).toThrow('Invalid public model ID');
  });

  it.each([
    '/llama-cpp-browser/hf.co%2Fowner%2FModel:Q4_K_M/',
    '/llama-cpp-browser/hf.co/owner/Model%253AQ4_K_M/',
    '/llama-cpp-browser/hf.co/owner/Model:Q4_K_M//',
    '/llama-cpp-browser/hf.co/owner/Model%00:Q4_K_M/',
    '/llama-cpp-browser/hf.co/owner/Model%5Cfoo:Q4_K_M/',
    '/llama-cpp-browser/hf.co/owner/Model%ZZ:Q4_K_M/',
    '/llama-cpp-browser/hf.co/owner/Model:Q4_K_M/index.html',
    '/nested/llama-cpp-browser/hf.co/owner/Model:Q4_K_M/',
  ])('does not decode unsafe request paths into a model ID: %s', input => {
    expect(modelIdFromSeoPath({ pathname: input })).toBeUndefined();
  });
});

describe('shared model launch copy', () => {
  it.each([
    { repository: 'owner/Qwen3.5-9B-GGUF', variant: 'Q4_K_M', label: 'Qwen3.5-9B Q4_K_M' },
    { repository: 'google/gemma-4-E2B-it-qat-q4_0-gguf', variant: 'Q4_0', label: 'gemma-4-E2B-it-qat-q4_0 Q4_0' },
    { repository: 'owner/gguf-inside-GGUF', variant: undefined, label: 'gguf-inside' },
    { repository: 'owner/Model-GGUF-extra', variant: '', label: 'Model-GGUF-extra' },
    { repository: 'owner/UnpublishedModel', variant: 'Q8_0', label: 'UnpublishedModel Q8_0' },
  ])('formats $repository without a manual model-name table', ({ repository, variant, label }) => {
    const metadata = modelLaunchMetadata({ repository, variant });
    expect(metadata.title).toBe(`${label} — Local LLM on your device, in your browser | Naidan`);
    expect(metadata.description).toBe(`Run ${label} as a local LLM on your device. llama.cpp runs directly inside your browser, using WebGPU or CPU where supported. No remote inference server is required.`);
    expect(metadata.description).not.toContain('with Naidan');
    expect(metadata.description).not.toContain('with llama.cpp');
  });
});
