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
    expect(parseRepository({ input: ' https://huggingface.co/owner/repo/ ' })).toBe('owner/repo');
    for (const input of ['hf.co/LiquidAI/LFM2.5-230M-GGUF', 'https://hf.co/LiquidAI/LFM2.5-230M-GGUF/']) expect(parseRepository({ input })).toBe('LiquidAI/LFM2.5-230M-GGUF');
    for (const input of ['hf.co/owner/repo/tree/main', 'https://hf.co/owner/repo?token=secret', 'https://hf.co.example/owner/repo', 'https://example.com/owner/repo', 'owner/../repo', 'https://huggingface.co/owner/repo?token=secret']) expect(() => parseRepository({ input })).toThrow();
  });
  it('resolves main once then follows only the pinned tree pagination', async () => {
    const sha = 'a'.repeat(40); const prefix = `https://huggingface.co/api/models/owner/repo/tree/${sha}`;
    vi.mocked(privacyFetchStream).mockResolvedValueOnce(jsonResponse({ value: { sha, id: 'owner/repo' }, headers: new Headers() }))
      .mockResolvedValueOnce(jsonResponse({ value: [{ type: 'directory', path: 'nested' }, { type: 'file', path: 'model.gguf', size: 128 }], headers: new Headers({ link: `<${prefix}?cursor=next>; rel="next"` }) }))
      .mockResolvedValueOnce(jsonResponse({ value: [{ type: 'file', path: 'mmproj.gguf', size: 64 }], headers: new Headers() }));
    const result = await discoverRepository({ input: 'OWNER/REPO', signal: new AbortController().signal });
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
