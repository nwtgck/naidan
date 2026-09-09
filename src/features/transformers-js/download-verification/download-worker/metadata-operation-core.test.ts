// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { createRuntimeMetadataOperation, RUNTIME_METADATA_CLEANUP_TIMEOUT_MS } from './metadata-operation';
import type { RuntimeMetadataStorage } from './metadata-storage';

const modelId = 'fixture/public-model';
const revision = 'a'.repeat(40);
const base = `https://huggingface.co/${modelId}/resolve/${revision}/`;

function operationFixture() {
  const files = new Map<string, Uint8Array>();
  const storage = {
    read: vi.fn<RuntimeMetadataStorage['read']>(async ({ url }) => {
      const bytes = files.get(url);
      return bytes === undefined ? undefined : { byteLength: bytes.byteLength, response: new Response(Uint8Array.from(bytes), { headers: { 'Content-Length': String(bytes.byteLength) } }) };
    }),
    stat: vi.fn<RuntimeMetadataStorage['stat']>(async ({ url }) => files.get(url)?.byteLength),
    write: vi.fn<RuntimeMetadataStorage['write']>(async ({ url, response }) => {
      files.set(url, new Uint8Array(await response.arrayBuffer()));
    }),
  };
  const network = vi.fn<typeof fetch>(async () => new Response('{}', { headers: { 'Content-Length': '2' } }));
  const operation = createRuntimeMetadataOperation({ modelId, revision, downloadFetch: network, storage, maximumByteLength: 64 });
  return { operation, network, storage, files };
}

afterEach(() => vi.useRealTimers());

it('rejects an oversized resource advertised by a one-byte size probe before runtime buffer allocation', async () => {
  const h = operationFixture();
  h.network.mockResolvedValue(new Response(Uint8Array.of(123), {
    status: 206, headers: { 'Content-Length': '1', 'Content-Range': 'bytes 0-0/1000000000000' },
  }));
  const outcome = await h.operation.fetch(`${base}config.json`, { headers: { Range: 'bytes=0-0' } })
    .then(response => response.body?.cancel(), (error: unknown) => error);
  await h.operation.finish().catch(() => undefined);
  expect(outcome).toBeInstanceOf(Error);
  expect((outcome as Error).message).toContain('size');
  expect(h.storage.write).not.toHaveBeenCalled();
});

it('rejects a full metadata fetch with Content-Range even when its status is 200', async () => {
  const h = operationFixture();
  const cancel = vi.fn();
  const pull = vi.fn();
  h.network.mockResolvedValue(new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
    headers: { 'Content-Length': '2', 'Content-Range': 'bytes 0-1/100' },
  }));
  const outcome = await h.operation.fetch(`${base}tokenizer.json`).then(() => undefined, (error: unknown) => error);
  await expect(h.operation.finish()).rejects.toBe(outcome);
  expect(outcome).toBeInstanceOf(Error);
  expect((outcome as Error).message).toContain('Content-Range');
  expect(h.storage.write).not.toHaveBeenCalled();
  expect(pull).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
});

it('rejects a partial metadata cache put instead of silently declaring preparation finished', async () => {
  const h = operationFixture();
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }), {
    status: 206, headers: { 'Content-Length': '2', 'Content-Range': 'bytes 0-1/100' },
  });
  const outcome = await h.operation.cache.put(`${base}tokenizer.json`, response).then(() => undefined, (error: unknown) => error);
  await expect(h.operation.finish()).rejects.toBe(outcome);
  expect(outcome).toBeInstanceOf(Error);
  expect((outcome as Error).message).toContain('206');
  expect(h.storage.write).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
});

it('does not create a save obligation for an optional 404 and closes its unread response', async () => {
  const h = operationFixture();
  const cancel = vi.fn();
  h.network.mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 404 }));
  await h.operation.fetch(`${base}processor_config.json`);
  await h.operation.finish();
  expect(h.storage.write).not.toHaveBeenCalled();
  expect(h.storage.stat).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('waits for an unawaited put to close and for its fresh stat before readiness', async () => {
  const h = operationFixture();
  const entered = Promise.withResolvers<void>();
  const close = Promise.withResolvers<void>();
  h.storage.write.mockImplementation(async ({ url, response }) => {
    const bytes = new Uint8Array(await response.arrayBuffer());
    entered.resolve(); await close.promise; h.files.set(url, bytes);
  });
  const put = h.operation.cache.put(`${base}tokenizer.json`, new Response('{}'));
  await entered.promise;
  let ready = false;
  const finish = h.operation.finish().then(() => {
    ready = true;
  });
  await Promise.resolve();
  expect(ready).toBe(false);
  expect(h.storage.stat).not.toHaveBeenCalled();
  close.resolve();
  await put; await finish;
  expect(ready).toBe(true);
  expect(h.storage.stat).toHaveBeenCalledTimes(2);
});

it('rejects a file disappearing after successful put instead of trusting its previous completion', async () => {
  const h = operationFixture();
  await h.operation.cache.put(`${base}tokenizer.json`, new Response('{}'));
  h.files.delete(`${base}tokenizer.json`);
  await expect(h.operation.finish()).rejects.toThrow('complete saved resource');
});

it('rejects a successful consumed response that was never persisted by the upstream caller', async () => {
  const h = operationFixture();
  const response = await h.operation.fetch(`${base}tokenizer.json`);
  await response.arrayBuffer();
  await expect(h.operation.finish()).rejects.toThrow('complete saved resource');
});

it('retains non-NotFound local I/O failure even if the consumer catches the cache miss', async () => {
  const h = operationFixture();
  const primary = new DOMException('fixture permission failure', 'NotAllowedError');
  h.storage.stat.mockImplementation(() => {
    throw primary;
  });
  await h.operation.cache.match(`${base}tokenizer.json`).catch(() => undefined);
  await expect(h.operation.finish()).rejects.toBe(primary);
  expect(h.network).not.toHaveBeenCalled();
});

it('rejects oversized cached metadata before opening its response body', async () => {
  const h = operationFixture();
  h.storage.stat.mockResolvedValue(65);
  await h.operation.cache.match(`${base}tokenizer.json`).catch(() => undefined);
  await expect(h.operation.finish()).rejects.toThrow('byte limit');
  expect(h.storage.read).not.toHaveBeenCalled();
});

it('cancels a late remote response that arrives after failure cleanup has started', async () => {
  const h = operationFixture();
  const entered = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const cancel = vi.fn();
  h.network.mockImplementation(async () => {
    entered.resolve(); return response.promise;
  });
  const read = h.operation.fetch(`${base}tokenizer.json`).catch(error => error);
  await entered.promise;
  const primary = new Error('fixture primary failure');
  const stopped = h.operation.abort({ error: primary }).catch(error => error);
  response.resolve(new Response(new ReadableStream({ cancel })));
  expect(await read).toBe(primary);
  expect(await stopped).toBe(primary);
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('cancels a late cache response that arrives after failure cleanup has started', async () => {
  const h = operationFixture();
  const entered = Promise.withResolvers<void>();
  const response = Promise.withResolvers<{ byteLength: number, response: Response }>();
  const cancel = vi.fn();
  h.storage.stat.mockResolvedValue(2);
  h.storage.read.mockImplementation(async () => {
    entered.resolve(); return response.promise;
  });
  const read = h.operation.cache.match(`${base}tokenizer.json`).catch(error => error);
  await entered.promise;
  const primary = new Error('fixture primary failure');
  const stopped = h.operation.abort({ error: primary }).catch(error => error);
  response.resolve({ byteLength: 2, response: new Response(new ReadableStream({ cancel })) });
  expect(await read).toBe(primary);
  expect(await stopped).toBe(primary);
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('still owns and cancels a remote response arriving after the cleanup deadline', async () => {
  vi.useFakeTimers();
  const h = operationFixture();
  const entered = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const cancel = vi.fn();
  h.network.mockImplementation(async () => {
    entered.resolve(); return response.promise;
  });
  const read = h.operation.fetch(`${base}tokenizer.json`).catch(error => error);
  await entered.promise;
  const primary = new Error('fixture primary failure');
  const stopped = h.operation.abort({ error: primary }).catch(error => error);
  await vi.advanceTimersByTimeAsync(RUNTIME_METADATA_CLEANUP_TIMEOUT_MS);
  expect(await stopped).toBe(primary);
  response.resolve(new Response(new ReadableStream({ cancel })));
  expect(await read).toBe(primary);
  await vi.advanceTimersByTimeAsync(0);
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('fails cleanup rather than becoming ready when an unread reader refuses to cancel', async () => {
  vi.useFakeTimers();
  const h = operationFixture();
  const cancel = vi.fn(async () => new Promise<void>(() => {}));
  h.network.mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 404 }));
  await h.operation.fetch(`${base}processor_config.json`);
  let ready = false;
  const outcome = h.operation.finish().then(() => {
    ready = true; return undefined;
  }, error => error);
  await vi.advanceTimersByTimeAsync(RUNTIME_METADATA_CLEANUP_TIMEOUT_MS);
  expect(await outcome).toBeInstanceOf(Error);
  expect(ready).toBe(false);
  expect(cancel).toHaveBeenCalledTimes(1);
  await expect(h.operation.fetch(`${base}config.json`)).rejects.toThrow();
  expect(h.network).toHaveBeenCalledTimes(1);
});

it('keeps the primary failure when reader cancellation throws synchronously', async () => {
  const h = operationFixture();
  const cancel = vi.fn(() => {
    throw new Error('fixture cancel failure');
  });
  h.network.mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 404 }));
  await h.operation.fetch(`${base}processor_config.json`);
  const primary = new Error('fixture primary failure');
  await expect(h.operation.abort({ error: primary })).rejects.toBe(primary);
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('does not wait for an unread response clone branch to be consumed', async () => {
  const h = operationFixture();
  const response = await h.operation.fetch(`${base}tokenizer.json`);
  const clone = response.clone();
  const bytes = new Uint8Array(await clone.arrayBuffer());
  await h.operation.cache.put(`${base}tokenizer.json`, new Response(bytes));
  // The original tee branch deliberately remains unread.
  await h.operation.finish();
  expect(h.files.get(`${base}tokenizer.json`)).toEqual(new TextEncoder().encode('{}'));
});

it('blocks safetensors before transport rather than treating it as bounded metadata', async () => {
  const h = operationFixture();
  await expect(h.operation.fetch(`${base}model.safetensors`)).rejects.toThrow('MUST NOT fetch model artifacts');
  await expect(h.operation.finish()).rejects.toThrow('MUST NOT fetch model artifacts');
  expect(h.network).not.toHaveBeenCalled();
});

it('blocks a root-level bin weight before transport', async () => {
  const h = operationFixture();
  await expect(h.operation.fetch(`${base}pytorch_model.bin`)).rejects.toThrow('MUST NOT fetch model artifacts');
  await expect(h.operation.finish()).rejects.toThrow('MUST NOT fetch model artifacts');
  expect(h.network).not.toHaveBeenCalled();
});

it('permits an authorized partial presence probe without persisting it as a complete metadata file', async () => {
  const h = operationFixture();
  h.network.mockResolvedValue(new Response(Uint8Array.of(123), {
    status: 206,
    headers: { 'Content-Length': '1', 'Content-Range': 'bytes 0-0/32' },
  }));
  const response = await h.operation.fetch(`${base}tokenizer_config.json`, { headers: { Range: 'bytes=0-0' } });
  expect(response.status).toBe(206);
  expect(await response.text()).toBe('{');
  await h.operation.finish();
  expect(h.storage.write).not.toHaveBeenCalled();
  expect(h.storage.stat).not.toHaveBeenCalled();
});

it('rejects an unknown exact-revision Range before transport', async () => {
  const h = operationFixture();
  await h.operation.fetch(`${base}tokenizer_config.json`, { headers: { Range: 'bytes=7-9' } }).catch(() => undefined);
  await expect(h.operation.finish()).rejects.toThrow(/Range/u);
  expect(h.network).not.toHaveBeenCalled();
});

it('rejects an unsolicited partial response instead of accepting a swallowed optional failure', async () => {
  const h = operationFixture();
  const cancel = vi.fn();
  h.network.mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 206 }));
  await h.operation.fetch(`${base}processor_config.json`).catch(() => undefined);
  await expect(h.operation.finish()).rejects.toThrow('206');
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('preserves HTTP rejection as the primary error when unread-body cancellation also throws', async () => {
  const h = operationFixture();
  const cancel = vi.fn(() => {
    throw new Error('fixture secondary cancellation failure');
  });
  h.network.mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 403 }));
  await h.operation.fetch(`${base}processor_config.json`).catch(() => undefined);
  await expect(h.operation.finish()).rejects.toThrow('403');
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('does not persist or require a cached optional 404 response', async () => {
  const h = operationFixture();
  await h.operation.cache.put(`${base}processor_config.json`, new Response('missing', { status: 404 }));
  await h.operation.finish();
  expect(h.storage.write).not.toHaveBeenCalled();
  expect(h.storage.stat).not.toHaveBeenCalled();
});

it('rejects an HTML success response without turning it into durable metadata', async () => {
  const h = operationFixture();
  h.network.mockResolvedValue(new Response('<html>fixture</html>', { headers: { 'Content-Type': 'text/html' } }));
  await h.operation.fetch(`${base}processor_config.json`).catch(() => undefined);
  await expect(h.operation.finish()).rejects.toThrow(/HTML/u);
  expect(h.storage.write).not.toHaveBeenCalled();
});

it('preserves method, headers and signal overrides on a Request without treating tokenizer.model as weights', async () => {
  const h = operationFixture();
  const stale = new AbortController(); stale.abort();
  const active = new AbortController();
  const request = new Request(`${base}tokenizer.model`, { method: 'POST', headers: { 'X-Fixture': 'old' }, signal: stale.signal });
  const response = await h.operation.fetch(request, { method: 'GET', headers: { 'X-Fixture': 'new' }, signal: active.signal });
  const [input, init] = h.network.mock.calls[0]!;
  const effective = new Request(input, init);
  expect(effective.method).toBe('GET');
  expect(effective.headers.get('X-Fixture')).toBe('new');
  expect(effective.signal.aborted).toBe(false);
  await h.operation.cache.put(`${base}tokenizer.model`, new Response(await response.arrayBuffer()));
  await h.operation.finish();
  active.abort();
  expect(effective.signal.aborted).toBe(true);
});

it('rejects an already-aborted Request before transport', async () => {
  const h = operationFixture();
  const controller = new AbortController(); controller.abort();
  await h.operation.fetch(new Request(`${base}config.json`, { signal: controller.signal })).catch(() => undefined);
  await expect(h.operation.finish()).rejects.toMatchObject({ name: 'AbortError' });
  expect(h.network).not.toHaveBeenCalled();
});

it('rejects relative transport URLs without resolving them against a Worker or user path', async () => {
  const h = operationFixture();
  await h.operation.fetch(`/models/${modelId}/config.json`).catch(() => undefined);
  await expect(h.operation.finish()).rejects.toThrow();
  expect(h.network).not.toHaveBeenCalled();
});

it('does not read the mutable-main cache when a known presence key is requested', async () => {
  const h = operationFixture();
  h.files.set(`${base}tokenizer_config.json`, new TextEncoder().encode('{}'));
  const response = await h.operation.cache.match(`https://huggingface.co/${modelId}/resolve/main/tokenizer_config.json`);
  expect(response?.headers.get('Content-Length')).toBe('2');
  expect(h.storage.stat.mock.calls).toEqual([[{ url: `${base}tokenizer_config.json` }]]);
  expect(h.storage.read).not.toHaveBeenCalled();
  await h.operation.finish();
});

it('waits for the final fresh stat instead of publishing readiness after writer close alone', async () => {
  const h = operationFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<number>();
  await h.operation.cache.put(`${base}tokenizer.json`, new Response('{}'));
  h.storage.stat.mockImplementation(async () => {
    entered.resolve(); return release.promise;
  });
  let ready = false;
  const finishing = h.operation.finish().then(() => {
    ready = true;
  });
  await entered.promise;
  expect(ready).toBe(false);
  release.resolve(2); await finishing;
  expect(ready).toBe(true);
});

it('keeps the first failure when a different already-started writer later succeeds', async () => {
  const h = operationFixture();
  const failing = Promise.withResolvers<void>();
  const succeeding = Promise.withResolvers<void>();
  const bothStarted = Promise.withResolvers<void>();
  let started = 0;
  const primary = new Error('fixture first writer failure');
  h.storage.write.mockImplementation(async ({ url, response }) => {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (++started === 2) bothStarted.resolve();
    if (url.endsWith('/tokenizer.json')) {
      await failing.promise; throw primary;
    }
    await succeeding.promise; h.files.set(url, bytes);
  });
  const first = h.operation.cache.put(`${base}tokenizer.json`, new Response('{}')).catch(error => error);
  const second = h.operation.cache.put(`${base}tokenizer_config.json`, new Response('{}')).catch(error => error);
  await bothStarted.promise;
  failing.resolve(); expect(await first).toBe(primary);
  succeeding.resolve(); expect(await second).toBe(primary);
  expect(h.files.has(`${base}tokenizer_config.json`)).toBe(true);
  await expect(h.operation.finish()).rejects.toBe(primary);
});
