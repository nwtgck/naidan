import { describe, expect, it } from 'vitest';
import { huggingFaceUrl } from './search-input';
import { parseRepository } from './repository-input';

describe('unified model input routing', () => {
  it.each([
    '', '   ', 'Qwen', 'owner/repository', 'Qwen/Qwen3', 'owner/repository:Q4_K_M',
    'owner/', '/repository', 'foo/bar/baz', 'a.b/model-name_2', 'a//b',
    'hf.co/owner/repository', 'huggingface.co/owner/repository',
    'https://example.com/owner/repository', 'https://huggingface.co.example.com/owner/repository',
    'https://example.com/huggingface.co/owner/repository', 'https://sub.huggingface.co/owner/repository',
    'https://huggingface.co@evil.example/owner/repository', 'https://user@huggingface.co/owner/repository',
    'https://user:password@hf.co/owner/repository', 'https://hf.co:8443/owner/repository',
    'http://huggingface.co/owner/repository', 'ftp://hf.co/owner/repository', '//hf.co/owner/repository',
    'https:hf.co/owner/repository', 'https:/hf.co/owner/repository', 'https://',
    'search https://hf.co/owner/repository', 'hf.co/owner/repository:Q4_K_M',
  ])('does not infer a direct repository action from %j', input => {
    expect(huggingFaceUrl({ input })).toBeUndefined();
  });

  it.each([
    { input: 'https://huggingface.co/owner/repo', url: 'https://huggingface.co/owner/repo' },
    { input: 'https://hf.co/owner/repo', url: 'https://hf.co/owner/repo' },
    { input: '  HTTPS://HUGGINGFACE.CO/owner/repo  ', url: 'https://huggingface.co/owner/repo' },
    { input: 'https://hf.co:443/owner/repo', url: 'https://hf.co/owner/repo' },
    { input: 'https://hf.co/owner/repo:Q4_K_M', url: 'https://hf.co/owner/repo:Q4_K_M' },
    { input: 'https://hf.co/owner/repo/tree/main?download=true#files', url: 'https://hf.co/owner/repo/tree/main?download=true#files' },
  ])('recognizes only the explicit URL: $input', ({ input, url }) => {
    expect(huggingFaceUrl({ input })).toBe(url);
    expect(parseRepository({ input: url }).repository).toBe('owner/repo');
  });

  it('leaves invalid Hugging Face paths to the existing direct-input validation, not search', () => {
    const input = 'https://huggingface.co/';
    expect(huggingFaceUrl({ input })).toBe(input);
    expect(() => parseRepository({ input })).toThrow();
  });

  it('does not truncate a long model-page URL before the direct path can inspect it', () => {
    const input = `https://huggingface.co/owner/repo/blob/main/${'long-path-'.repeat(40)}model.gguf?download=true`;
    expect(input.length).toBeGreaterThan(200);
    expect(huggingFaceUrl({ input })).toBe(input);
    expect(parseRepository({ input }).repository).toBe('owner/repo');
  });
});
