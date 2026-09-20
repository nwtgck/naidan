import { describe, expect, it, vi } from 'vitest';
import { discoverRepository, groupModelFiles, parseRepository } from './catalog';
import { privacyFetchStream } from '@/features/privacy-fetch';
vi.mock('@/features/privacy-fetch', () => ({ privacyFetchStream: vi.fn() }));
function jsonResponse({ value, headers }: { value: unknown, headers: Headers }): Awaited<ReturnType<typeof privacyFetchStream>> {
  return { body: new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) {
    controller.enqueue(new TextEncoder().encode(JSON.stringify(value))); controller.close();
  } }), headers, status: 200, statusText: 'OK', ok: true, url: '', redirected: false, responseType: 'basic', policyName: 'test' };
}
describe('Hugging Face model discovery', () => {
  it('keeps complete split groups and variants distinct without pairing projectors by quantization', () => {
    const paths = ['Q4/model-00002-of-00002.gguf', 'Q4/model-00001-of-00002.gguf', 'Q4/model-QAD.gguf', 'Q8/model-00001-of-00002.gguf', 'model-mmproj-F16.gguf'];
    const result = groupModelFiles({ files: paths.map(path => ({ path, size: 64 })) });
    expect(result.models).toHaveLength(2); expect(result.models.find(model => model.files.length === 2)?.size).toBe(128);
    expect(result.projectors.map(file => file.path)).toEqual(['model-mmproj-F16.gguf']);
  });
  it('accepts repository IDs and public repository URLs while rejecting unrelated URLs and paths', () => {
    expect(parseRepository({ input: ' https://huggingface.co/owner/repo/ ' })).toEqual({ repository: 'owner/repo', requestedVariant: undefined });
    for (const input of ['hf.co/LiquidAI/LFM2.5-230M-GGUF', 'https://hf.co/LiquidAI/LFM2.5-230M-GGUF/']) expect(parseRepository({ input })).toEqual({ repository: 'LiquidAI/LFM2.5-230M-GGUF', requestedVariant: undefined });
    for (const input of ['https://user:secret@hf.co/owner/repo', 'https://hf.co.example/owner/repo', 'https://example.com/owner/repo', 'owner/../repo', 'http://hf.co/owner/repo', 'https://hf.co:444/owner/repo']) expect(() => parseRepository({ input })).toThrow();
  });
  it('normalizes HF URLs to the repository and deliberately ignores every suffix', () => {
    for (const input of ['https://huggingface.co/owner/repo/tree/main', 'https://huggingface.co/owner/repo/tree/other-branch/nested/path', 'hf.co/owner/repo/tree/main', 'https://hf.co/owner/repo/tree/other', 'https://huggingface.co/owner/repo/blob/other/model.gguf?download=true#file', 'hf.co/owner/repo/anything?token=ignored#ignored']) expect(parseRepository({ input })).toEqual({ repository: 'owner/repo', requestedVariant: undefined });
  });
  it('separates explicit variants from the repository without reading ignored URL suffixes', () => {
    for (const input of ['owner/repo:QAD-Q4_0', 'hf.co/owner/repo:QAD-Q4_0', 'https://huggingface.co/owner/repo:QAD-Q4_0/tree/other:anything?ignored=true']) {
      expect(parseRepository({ input })).toEqual({ repository: 'owner/repo', requestedVariant: 'QAD-Q4_0' });
    }
    expect(parseRepository({ input: 'hf.co/owner/repo/tree/other:Q8_0' })).toEqual({ repository: 'owner/repo', requestedVariant: undefined });
    expect(parseRepository({ input: 'hf.co/owner/repo:UD-Q4_K_XL' })).toEqual({ repository: 'owner/repo', requestedVariant: 'UD-Q4_K_XL' });
    expect(() => parseRepository({ input: 'owner/repo:' })).toThrow();
  });
  it('resolves main once then follows only the pinned tree pagination', async () => {
    const sha = 'a'.repeat(40); const prefix = `https://huggingface.co/api/models/owner/repo/tree/${sha}`;
    vi.mocked(privacyFetchStream).mockResolvedValueOnce(jsonResponse({ value: { sha, id: 'owner/repo' }, headers: new Headers() }))
      .mockResolvedValueOnce(jsonResponse({ value: [{ type: 'directory', path: 'nested' }, { type: 'file', path: 'model.gguf', size: 128 }], headers: new Headers({ link: `<${prefix}?cursor=next>; rel="next"` }) }))
      .mockResolvedValueOnce(jsonResponse({ value: [{ type: 'file', path: 'mmproj.gguf', size: 64 }], headers: new Headers() }));
    const result = await discoverRepository({ input: 'https://hf.co/OWNER/REPO:QAD-Q4_0/tree/not-main/nested', signal: new AbortController().signal });
    expect(vi.mocked(privacyFetchStream).mock.calls.at(-3)?.[0].request.url).toBe('https://huggingface.co/api/models/OWNER/REPO/revision/main');
    expect(result.repository).toBe('owner/repo');
    expect(result.revision).toBe(sha); expect(result.models).toHaveLength(1); expect(result.projectors).toHaveLength(1);
    expect(vi.mocked(privacyFetchStream).mock.calls.at(-1)?.[0].request.url).toBe(`${prefix}?cursor=next`);
  });
  it('rejects pagination escaping the pinned source', async () => {
    vi.mocked(privacyFetchStream).mockResolvedValueOnce(jsonResponse({ value: { sha: 'b'.repeat(40), id: 'owner/repo' }, headers: new Headers() }))
      .mockResolvedValueOnce(jsonResponse({ value: [], headers: new Headers({ link: '<https://other.example/private>; rel="next"' }) }));
    await expect(discoverRepository({ input: 'owner/repo', signal: new AbortController().signal })).rejects.toThrow('pagination URL');
  });
});
