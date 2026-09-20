import { getReadableStreamTransferSupport } from '@/utils/worker-transport';
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { privacyFetch, privacyFetchStream } from './client-standalone';
import { receivePrivacyStream, servePrivacyStream } from './stream-port';
import { validatePrivacyFetchUrl } from './validate-url';
import { isAllowedHuggingFaceResponseUrl } from './policies/huggingface';

vi.mock('@/utils/worker-transport', async importOriginal => ({
  ...await importOriginal<typeof import('@/utils/worker-transport')>(),
  getReadableStreamTransferSupport: vi.fn(async () => 'unsupported' as const),
}));

const url = 'https://huggingface.co/owner/model/resolve/main/model-Q4.gguf';
const disposers: Array<() => void> = [];

function mockResponse({ body, status, headers, responseUrl }: {
  body: ReadableStream<Uint8Array>, status: number, headers: Record<string, string>, responseUrl: string,
}) {
  const response = new Response(body, { status, headers });
  Object.defineProperty(response, 'url', { value: responseUrl });
  const buffer = vi.spyOn(response, 'arrayBuffer');
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return { buffer, fetchMock };
}

function portStream({ signal }: { signal: AbortSignal | undefined }) {
  const channel = new MessageChannel();
  const finished = vi.fn();
  const client = receivePrivacyStream({ port: channel.port1, signal, onFinish: finished });
  disposers.push(client.dispose);
  servePrivacyStream({ port: channel.port2, request: { url, headers: [['Range', 'bytes=3-']] } });
  return { ...client, finished };
}

beforeEach(() => {
  vi.mocked(getReadableStreamTransferSupport).mockResolvedValue('unsupported');
});

afterEach(() => {
  disposers.splice(0).forEach(dispose => dispose());
  vi.unstubAllGlobals();
});

describe('Hugging Face privacy policy', () => {
  it.each([
    'https://huggingface.co/owner/model',
    'https://huggingface.co/api/datasets/owner/model',
    'https://huggingface.co/api/models/owner/model?token=secret',
    'https://huggingface.co/api/models/owner/model/tree/main?recursive=true&recursive=false',
    'https://huggingface.co/owner/model/resolve/main/run.py',
    'https://huggingface.co/owner/model/resolve/main/foo%2fbar.gguf',
    'https://cas-bridge.xethub.hf.co/model.gguf',
    'https://huggingface.co/owner/model/resolve/main/foo%5cbar.gguf',
    'https://huggingface.co/owner/model/resolve/main/%00bad.gguf',
    'https://huggingface.co.evil.test/api/models/owner/model',
  ])('rejects unsupported initial requests: %s', invalid => {
    expect(validatePrivacyFetchUrl({ urlText: invalid }).ok).toBe(false);
  });

  it.each([
    'https://huggingface.co/api/models/owner/model',
    'https://huggingface.co/api/models/owner/model/revision/main',
    'https://huggingface.co/api/models/owner/model/tree/123abc/subdir?recursive=true&limit=1000&cursor=abc%3D',
    url,
    'https://huggingface.co/owner/model/resolve/main/dir%20name/model%2BQ4%20%E6%97%A5%E6%9C%AC.gguf',
  ])('accepts model metadata and GGUF requests: %s', valid => {
    expect(validatePrivacyFetchUrl({ urlText: valid })).toMatchObject({ ok: true, policyName: 'huggingface_models' });
  });

  it('only permits delivery redirects after a resolve request', () => {
    const responseUrl = 'https://cas-bridge.xethub.hf.co/hash?Policy=private';
    expect(isAllowedHuggingFaceResponseUrl({ requestUrl: url, responseUrl })).toBe(true);
    expect(isAllowedHuggingFaceResponseUrl({ requestUrl: 'https://huggingface.co/api/models/owner/model', responseUrl })).toBe(false);
    expect(isAllowedHuggingFaceResponseUrl({ requestUrl: url, responseUrl: 'https://cas-bridge.xethub.hf.co.evil.test/hash' })).toBe(false);
  });
});

describe('privacy stream transport', () => {
  it('transfers the readable stream when both realms support it', async () => {
    vi.mocked(getReadableStreamTransferSupport).mockResolvedValue('supported');
    const bytes = new Uint8Array(300 * 1024).fill(9);
    const { buffer } = mockResponse({
      body: new ReadableStream({ start(controller) {
        controller.enqueue(bytes); controller.close();
      } }),
      status: 206, headers: {}, responseUrl: url,
    });
    const client = portStream({ signal: undefined });
    const response = await client.response;
    const reader = response.body.getReader();
    expect((await reader.read()).value).toEqual(bytes);
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    await vi.waitFor(() => expect(client.finished).toHaveBeenCalledOnce());
    expect(buffer).not.toHaveBeenCalled();
  });

  it('cancels the native source after a transferred stream is cancelled', async () => {
    vi.mocked(getReadableStreamTransferSupport).mockResolvedValue('supported');
    const cancel = vi.fn();
    mockResponse({ body: new ReadableStream({ cancel }), status: 200, headers: {}, responseUrl: url });
    const client = portStream({ signal: undefined });
    const response = await client.response;
    await response.body.cancel();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(client.finished).toHaveBeenCalledOnce());
  });

  it('returns headers without buffering and preserves range statuses and visible headers', async () => {
    const { buffer, fetchMock } = mockResponse({
      body: new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array([4, 5])); controller.close();
      } }),
      status: 206, headers: { 'Content-Range': 'bytes 3-4/5', ETag: '"tag"' }, responseUrl: url,
    });
    const result = await privacyFetchStream({ request: { url, headers: [['Range', 'bytes=3-'], ['If-Range', '"tag"']] } });
    expect(result.status).toBe(206);
    expect(result.headers.get('content-range')).toBe('bytes 3-4/5');
    expect(result.headers.get('x-repo-commit')).toBeNull();
    expect(buffer).not.toHaveBeenCalled();
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer' });
    expect(new Headers(init?.headers).get('range')).toBe('bytes=3-');
    expect(new Headers(init?.headers).get('if-range')).toBe('"tag"');
    expect(await result.body.getReader().read()).toMatchObject({ value: new Uint8Array([4, 5]) });
  });

  it('retains regular metadata arrayBuffer support', async () => {
    const metadataUrl = 'https://huggingface.co/api/models/owner/model';
    mockResponse({ body: new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{}')); controller.close();
    } }), status: 200, headers: {}, responseUrl: metadataUrl });
    const result = await privacyFetch({ request: { url: metadataUrl } });
    expect(new TextDecoder().decode(result.body)).toBe('{}');
  });

  it('does not return private redirect URLs in errors', async () => {
    const cancel = vi.fn();
    mockResponse({ body: new ReadableStream({ cancel }), status: 200, headers: {}, responseUrl: 'https://evil.test/private?token=secret' });
    await expect(privacyFetchStream({ request: { url } })).rejects.toMatchObject({ code: 'rejected', message: 'Unsupported Hugging Face delivery URL' });
    expect(cancel).toHaveBeenCalled();
  });

  it('normalizes caller headers without interpreting their HTTP meaning', async () => {
    const { fetchMock } = mockResponse({ body: new ReadableStream({ start(controller) {
      controller.close();
    } }), status: 416, headers: {}, responseUrl: url });
    const response = await privacyFetchStream({ request: { url, headers: [['Range', 'bytes=3-'], ['If-Range', '"tag"']] } });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('range')).toBe('bytes=3-');
    await response.body.cancel();
    await expect(privacyFetchStream({ request: { url, headers: [['Invalid Header', 'value']] } })).rejects.toMatchObject({ code: 'rejected' });
    // @ts-expect-error Public request headers must be serializable tuple entries.
    await expect(privacyFetchStream({ request: { url, headers: new Headers({ Range: 'bytes=3-' }) } })).rejects.toMatchObject({ code: 'rejected' });
    // @ts-expect-error Public request headers do not accept record objects.
    await expect(privacyFetchStream({ request: { url, headers: { Range: 'bytes=3-' } } })).rejects.toMatchObject({ code: 'rejected' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([200, 206, 416])('streams a %s response through ports with bounded demand', async status => {
    let reads = 0;
    const { buffer } = mockResponse({
      body: new ReadableStream({ pull(controller) {
        reads++; controller.enqueue(new Uint8Array(300 * 1024).fill(7)); controller.close();
      } }, { highWaterMark: 0 }),
      status, headers: { 'Content-Range': 'bytes 3-307202/307203', Link: '<https://huggingface.co/api/models/owner/model/tree/main?cursor=x>; rel="next"' }, responseUrl: url,
    });
    const client = portStream({ signal: undefined });
    const response = await client.response;
    expect(response.status).toBe(status);
    expect(response.headers.get('link')).toContain('cursor=x');
    expect(reads).toBe(0);
    const reader = response.body.getReader();
    const first = await reader.read();
    expect(first.value?.byteLength).toBe(256 * 1024);
    expect(reads).toBe(1);
    const second = await reader.read();
    expect(second.value?.byteLength).toBe(44 * 1024);
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(buffer).not.toHaveBeenCalled();
    expect(client.finished).toHaveBeenCalledOnce();
  });

  it('cancels the native fetch when the consumer cancels the body', async () => {
    const cancel = vi.fn();
    const { fetchMock } = mockResponse({ body: new ReadableStream({ cancel }), status: 200, headers: {}, responseUrl: url });
    const client = portStream({ signal: undefined });
    const result = await client.response;
    await result.body.cancel();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(client.finished).toHaveBeenCalledOnce();
  });

  it('aborts an unread response after headers', async () => {
    const abort = new AbortController();
    const cancel = vi.fn();
    mockResponse({ body: new ReadableStream({ cancel }), status: 200, headers: {}, responseUrl: url });
    const client = portStream({ signal: abort.signal });
    const result = await client.response;
    abort.abort();
    await expect(result.body.getReader().read()).rejects.toMatchObject({ code: 'aborted' });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it('disposes a response while its read is pending', async () => {
    const { fetchMock } = mockResponse({ body: new ReadableStream(), status: 200, headers: {}, responseUrl: url });
    const client = portStream({ signal: undefined });
    const result = await client.response;
    const pending = result.body.getReader().read();
    client.dispose();
    await expect(pending).rejects.toMatchObject({ code: 'broker_disposed' });
    await vi.waitFor(() => expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true));
  });

  it('propagates stream failure without exposing native error text', async () => {
    mockResponse({ body: new ReadableStream({ pull(controller) {
      controller.error(new Error('private-token'));
    } }, { highWaterMark: 0 }), status: 200, headers: {}, responseUrl: url });
    const client = portStream({ signal: undefined });
    const result = await client.response;
    await expect(result.body.getReader().read()).rejects.toMatchObject({ code: 'fetch_failed', message: 'Privacy fetch stream failed: fetch_failed' });
  });
});
