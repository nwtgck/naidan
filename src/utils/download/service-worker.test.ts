// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serveByteStream } from '@/utils/byte-stream-port';
import { installStreamDownloadWorker, type DownloadFetchEvent, type DownloadMessageEvent, type DownloadWorkerScope } from './service-worker';
import { createDownloadUrl, DOWNLOAD_EVENT_LEASE_MS, type DownloadVersion } from './protocol';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture({ size, filename, version }: { size: number | undefined, filename: string, version: DownloadVersion }) {
  let onMessage!: (event: DownloadMessageEvent) => void;
  let onFetch!: (event: DownloadFetchEvent) => void;
  const scope = {
    registration: { scope: 'https://example.test/nested/app/' },
    clients: { get: vi.fn(async () => ({ id: 'owner' })) },
    addEventListener(type: string, listener: unknown) {
      if (type === 'message') onMessage = listener as typeof onMessage;
      if (type === 'fetch') onFetch = listener as typeof onFetch;
    },
  };
  installStreamDownloadWorker({ scope: scope as DownloadWorkerScope });
  const control = new MessageChannel();
  const data = new MessageChannel();
  const messages: Array<{ type: string }> = [];
  control.port1.onmessage = event => messages.push(event.data);
  const token = crypto.randomUUID();
  const url = createDownloadUrl({ base: new URL(scope.registration.scope), token, version }).href;
  let completed: Promise<unknown> = Promise.resolve();
  const prepare = ({ stream, owner }: { stream: ReadableStream<Uint8Array>, owner: string }) => {
    const openStream = vi.fn(async () => stream);
    const sender = serveByteStream({ port: data.port1, openStream, signal: undefined });
    onMessage({
      data: { type: 'naidan-download/prepare', version, token, metadata: { filename, size } },
      source: { id: owner, type: 'window', url: 'https://example.test/nested/app/index.html#/files' },
      ports: [control.port2, data.port2],
      waitUntil(promise) {
        completed = promise;
      },
    });
    cleanups.push(async () => {
      control.port1.postMessage({ type: 'cancel' });
      await completed;
      sender.abort({ reason: new Error('test cleanup') });
      control.port1.close();
    });
    return { sender, openStream };
  };
  const fetch = ({ clientId, method, range, requestUrl, mode }: {
    clientId: string, method: string, range: string | undefined, requestUrl: string, mode: 'navigate' | 'cors',
  }) => {
    let response: Response | Promise<Response> | undefined;
    let lifetime: Promise<unknown> | undefined;
    const event: DownloadFetchEvent = {
      request: new Request(requestUrl, { method, referrer: '', headers: range ? { Range: range } : {} }),
      clientId,
      respondWith(value) {
        response = value;
      },
      waitUntil(promise) {
        lifetime = promise;
      },
      stopImmediatePropagation: vi.fn(),
    };
    if (mode === 'navigate') Object.defineProperty(event.request, 'mode', { value: mode });
    onFetch(event);
    return { response: response as Response, event, lifetime };
  };
  const heartbeat = ({ owner }: { owner: string }) => {
    let lifetime: Promise<unknown> | undefined;
    onMessage({
      data: { type: 'naidan-download/keepalive', version, token },
      source: { id: owner, type: 'window', url: 'https://example.test/nested/app/index.html' },
      ports: [],
      waitUntil(promise) {
        lifetime = promise;
      },
    });
    return lifetime;
  };
  return { prepare, fetch, messages, url, scope, control, heartbeat };
}

describe('streaming download Service Worker', () => {
  it('claims once under a nested scope, without opening the source during registration', async () => {
    const f = fixture({ version: 1, size: undefined, filename: '日本語.zip' });
    const source = f.prepare({
      owner: 'owner',
      stream: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3])); controller.close();
      },
    }),
    });
    await vi.waitFor(() => expect(f.messages).toContainEqual(expect.objectContaining({ type: 'ready' })));
    expect(source.openStream).not.toHaveBeenCalled();
    const { response, event } = f.fetch({ mode: 'cors', clientId: 'owner', method: 'GET', range: undefined, requestUrl: f.url });
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(response.headers.has('content-length')).toBe(false);
    expect(response.headers.get('content-disposition')).toContain('attachment;');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
    await source.sender.completed;
    await vi.waitFor(() => expect(f.messages).toContainEqual({ type: 'consumed' }));
    expect(f.fetch({ mode: 'cors', clientId: 'owner', method: 'GET', range: undefined, requestUrl: f.url }).response.status).toBe(410);
  });

  it('does not let a foreign client, range, HEAD, or POST consume the reservation', async () => {
    const f = fixture({ version: 1, size: 0, filename: 'empty' });
    f.prepare({
      owner: 'owner',
      stream: new ReadableStream({
      start(controller) {
      controller.close();
    },
    }),
    });
    for (const [clientId, method, range, status] of [
      ['other', 'GET', undefined, 403], ['owner', 'HEAD', undefined, 405],
      ['owner', 'POST', undefined, 405], ['owner', 'GET', 'bytes=0-', 416],
    ] as const) {
      expect(f.fetch({ mode: 'cors', clientId, method, range, requestUrl: f.url }).response.status).toBe(status);
    }
    const response = f.fetch({ mode: 'cors', clientId: 'owner', method: 'GET', range: undefined, requestUrl: f.url }).response;
    expect(response.headers.get('content-length')).toBe('0');
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it('returns local errors for unknown URLs instead of falling through to Workbox or the network', () => {
    const f = fixture({ version: 1, size: undefined, filename: 'file' });
    f.control.port1.close();
    for (const requestUrl of [f.url, f.url + '?invalid=1']) {
      const { response, event } = f.fetch({ mode: 'cors', clientId: 'owner', method: 'GET', range: undefined, requestUrl });
      expect(response.status).toBe(410);
      expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    }
    expect(f.fetch({ mode: 'cors', clientId: 'owner', method: 'GET', range: undefined, requestUrl: 'https://example.test/nested/app/other' }).response).toBeUndefined();
  });

  it.each([2, 4])('rejects a dishonest content length of %i rather than reporting completion', async size => {
    const f = fixture({ version: 1, size, filename: 'broken' });
    f.prepare({
      owner: 'owner',
      stream: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3])); controller.close();
      },
    }),
    });
    const response = f.fetch({ mode: 'cors', clientId: 'owner', method: 'GET', range: undefined, requestUrl: f.url }).response;
    await expect(response.arrayBuffer()).rejects.toThrow('size mismatch');
    await vi.waitFor(() => expect(f.messages).toContainEqual(expect.objectContaining({ type: 'error' })));
    expect(f.messages).not.toContainEqual({ type: 'consumed' });
  });

  it('propagates download cancellation to a blocked producer', async () => {
    const f = fixture({ version: 1, size: undefined, filename: 'cancelled' });
    const cancel = vi.fn();
    const source = f.prepare({
      owner: 'owner',
      stream: new ReadableStream({
      pull() {
        return new Promise(() => undefined);
      },
      cancel,
    }),
    });
    const response = f.fetch({ mode: 'cors', clientId: 'owner', method: 'GET', range: undefined, requestUrl: f.url }).response;
    const reader = response.body!.getReader();
    const read = reader.read();
    await vi.waitFor(() => expect(source.openStream).toHaveBeenCalledOnce());
    await reader.cancel();
    await read;
    await expect(source.sender.completed).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('errors the response rather than leaving it open when claim acknowledgement fails', async () => {
    const f = fixture({ version: 1, size: undefined, filename: 'broken-control' });
    const source = f.prepare({ owner: 'owner', stream: new ReadableStream() });
    await vi.waitFor(() => expect(f.messages).toContainEqual(expect.objectContaining({ type: 'ready' })));
    vi.spyOn(f.control.port2, 'postMessage').mockImplementation(() => {
      throw new Error('control channel closed');
    });
    const response = f.fetch({ mode: 'cors', clientId: 'owner', method: 'GET', range: undefined, requestUrl: f.url }).response;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(Promise.race([response.arrayBuffer(), new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('response stayed open')), 100);
      })])).rejects.toThrow('control channel closed');
      await expect(source.sender.completed).rejects.toMatchObject({ name: 'AbortError' });
      expect(source.openStream).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timer);
    }
  });

  it('renews bounded event leases without accumulating timers or requiring byte production', async () => {
    const f = fixture({ version: 1, size: undefined, filename: 'long-download' });
    const source = f.prepare({ owner: 'owner', stream: new ReadableStream() });
    await vi.waitFor(() => expect(f.messages).toContainEqual(expect.objectContaining({ type: 'ready' })));
    vi.useFakeTimers();
    const { response, lifetime } = f.fetch({ mode: 'cors', clientId: 'owner', method: 'GET', range: undefined, requestUrl: f.url });
    let previous = lifetime;
    expect(previous).toBeDefined();
    for (let i = 0; i < 30; i += 1) {
      await vi.advanceTimersByTimeAsync(15_000);
      const settled = vi.fn(); void previous?.then(settled);
      const next = f.heartbeat({ owner: 'owner' });
      await Promise.resolve();
      expect(settled).toHaveBeenCalledOnce();
      expect(next).toBeDefined();
      expect(vi.getTimerCount()).toBe(1);
      previous = next;
    }
    expect(f.heartbeat({ owner: 'another-page' })).toBeUndefined();
    const expired = vi.fn(); void previous?.then(expired);
    await vi.advanceTimersByTimeAsync(DOWNLOAD_EVENT_LEASE_MS);
    expect(expired).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(source.openStream).not.toHaveBeenCalled();
    expect(f.messages).not.toContainEqual({ type: 'consumed' });
    await response.body!.cancel();
    await expect(source.sender.completed).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.heartbeat({ owner: 'owner' })).toBeUndefined();
  });

  it('keeps a paused download responsive to control pings without reading bytes', async () => {
    const f = fixture({ version: 1, size: undefined, filename: 'paused' });
    const source = f.prepare({ owner: 'owner', stream: new ReadableStream() });
    f.control.port1.postMessage({ type: 'ping' });
    await vi.waitFor(() => expect(f.messages).toContainEqual({ type: 'pong' }));
    expect(source.openStream).not.toHaveBeenCalled();
  });
});


describe('fragment downloads', () => {
  it.each(['', 'new-iframe'])('claims once with no referrer and iframe clientId=%j', async clientId => {
    const f = fixture({ version: 2, size: 3, filename: 'private.zip' });
    const source = f.prepare({
      owner: 'owner',
      stream: new ReadableStream({
      start(controller) {
      controller.enqueue(new Uint8Array([7, 8, 9])); controller.close();
    },
    }),
    });
    await vi.waitFor(() => expect(f.messages).toContainEqual(expect.objectContaining({ type: 'ready', version: 2 })));
    expect(source.openStream).not.toHaveBeenCalled();
    const { response, event } = f.fetch({ clientId, method: 'GET', range: undefined, requestUrl: f.url, mode: 'navigate' });
    expect(event.request.referrer).toBe('');
    expect(response.status).toBe(200);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([7, 8, 9]);
    await source.sender.completed;
    expect(f.fetch({ clientId, method: 'GET', range: undefined, requestUrl: f.url, mode: 'navigate' }).response.status).toBe(410);
  });

  it('rejects non-navigation reads and modified URLs without consuming the capability', async () => {
    const f = fixture({ version: 2, size: 0, filename: 'empty' });
    const source = f.prepare({
      owner: 'owner',
      stream: new ReadableStream({
      start(controller) {
      controller.close();
    },
    }),
    });
    const u = new URL(f.url);
    const token = u.hash.substring('#?id='.length);
    const clean = new URL(u); clean.hash = '';
    for (const requestUrl of [clean.href, clean.href + `?id=${token}`, clean.href + token,
      f.url + '&extra=x', f.url + `&id=${token}`, clean.href + `#?id=${crypto.randomUUID()}`,
      clean.href.replace('/v2/', '/v1/') + token]) {
      const { response, event } = f.fetch({ clientId: 'owner', method: 'GET', range: undefined, requestUrl, mode: 'navigate' });
      expect(response.status).toBe(410);
      expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    }
    expect(f.fetch({ clientId: 'owner', method: 'GET', range: undefined, requestUrl: f.url, mode: 'cors' }).response.status).toBe(403);
    expect(source.openStream).not.toHaveBeenCalled();
    const response = f.fetch({ clientId: '', method: 'GET', range: undefined, requestUrl: f.url, mode: 'navigate' }).response;
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it('renews the v2 session on its private channel without leaking it into a path', async () => {
    const f = fixture({ version: 2, size: undefined, filename: 'paused' });
    f.prepare({ owner: 'owner', stream: new ReadableStream() });
    await vi.waitFor(() => expect(f.messages).toContainEqual(expect.objectContaining({ type: 'ready', version: 2 })));
    const response = f.fetch({ clientId: '', method: 'GET', range: undefined, requestUrl: f.url, mode: 'navigate' }).response;
    expect(f.heartbeat({ owner: 'owner' })).toBeDefined();
    expect(f.heartbeat({ owner: 'foreign' })).toBeUndefined();
    await response.body!.cancel();
  });
});
