import { describe, expect, it } from 'vitest';
import { hfRepositories } from '@/features/llama-cpp-browser/hugging-face/model-repositories';
import { findModelPageEntry, listModelPageEntries, modelPageEntries } from './page-entries';
import { modelIdFromPagePath, modelPagePath, modelPageHref, readModelPageRequest } from './page-url';
import { modelLaunchMetadata } from './document-metadata';
import { SITE_METADATA } from '@/logic/document-metadata';

const modelId = 'hf.co/LiquidAI/LFM2.5-230M-GGUF';
const pathname = `/llama-cpp-browser/${modelId}/`;

describe('model page publication registry', () => {
  it('derives every page, canonical and metadata from the shared registry', () => {
    const entries = listModelPageEntries();
    expect(entries).toHaveLength(hfRepositories.length);
    expect(new Set(entries.map(entry => entry.pathname)).size).toBe(entries.length);
    for (const entry of entries) {
      expect(entry.pathname).toBe(`/llama-cpp-browser/${entry.modelId}/`);
      expect(modelIdFromPagePath({ pathname: entry.pathname })).toBe(entry.modelId);
      expect(findModelPageEntry({ pathname: entry.pathname })).toEqual(entry);
      expect(entry.canonicalUrl).toBe(new URL(entry.pathname, SITE_METADATA.url).href);
      expect(entry.metadata).toEqual(modelLaunchMetadata({ repository: entry.repository, variant: undefined }));
    }
  });

  it('publishes one repository page while quantization stays a launch-time option', () => {
    const entries = modelPageEntries({ repositories: [{ hfRepository: 'owner/Exact-it-GGUF' }] });
    expect(entries.map(entry => entry.modelId)).toEqual(['hf.co/owner/Exact-it-GGUF']);
    expect(entries[0]?.metadata.title).toBe('Exact-it — Local LLM on your device, in your browser | Naidan');
    for (const quantization of ['Q4_K_M', 'Q8_0']) {
      expect(modelPageHref({ modelId: entries[0]!.modelId, quantization })).toBe(`/llama-cpp-browser/hf.co/owner/Exact-it-GGUF?quant=${quantization}`);
    }
  });

  it('fails duplicate output paths instead of silently overwriting pages', () => {
    const entry = { hfRepository: 'owner/Model' } as const;
    expect(() => modelPageEntries({ repositories: [entry, entry] })).toThrow('Duplicate');
  });

  it('retains path separators and original spelling in generated public paths', () => {
    expect(modelPagePath({ modelId })).toBe(pathname);
    expect(modelIdFromPagePath({ pathname: pathname.slice(0, -1) })).toBe(modelId);
    expect(modelIdFromPagePath({ pathname: pathname.replace('LiquidAI', '%4CiquidAI') })).toBe(modelId);
    expect(findModelPageEntry({ pathname: pathname.replace('LiquidAI', 'liquidai') })).toBeUndefined();
    expect(findModelPageEntry({ pathname: '/llama-cpp-browser/hf.co/owner/Unknown/' })).toBeUndefined();
  });

  it.each([
    'hf.co/../Model:Q4_K_M', 'hf.co/owner/../Model:Q4_K_M',
    'hf.co/owner/Model:imatrix/Q4_K_M', 'hf.co/owner/Model:Q4_K_M',
    'hf.co/owner/Model:', 'hf.co/owner/Model:Q4 K M',
    'hf.co/owner/Model:Q4_K_M?x', 'https://hf.co/owner/Model:Q4_K_M',
    'hf.co/owner/Model:Q4_K_M#x', 'hf.co/owner/Model%20:Q4_K_M',
  ])('rejects unsafe or unsupported public ID %s', input => {
    expect(() => modelPagePath({ modelId: input })).toThrow('Invalid public model ID');
  });

  it.each([
    '/llama-cpp-browser/hf.co%2Fowner%2FModel/',
    '/llama-cpp-browser/hf.co/owner/Model%253AQ4_K_M/',
    '/llama-cpp-browser/hf.co/owner/Model//',
    '/llama-cpp-browser/hf.co/owner/Model%00/',
    '/llama-cpp-browser/hf.co/owner/Model%5Cfoo/',
    '/llama-cpp-browser/hf.co/owner/Model%ZZ/',
    '/llama-cpp-browser/hf.co/owner/Model/index.html',
    '/nested/llama-cpp-browser/hf.co/owner/Model/',
  ])('does not decode unsafe request paths into a model ID: %s', input => {
    expect(modelIdFromPagePath({ pathname: input })).toBeUndefined();
  });
});

describe('model page query boundary', () => {
  it('accepts unlisted repositories without requiring a publication entry', () => {
    const pathname = '/llama-cpp-browser/hf.co/owner/Unknown-GGUF';
    expect(findModelPageEntry({ pathname })).toBeUndefined();
    expect(readModelPageRequest({ pathname, search: '' })).toEqual({
      kind: 'model',
      modelId: 'hf.co/owner/Unknown-GGUF',
      repository: 'owner/Unknown-GGUF',
      quantization: undefined,
      launchInput: 'hf.co/owner/Unknown-GGUF',
    });
    expect(readModelPageRequest({ pathname: pathname + '/', search: '?quant=Q8_0&q=never-send&settings=connection&llama-cpp-browser-model=other' })).toEqual({
      kind: 'model',
      modelId: 'hf.co/owner/Unknown-GGUF',
      repository: 'owner/Unknown-GGUF',
      quantization: 'Q8_0',
      launchInput: 'hf.co/owner/Unknown-GGUF:Q8_0',
    });
  });

  it.each(['?quant', '?quant=', '?quant=Q4_K_M&quant=Q8_0', '?quant=Q4_K_M&quant=Q4_K_M', '?quant=%2F', '?quant=%252F', '?quant=Q4+K+M', '?quant=Q4%00', '?quant=Q4:bad', '?quant=' + 'A'.repeat(129)])('does not silently use a different quantization for %s', search => {
    expect(readModelPageRequest({ pathname, search })).toEqual({ kind: 'invalid' });
  });

  it('accepts encoded quantization characters once, and keeps optional defaults out of URLs', () => {
    expect(readModelPageRequest({ pathname, search: '?quant=%514_K_M' })).toMatchObject({ kind: 'model', quantization: 'Q4_K_M' });
    expect(modelPageHref({ modelId, quantization: undefined })).toBe(pathname.slice(0, -1));
    expect(readModelPageRequest({ pathname: '/elsewhere', search: '?quant=Q8_0' })).toEqual({ kind: 'outside' });
    expect(readModelPageRequest({ pathname: '/llama-cpp-browser', search: '' })).toEqual({ kind: 'invalid' });
    expect(() => modelPageHref({ modelId, quantization: '' })).toThrow('Invalid');
    expect(() => modelPageHref({ modelId, quantization: 'imatrix/Q4_K_M' })).toThrow('Invalid');
  });

  it('rejects oversized public identifiers before creating filesystem paths', () => {
    expect(() => modelPagePath({ modelId: `hf.co/owner/${'x'.repeat(256)}` })).toThrow('Invalid');
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
