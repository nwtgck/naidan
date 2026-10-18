import { describe, expect, it } from 'vitest';
import { validatePrivacyFetchUrl } from '@/features/privacy-fetch/validate-url';
import { normalizeHuggingFaceParameterFilter } from './huggingface';

const searchUrl = 'https://huggingface.co/api/models?apps=llama.cpp&sort=trendingScore&limit=20';

describe('Hugging Face model search privacy policy', () => {
  it.each([
    searchUrl,
    `${searchUrl}&search=qwen`,
    `${searchUrl}&search=`,
    `${searchUrl}&search=%E6%97%A5%E6%9C%AC%E8%AA%9E+%26+model`,
    searchUrl.replace('limit=20', 'limit=1'),
    searchUrl.replace('limit=20', 'limit=100'),
    `${searchUrl}&expand[]=pipeline_tag&expand[]=gguf&expand[]=safetensors&expand[]=downloads&expand[]=likes&expand[]=lastModified`,
    `${searchUrl}&cursor=opaque%2B%2F%3D`,
    `${searchUrl}&num_parameters=min:6B,max:128B`,
    `${searchUrl}&num_parameters=min:0B`,
    `${searchUrl}&num_parameters=max:128B`,
  ])('accepts bounded public llama.cpp searches: %s', urlText => {
    expect(validatePrivacyFetchUrl({ urlText })).toMatchObject({ ok: true, policyName: 'huggingface_models' });
  });

  it.each([
    'https://huggingface.co/api/models',
    searchUrl.replace('api/models?', 'api/models/?'),
    searchUrl.replace('api/models?', 'api/%6dodels?'),
    searchUrl.replace('apps=llama.cpp&', ''),
    searchUrl.replace('apps=llama.cpp', 'apps=transformers'),
    searchUrl.replace('sort=trendingScore&', ''),
    searchUrl.replace('sort=trendingScore', 'sort=downloads'),
    searchUrl.replace('&limit=20', ''),
    searchUrl.replace('limit=20', 'limit=0'),
    searchUrl.replace('limit=20', 'limit=101'),
    searchUrl.replace('limit=20', 'limit=-1'),
    searchUrl.replace('limit=20', 'limit=1.5'),
    searchUrl.replace('limit=20', 'limit=20%0A'),
    `${searchUrl}&search=${'x'.repeat(201)}`,
    `${searchUrl}&search=qwen%00`,
    `${searchUrl}&search=qwen%0A`,
    `${searchUrl}&search=qwen%7F`,
    `${searchUrl}&apps=llama.cpp`,
    `${searchUrl}&sort=trendingScore`,
    `${searchUrl}&limit=20`,
    `${searchUrl}&search=qwen&search=gemma`,
    `${searchUrl}&token=secret`,
    `${searchUrl}&full=true`,
    `${searchUrl}&author=owner`,
    `${searchUrl}&expand[]=private`,
    `${searchUrl}&expand[]=gguf&expand[]=gguf`,
    `${searchUrl}&expand=gguf`,
    `${searchUrl}&cursor=`,
    `${searchUrl}&cursor=next&cursor=other`,
    `${searchUrl}&cursor=%00bad`,
    `${searchUrl}&cursor=${'x'.repeat(8193)}`,
    `${searchUrl}&num_parameters=`,
    `${searchUrl}&num_parameters=min:8B,max:6B`,
    `${searchUrl}&num_parameters=min:6B&num_parameters=max:8B`,
    `${searchUrl}&num_parameters=min:6M`,
    `${searchUrl}&num_parameters=min:1e3B`,
    `${searchUrl}&num_parameters=min:NaNB`,
    `${searchUrl}&num_parameters=min:InfinityB`,
    `${searchUrl}&num_parameters=min:-1B`,
    `${searchUrl}&num_parameters=min:1B%0A`,
    `${searchUrl}&num_parameters=min:1B%E2%80%A8`,
  ])('rejects unsupported search shapes: %s', urlText => {
    expect(validatePrivacyFetchUrl({ urlText }).ok).toBe(false);
  });

  it('canonicalizes equivalent numeric ranges and rejects terminal control characters', () => {
    expect(normalizeHuggingFaceParameterFilter({ value: 'max:08.00B,min:06.000B' })).toBe('min:6B,max:8B');
    expect(normalizeHuggingFaceParameterFilter({ value: 'min:0.00000001B' })).toBe('min:0.00000001B');
    expect(normalizeHuggingFaceParameterFilter({ value: 'min:1B\u000A' })).toBeUndefined();
  });
});
