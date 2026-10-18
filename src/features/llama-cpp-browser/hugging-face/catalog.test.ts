import { describe, expect, it, vi } from 'vitest';
import { createSearchParameterFilter, discoverRepository, groupModelFiles, parseRepository, searchModels } from './catalog';
import { privacyFetchStream } from '@/features/privacy-fetch';
vi.mock('@/features/privacy-fetch', () => ({ privacyFetchStream: vi.fn() }));

function jsonResponse({ value, headers }: { value: unknown, headers: Headers }): Awaited<ReturnType<typeof privacyFetchStream>> {
  return {
    body: new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
        controller.close();
      },
    }),
    headers,
    status: 200,
    statusText: 'OK',
    ok: true,
    url: '',
    redirected: false,
    responseType: 'basic',
    policyName: 'test',
  };
}

describe('Hugging Face model discovery', () => {
  it('keeps complete split groups and variants distinct without pairing projectors by quantization', () => {
    const paths = ['Q4/model-00002-of-00002.gguf', 'Q4/model-00001-of-00002.gguf', 'Q4/model-QAD.gguf', 'Q8/model-00001-of-00002.gguf', 'model-mmproj-F16.gguf'];
    const result = groupModelFiles({ files: paths.map(path => ({ path, size: 64 })) });
    expect(result.models).toHaveLength(2);
    expect(result.models.find(model => model.files.length === 2)?.size).toBe(128);
    expect(result.projectors.map(file => file.path)).toEqual(['model-mmproj-F16.gguf']);
  });

  it('accepts repository IDs and public repository URLs while rejecting unrelated URLs and paths', () => {
    expect(parseRepository({ input: ' https://huggingface.co/owner/repo/ ' })).toEqual({ repository: 'owner/repo', requestedVariant: undefined });
    for (const input of ['hf.co/LiquidAI/LFM2.5-230M-GGUF', 'https://hf.co/LiquidAI/LFM2.5-230M-GGUF/']) {
      expect(parseRepository({ input })).toEqual({ repository: 'LiquidAI/LFM2.5-230M-GGUF', requestedVariant: undefined });
    }
    for (const input of ['https://user:secret@hf.co/owner/repo', 'https://hf.co.example/owner/repo', 'https://example.com/owner/repo', 'owner/../repo', 'http://hf.co/owner/repo', 'https://hf.co:444/owner/repo']) {
      expect(() => parseRepository({ input })).toThrow();
    }
  });

  it('normalizes HF URLs to the repository and deliberately ignores every suffix', () => {
    for (const input of ['https://huggingface.co/owner/repo/tree/main', 'https://huggingface.co/owner/repo/tree/other-branch/nested/path', 'hf.co/owner/repo/tree/main', 'https://hf.co/owner/repo/tree/other', 'https://huggingface.co/owner/repo/blob/other/model.gguf?download=true#file', 'hf.co/owner/repo/anything?token=ignored#ignored']) {
      expect(parseRepository({ input })).toEqual({ repository: 'owner/repo', requestedVariant: undefined });
    }
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
    const sha = 'a'.repeat(40);
    const prefix = `https://huggingface.co/api/models/owner/repo/tree/${sha}`;
    vi.mocked(privacyFetchStream).mockResolvedValueOnce(jsonResponse({ value: { sha, id: 'owner/repo' }, headers: new Headers() }))
      .mockResolvedValueOnce(jsonResponse({ value: [{ type: 'directory', path: 'nested' }, { type: 'file', path: 'model.gguf', size: 128 }], headers: new Headers({ link: `<${prefix}?cursor=next>; rel="next"` }) }))
      .mockResolvedValueOnce(jsonResponse({ value: [{ type: 'file', path: 'mmproj.gguf', size: 64 }], headers: new Headers() }));
    const result = await discoverRepository({ input: 'https://hf.co/OWNER/REPO:QAD-Q4_0/tree/not-main/nested', signal: new AbortController().signal });
    expect(vi.mocked(privacyFetchStream).mock.calls.at(-3)?.[0].request.url).toBe('https://huggingface.co/api/models/OWNER/REPO/revision/main');
    expect(result.repository).toBe('owner/repo');
    expect(result.revision).toBe(sha);
    expect(result.models).toHaveLength(1);
    expect(result.projectors).toHaveLength(1);
    expect(vi.mocked(privacyFetchStream).mock.calls.at(-1)?.[0].request.url).toBe(`${prefix}?cursor=next`);
  });

  it('rejects pagination escaping the pinned source', async () => {
    vi.mocked(privacyFetchStream).mockResolvedValueOnce(jsonResponse({ value: { sha: 'b'.repeat(40), id: 'owner/repo' }, headers: new Headers() }))
      .mockResolvedValueOnce(jsonResponse({ value: [], headers: new Headers({ link: '<https://other.example/private>; rel="next"' }) }));
    await expect(discoverRepository({ input: 'owner/repo', signal: new AbortController().signal })).rejects.toThrow('pagination URL');
  });
});

describe('Hugging Face repository search', () => {
  it.each([
    { minimumBillions: '', maximumBillions: '', expected: undefined },
    { minimumBillions: '0', maximumBillions: '', expected: 'min:0B' },
    { minimumBillions: '', maximumBillions: '128', expected: 'max:128B' },
    { minimumBillions: '6.00', maximumBillions: '8', expected: 'min:6B,max:8B' },
    { minimumBillions: '.5', maximumBillions: '1.', expected: 'min:0.5B,max:1B' },
    { minimumBillions: '0.00000001', maximumBillions: '', expected: 'min:0.00000001B' },
  ])('normalizes raw parameter bounds without exponent serialization: %j', ({ minimumBillions, maximumBillions, expected }) => {
    expect(createSearchParameterFilter({ minimumBillions, maximumBillions })).toBe(expected);
  });

  it.each(['.', 'NaN', 'Infinity', '-1', '1e-8', '1e308'])('rejects an invalid raw parameter minimum before fetch: %s', minimumBillions => {
    expect(() => createSearchParameterFilter({ minimumBillions, maximumBillions: '' })).toThrow('parameter range');
  });

  it('keeps parameter filters on rebuilt pages and accepts an equivalent explicitly reordered next range', async () => {
    vi.mocked(privacyFetchStream).mockResolvedValueOnce(jsonResponse({ value: [{ id: 'owner/model' }], headers: new Headers({ link: '<?cursor=next&num_parameters=max%3A8.0B%2Cmin%3A06.00B>; rel="next"' }) }));
    const page = await searchModels({ query: 'qwen', cursor: undefined, numParameters: 'min:6B,max:8B', signal: new AbortController().signal });
    expect(page.nextCursor).toBe('next');
    vi.mocked(privacyFetchStream).mockResolvedValueOnce(jsonResponse({ value: [], headers: new Headers({ link: '<?cursor=after>; rel="next"' }) }));
    const next = await searchModels({ query: 'qwen', cursor: page.nextCursor, numParameters: 'min:6B,max:8B', signal: new AbortController().signal });
    expect(new URL(vi.mocked(privacyFetchStream).mock.calls.at(-1)![0].request.url).searchParams.get('num_parameters')).toBe('min:6B,max:8B');
    expect(next.nextCursor).toBe('after');
  });

  it('rejects an explicitly changed range on a next link without losing the valid page', async () => {
    vi.mocked(privacyFetchStream).mockResolvedValueOnce(jsonResponse({ value: [{ id: 'owner/model' }], headers: new Headers({ link: '<?cursor=next&num_parameters=min%3A5B%2Cmax%3A8B>; rel="next"' }) }));
    expect(await searchModels({ query: 'qwen', cursor: undefined, numParameters: 'min:6B,max:8B', signal: new AbortController().signal })).toEqual({ results: [{ id: 'owner/model' }], nextCursor: undefined });
  });

  it('uses the privacy stream with a bounded explicit llama.cpp search query', async () => {
    vi.mocked(privacyFetchStream).mockResolvedValueOnce(jsonResponse({ value: [{ id: 'Qwen/Qwen-GGUF', downloads: 1234, likes: 56 }], headers: new Headers() }));
    const signal = new AbortController().signal;
    expect((await searchModels({ query: '  qwen & 日本語  ', cursor: undefined, numParameters: undefined, signal })).results).toEqual([{ id: 'Qwen/Qwen-GGUF', downloads: 1234, likes: 56 }]);
    const request = vi.mocked(privacyFetchStream).mock.calls.at(-1)![0].request;
    const url = new URL(request.url);
    expect(request.signal).toBe(signal);
    expect(url.origin + url.pathname).toBe('https://huggingface.co/api/models');
    expect(url.searchParams.get('search')).toBe('qwen & 日本語');
    expect(url.searchParams.get('limit')).toBe('20');
    expect(url.searchParams.getAll('expand[]')).toEqual(['pipeline_tag', 'gguf', 'safetensors', 'downloads', 'likes', 'lastModified']);
  });

  it('omits search only for an explicitly requested empty query', async () => {
    vi.mocked(privacyFetchStream).mockResolvedValueOnce(jsonResponse({ value: [], headers: new Headers() }));
    expect((await searchModels({ query: '   ', cursor: undefined, numParameters: undefined, signal: new AbortController().signal })).results).toEqual([]);
    expect(new URL(vi.mocked(privacyFetchStream).mock.calls.at(-1)![0].request.url).searchParams.has('search')).toBe(false);
  });

  it('ignores unknown fields and changes to unused API fields while validating rendered fields', async () => {
    vi.mocked(privacyFetchStream).mockResolvedValueOnce(jsonResponse({
      value: [{ id: 'owner/model', downloads: 0, likes: 0, private: 'changed', gated: { changed: true }, tags: 42, trendingScore: 'changed', newField: { anything: true } }, { id: 'other/model' }],
      headers: new Headers(),
    }));
    expect((await searchModels({ query: 'model', cursor: undefined, numParameters: undefined, signal: new AbortController().signal })).results).toEqual([{ id: 'owner/model', downloads: 0, likes: 0 }, { id: 'other/model' }]);
  });

  it('rejects an invalid repository identity', async () => {
    vi.mocked(privacyFetchStream).mockResolvedValueOnce(jsonResponse({ value: [{ id: 'https://evil.test/model' }], headers: new Headers() }));
    await expect(searchModels({ query: 'model', cursor: undefined, numParameters: undefined, signal: new AbortController().signal })).rejects.toThrow();
  });

  it('omits malformed optional fields independently and keeps valid metadata on the repository', async () => {
    vi.mocked(privacyFetchStream).mockResolvedValueOnce(jsonResponse({
      value: [
        { id: 'owner/mixed', likes: '1', downloads: -1, pipeline_tag: [], gguf: { total: 'broken', architecture: 'llama', context_length: 'unused and changed', future: [] }, safetensors: { total: 7_000_000_000, unknown: 'ignored' }, lastModified: '2026-08-20T12:34:56.000Z' },
        { id: 'owner/broken', likes: 1.5, downloads: Number.MAX_SAFE_INTEGER + 1, pipeline_tag: 'future-task', gguf: false, safetensors: [], lastModified: { broken: true } },
        { id: 'owner/partial', downloads: 3, gguf: { total: 4_000_000_000, architecture: [], context_length: -1 }, safetensors: { total: 'broken' } },
      ],
      headers: new Headers(),
    }));
    const page = await searchModels({ query: 'model', cursor: undefined, numParameters: undefined, signal: new AbortController().signal });
    expect(page.results).toEqual([
      { id: 'owner/mixed', likes: undefined, downloads: undefined, pipeline_tag: undefined, gguf: { total: undefined, architecture: 'llama' }, safetensors: { total: 7_000_000_000 }, lastModified: '2026-08-20T12:34:56.000Z' },
      { id: 'owner/broken', likes: undefined, downloads: undefined, pipeline_tag: 'future-task', gguf: undefined, safetensors: undefined, lastModified: undefined },
      { id: 'owner/partial', downloads: 3, gguf: { total: 4_000_000_000, architecture: undefined }, safetensors: { total: undefined } },
    ]);
  });

  it('rejects a non-array response', async () => {
    vi.mocked(privacyFetchStream).mockResolvedValueOnce(jsonResponse({ value: { id: 'owner/model' }, headers: new Headers() }));
    await expect(searchModels({ query: 'model', cursor: undefined, numParameters: undefined, signal: new AbortController().signal })).rejects.toThrow();
  });

  it('deduplicates IDs in API order and limits displayed results even if the API sends extra entries', async () => {
    const results = Array.from({ length: 25 }, (_value, index) => ({ id: `owner/model-${index}` }));
    vi.mocked(privacyFetchStream).mockResolvedValueOnce(jsonResponse({ value: [results[0], ...results], headers: new Headers() }));
    expect((await searchModels({ query: 'model', cursor: undefined, numParameters: undefined, signal: new AbortController().signal })).results).toEqual(results.slice(0, 20));
  });

  it('cancels an unsuccessful HTTP response', async () => {
    const response = jsonResponse({ value: [], headers: new Headers() });
    const cancel = vi.spyOn(response.body, 'cancel');
    vi.mocked(privacyFetchStream).mockResolvedValueOnce({ ...response, status: 429 });
    await expect(searchModels({ query: 'model', cursor: undefined, numParameters: undefined, signal: new AbortController().signal })).rejects.toThrow('HTTP 429');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects invalid JSON and oversized metadata streams', async () => {
    const base = jsonResponse({ value: [], headers: new Headers() });
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('not JSON'));
        controller.close();
      },
    });
    vi.mocked(privacyFetchStream).mockResolvedValueOnce({ ...base, body });
    await expect(searchModels({ query: 'model', cursor: undefined, numParameters: undefined, signal: new AbortController().signal })).rejects.toThrow();
    const cancel = vi.fn();
    const oversized = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
      },
      cancel,
    });
    vi.mocked(privacyFetchStream).mockResolvedValueOnce({ ...base, body: oversized });
    await expect(searchModels({ query: 'model', cursor: undefined, numParameters: undefined, signal: new AbortController().signal })).rejects.toThrow('size limit');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not fetch for an already-aborted request or invalid search text', async () => {
    const calls = vi.mocked(privacyFetchStream).mock.calls.length;
    const controller = new AbortController();
    controller.abort();
    await expect(searchModels({ query: 'model', cursor: undefined, numParameters: undefined, signal: controller.signal })).rejects.toThrow();
    await expect(searchModels({ query: 'x'.repeat(201), cursor: undefined, numParameters: undefined, signal: new AbortController().signal })).rejects.toThrow();
    await expect(searchModels({ query: 'model\u0000name', cursor: undefined, numParameters: undefined, signal: new AbortController().signal })).rejects.toThrow();
    expect(vi.mocked(privacyFetchStream).mock.calls).toHaveLength(calls);
  });

  it('rejects a response whose request was aborted before parsing completed', async () => {
    const controller = new AbortController();
    vi.mocked(privacyFetchStream).mockImplementationOnce(async () => {
      controller.abort();
      return jsonResponse({ value: [{ id: 'old/model' }], headers: new Headers() });
    });
    await expect(searchModels({ query: 'model', cursor: undefined, numParameters: undefined, signal: controller.signal })).rejects.toThrow();
  });

  it('extracts only the next cursor and rebuilds committed search parameters for the next request', async () => {
    vi.mocked(privacyFetchStream).mockResolvedValueOnce(jsonResponse({ value: [{ id: 'owner/first' }], headers: new Headers({ link: '<https://huggingface.co/api/models?cursor=opaque%2B%2F%3D>; rel="next"' }) }));
    const first = await searchModels({ query: 'qwen', cursor: undefined, numParameters: undefined, signal: new AbortController().signal });
    expect(first.nextCursor).toBe('opaque+/=');
    vi.mocked(privacyFetchStream).mockResolvedValueOnce(jsonResponse({ value: [{ id: 'owner/second' }], headers: new Headers() }));
    await searchModels({ query: 'qwen', cursor: first.nextCursor, numParameters: undefined, signal: new AbortController().signal });
    const next = new URL(vi.mocked(privacyFetchStream).mock.calls.at(-1)![0].request.url);
    expect(next.origin + next.pathname).toBe('https://huggingface.co/api/models');
    expect(next.searchParams.get('search')).toBe('qwen');
    expect(next.searchParams.get('cursor')).toBe('opaque+/=');
    expect(next.searchParams.get('limit')).toBe('20');
    expect(next.searchParams.get('apps')).toBe('llama.cpp');
    expect(next.searchParams.get('sort')).toBe('trendingScore');
    expect(next.searchParams.getAll('expand[]')).toEqual(['pipeline_tag', 'gguf', 'safetensors', 'downloads', 'likes', 'lastModified']);
  });

  it('accepts matching explicit Link parameters and either array spelling without changing the request shape', async () => {
    const link = '<https://huggingface.co/api/models?apps=llama.cpp&sort=trendingScore&search=qwen&limit=20&expand=pipeline_tag&expand=gguf&expand=safetensors&expand=downloads&expand=likes&cursor=next>; rel="next"';
    vi.mocked(privacyFetchStream).mockResolvedValueOnce(jsonResponse({ value: [], headers: new Headers({ link }) }));
    expect((await searchModels({ query: 'qwen', cursor: undefined, numParameters: undefined, signal: new AbortController().signal })).nextCursor).toBe('next');
  });

  it.each([
    '<https://evil.test/api/models?cursor=next>; rel="next"',
    '<http://huggingface.co/api/models?cursor=next>; rel="next"',
    '<https://user:secret@huggingface.co/api/models?cursor=next>; rel="next"',
    '<https://huggingface.co/api/models/owner/repo?cursor=next>; rel="next"',
    '<https://huggingface.co/api/models?cursor=next#secret>; rel="next"',
    '<https://huggingface.co/api/models?cursor=next&token=secret>; rel="next"',
    '<https://huggingface.co/api/models?cursor=next&search=other>; rel="next"',
    '<https://huggingface.co/api/models?cursor=next&apps=transformers>; rel="next"',
    '<https://huggingface.co/api/models?cursor=next&sort=downloads>; rel="next"',
    '<https://huggingface.co/api/models?cursor=next&limit=100>; rel="next"',
    '<https://huggingface.co/api/models?cursor=next&num_parameters=min:6B>; rel="next"',
    '<https://huggingface.co/api/models?cursor=next&expand[]=private>; rel="next"',
    '<https://huggingface.co/api/models?cursor=next&expand=gguf&expand[]=gguf>; rel="next"',
    '<https://huggingface.co/api/models?cursor=next&cursor=other>; rel="next"',
    '<https://huggingface.co/api/models?cursor=>; rel="next"',
    '<https://huggingface.co/api/models?cursor=%00bad>; rel="next"',
    '<https://huggingface.co/api/models?cursor=next>; rel="prev"',
    '<https://huggingface.co/api/models?cursor=next>; rel="not-next"',
    '<https://huggingface.co/api/models?cursor=next>; rel="https://example.test/next"',
    '<https://huggingface.co/api/models?cursor=next>; rel="next", <https://huggingface.co/api/models?cursor=other>; rel="next"',
    'not a Link header',
  ])('keeps valid results and ignores an unsafe or ambiguous next Link: %s', async link => {
    vi.mocked(privacyFetchStream).mockResolvedValueOnce(jsonResponse({ value: [{ id: 'owner/model' }], headers: new Headers({ link }) }));
    expect(await searchModels({ query: 'qwen', cursor: undefined, numParameters: undefined, signal: new AbortController().signal })).toEqual({ results: [{ id: 'owner/model' }], nextCursor: undefined });
  });

  it('stops an unchanged cursor and preserves an empty committed query while paging trends', async () => {
    vi.mocked(privacyFetchStream).mockResolvedValueOnce(jsonResponse({ value: [], headers: new Headers({ link: '<?cursor=same>; rel="next"' }) }));
    expect((await searchModels({ query: '', cursor: 'same', numParameters: undefined, signal: new AbortController().signal })).nextCursor).toBeUndefined();
    expect(new URL(vi.mocked(privacyFetchStream).mock.calls.at(-1)![0].request.url).searchParams.has('search')).toBe(false);
  });
});
