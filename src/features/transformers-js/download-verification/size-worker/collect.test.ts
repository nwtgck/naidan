import { afterEach, expect, it, vi } from 'vitest';
import { collectDownloadSizes } from './collect';

const request = { modelId: 'fixture/model', revision: 'a'.repeat(40), paths: ['onnx/a.onnx', 'onnx/b.onnx'] };
afterEach(() => vi.useRealTimers());

it('requests only frozen paths using the official form wire and matches file identities independently of response order', async () => {
  const repositoryFetch = vi.fn<typeof fetch>(async () => Response.json([
    { type: 'file', path: 'onnx/b.onnx', size: 200, oid: 'b', lfs: { size: 200, pointerSize: 129 } },
    { type: 'file', path: 'onnx/a.onnx', size: 100, oid: 'a' },
  ]));
  const result = await collectDownloadSizes({ request, repositoryFetch, signal: new AbortController().signal });
  expect(repositoryFetch).toHaveBeenCalledOnce();
  const [url, options] = repositoryFetch.mock.calls[0]!;
  expect(url).toBe('https://huggingface.co/api/models/fixture/model/paths-info/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  expect(options).toMatchObject({ method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
  expect(new URLSearchParams(String(options?.body)).getAll('paths')).toEqual(['onnx/a.onnx', 'onnx/b.onnx']);
  expect(new URLSearchParams(String(options?.body)).get('expand')).toBe('false');
  expect(result).toEqual({ sizes: [{ path: 'onnx/b.onnx', bytes: 200 }, { path: 'onnx/a.onnx', bytes: 100 }], quotaLimited: false });
});

it('treats missing, directory, duplicate, contradictory and unrequested entries as unknown', async () => {
  const repositoryFetch = vi.fn<typeof fetch>(async () => Response.json([
    { type: 'file', path: 'onnx/a.onnx', size: 100 }, { type: 'file', path: 'onnx/a.onnx', size: 100 },
    { type: 'file', path: 'onnx/b.onnx', size: 200, lfs: { size: 300 } },
    { type: 'directory', path: 'directory', size: 100 }, { type: 'file', path: 'unrequested', size: 999 },
  ]));
  const result = await collectDownloadSizes({ request: { ...request, paths: [...request.paths, 'directory', 'missing'] }, repositoryFetch, signal: new AbortController().signal });
  expect(result).toEqual({ sizes: [], quotaLimited: false });
});

it('bounds requests to four batches and stops immediately on quota rejection', async () => {
  const repositoryFetch = vi.fn<typeof fetch>(async () => new Response('quota', { status: 429 }));
  const result = await collectDownloadSizes({ request: { ...request, paths: Array.from({ length: 256 }, (_, i) => `onnx/file${i}`) }, repositoryFetch, signal: new AbortController().signal });
  expect(result).toEqual({ sizes: [], quotaLimited: true });
  expect(repositoryFetch).toHaveBeenCalledOnce();
  expect(new URLSearchParams(String(repositoryFetch.mock.calls[0]?.[1]?.body)).getAll('paths')).toHaveLength(64);
});

it('rejects an oversized decoded response before retaining its body as JSON', async () => {
  const cancel = vi.fn();
  const repositoryFetch = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(256 * 1024 + 1));
    }, cancel,
  })));
  expect(await collectDownloadSizes({ request, repositoryFetch, signal: new AbortController().signal })).toEqual({ sizes: [], quotaLimited: false });
  expect(cancel).toHaveBeenCalledOnce();
});

it('bounds metadata entry count even when most entries would be filtered', async () => {
  const repositoryFetch = vi.fn<typeof fetch>(async () => Response.json(Array.from({ length: 65 }, (_, i) => ({ type: 'file', path: `other/${i}`, size: 1 }))));
  expect(await collectDownloadSizes({ request, repositoryFetch, signal: new AbortController().signal })).toEqual({ sizes: [], quotaLimited: false });
});

it('owns a late response after the request deadline without reading its body or starting another request', async () => {
  vi.useFakeTimers();
  const response = Promise.withResolvers<Response>();
  const repositoryFetch = vi.fn<typeof fetch>(() => response.promise);
  const running = collectDownloadSizes({ request, repositoryFetch, signal: new AbortController().signal });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(await running).toEqual({ sizes: [], quotaLimited: false });
  const cancel = vi.fn(); const pull = vi.fn();
  response.resolve(new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 })));
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  expect(pull).not.toHaveBeenCalled(); expect(repositoryFetch).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('treats malformed JSON as unavailable without probing an artifact URL', async () => {
  const repositoryFetch = vi.fn<typeof fetch>(async () => new Response('{invalid'));
  expect(await collectDownloadSizes({ request, repositoryFetch, signal: new AbortController().signal })).toEqual({ sizes: [], quotaLimited: false });
  expect(repositoryFetch).toHaveBeenCalledOnce();
});
