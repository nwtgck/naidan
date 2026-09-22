// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { fetchProductionRuntimeModule, runtimeModuleBytesSchema, verifiedRuntimeModuleBlob } from './production-runtime-module';
import { resolveHostedTransformersRuntimeAssetUrls } from './configure-hosted-runtime';
import { createDownloadedModelWorkerFetch } from './offline-worker-fetch';
import { productionRuntimeModuleFixtureBytes } from './fixtures/production-runtime-startup-fixture';

const identity = {
  workerLocationUrl: 'http://localhost/assets/worker.js', environment: 'development' as const,
  userAgent: 'Chrome', vendor: 'Google Inc.',
};
const assets = resolveHostedTransformersRuntimeAssetUrls(identity);
const originalBytes = productionRuntimeModuleFixtureBytes({ variant: 'asyncify' });
const originalSha256 = '5959c6733039619c9af710d8e1bae8d6e84402787990637be987c2b1bd6c5fa9';

function guardedResponse({ response }: { response: Response }) {
  const transport = vi.fn<typeof fetch>(async () => response);
  const runtimeFetch = createDownloadedModelWorkerFetch({ ...identity, originalFetch: transport });
  return { transport, runtimeFetch };
}

afterEach(() => vi.restoreAllMocks());

it('fetches the complete pinned module once through the real runtime guard without importing or creating a URL', async () => {
  const createObjectURL = vi.spyOn(URL, 'createObjectURL');
  const h = guardedResponse({ response: new Response(originalBytes, {
    headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Content-Length': '47389' },
  }) });
  const bytes = await fetchProductionRuntimeModule({ assets, runtimeFetch: h.runtimeFetch });
  expect(bytes.byteLength).toBe(47_389);
  expect(bytes.byteOffset).toBe(0);
  expect(bytes.buffer.byteLength).toBe(bytes.byteLength);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(originalSha256);
  expect(h.transport).toHaveBeenCalledExactlyOnceWith(assets.mjsUrl, { method: 'GET', redirect: 'error' });
  expect(createObjectURL).not.toHaveBeenCalled();
});

it('verifies the independently pinned standard module without accepting an asyncify-sized replacement', async () => {
  const bytes = productionRuntimeModuleFixtureBytes({ variant: 'standard' });
  const blob = await verifiedRuntimeModuleBlob({ bytes, variant: 'standard' });
  expect(blob.size).toBe(24_180);
  expect(createHash('sha256').update(new Uint8Array(await blob.arrayBuffer())).digest('hex')).toBe('5f2cd914554830762579c372d0211614c1e3f40ab3f6c0cfcf0900343229071d');
  await expect(verifiedRuntimeModuleBlob({ bytes: originalBytes, variant: 'standard' })).rejects.toThrow('byte length');
});

it('uses decoded bytes rather than compressed Content-Length for full module verification', async () => {
  const h = guardedResponse({ response: new Response(originalBytes, {
    headers: { 'Content-Type': 'text/javascript', 'Content-Encoding': 'gzip', 'Content-Length': '123' },
  }) });
  const bytes = await fetchProductionRuntimeModule({ assets, runtimeFetch: h.runtimeFetch });
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(originalSha256);
});

it('rejects HTTP 206 before reading the body and owns its cancellation', async () => {
  const pull = vi.fn();
  const cancel = vi.fn();
  const h = guardedResponse({ response: new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
    status: 206, headers: { 'Content-Type': 'text/javascript', 'Content-Range': 'bytes 0-1/47389' },
  }) });
  await expect(fetchProductionRuntimeModule({ assets, runtimeFetch: h.runtimeFetch })).rejects.toThrow('complete HTTP 200');
  expect(pull).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
});

it('rejects a Content-Range response even when its HTTP status is 200', async () => {
  const cancel = vi.fn();
  const h = guardedResponse({ response: new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }), {
    headers: { 'Content-Type': 'text/javascript', 'Content-Range': 'bytes 0-47388/99999' },
  }) });
  await expect(fetchProductionRuntimeModule({ assets, runtimeFetch: h.runtimeFetch })).rejects.toThrow('complete HTTP 200');
  expect(cancel).toHaveBeenCalledOnce();
});

it('rejects non-JavaScript MIME without consuming its unread body', async () => {
  const pull = vi.fn();
  const cancel = vi.fn();
  const h = guardedResponse({ response: new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
    headers: { 'Content-Type': 'text/html' },
  }) });
  await expect(fetchProductionRuntimeModule({ assets, runtimeFetch: h.runtimeFetch })).rejects.toThrow('not JavaScript');
  expect(pull).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
});

it('rejects an absent body instead of certifying an empty module', async () => {
  const h = guardedResponse({ response: new Response(null, { headers: { 'Content-Type': 'text/javascript' } }) });
  await expect(fetchProductionRuntimeModule({ assets, runtimeFetch: h.runtimeFetch })).rejects.toThrow('no body');
});

it('rejects a short body despite a header advertising the full length and releases its reader', async () => {
  const response = new Response(originalBytes.slice(0, -1), {
    headers: { 'Content-Type': 'text/javascript', 'Content-Length': '47389' },
  });
  const h = guardedResponse({ response });
  await expect(fetchProductionRuntimeModule({ assets, runtimeFetch: h.runtimeFetch })).rejects.toThrow('before its complete byte length');
  expect(response.body?.locked).toBe(false);
});

it('rejects an oversized chunk immediately without pulling later data', async () => {
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => controller.enqueue(new Uint8Array(47_390)));
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'text/javascript' } });
  const h = guardedResponse({ response });
  await expect(fetchProductionRuntimeModule({ assets, runtimeFetch: h.runtimeFetch })).rejects.toThrow('exceeds');
  expect(pull).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledOnce();
  expect(response.body?.locked).toBe(false);
});

it('rejects corruption at the correct byte length instead of accepting length alone', async () => {
  const bytes = originalBytes.slice();
  bytes[0] = bytes[0]! ^ 1;
  const h = guardedResponse({ response: new Response(bytes, { headers: { 'Content-Type': 'text/javascript' } }) });
  await expect(fetchProductionRuntimeModule({ assets, runtimeFetch: h.runtimeFetch })).rejects.toThrow('hash differs');
});

it('keeps a read error primary even when cancellation rejects and reader release throws', async () => {
  const failure = new Error('fixture read failed');
  const stream = new ReadableStream<Uint8Array>({ pull: () => {
    throw failure;
  } }, { highWaterMark: 0 });
  const response = new Response(stream, { headers: { 'Content-Type': 'text/javascript' } });
  const reader = stream.getReader();
  vi.spyOn(stream, 'getReader').mockReturnValue(reader);
  vi.spyOn(reader, 'cancel').mockRejectedValue(new Error('fixture cancel failed'));
  const nativeRelease = reader.releaseLock.bind(reader);
  vi.spyOn(reader, 'releaseLock').mockImplementation(() => {
    nativeRelease();
    throw new Error('fixture release failed');
  });
  const h = guardedResponse({ response });
  await expect(fetchProductionRuntimeModule({ assets, runtimeFetch: h.runtimeFetch })).rejects.toBe(failure);
  expect(reader.cancel).toHaveBeenCalledOnce();
  expect(reader.releaseLock).toHaveBeenCalledOnce();
});

it('does not certify successful reading when the only failure is reader release', async () => {
  const stream = new ReadableStream<Uint8Array>({ start: controller => {
    controller.enqueue(originalBytes); controller.close();
  } });
  const response = new Response(stream, { headers: { 'Content-Type': 'text/javascript' } });
  const reader = stream.getReader();
  vi.spyOn(stream, 'getReader').mockReturnValue(reader);
  const failure = new Error('fixture release failed');
  const nativeRelease = reader.releaseLock.bind(reader);
  vi.spyOn(reader, 'releaseLock').mockImplementation(() => {
    nativeRelease(); throw failure;
  });
  const h = guardedResponse({ response });
  await expect(fetchProductionRuntimeModule({ assets, runtimeFetch: h.runtimeFetch })).rejects.toBe(failure);
});

it('returns the known HTTP error without waiting for a cancellation that never settles', async () => {
  const pending = Promise.withResolvers<void>();
  const cancel = vi.fn(() => pending.promise);
  const h = guardedResponse({ response: new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }), {
    status: 503, headers: { 'Content-Type': 'text/javascript' },
  }) });
  try {
    await expect(fetchProductionRuntimeModule({ assets, runtimeFetch: h.runtimeFetch })).rejects.toThrow('complete HTTP 200');
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    pending.resolve();
  }
});

it('preserves the known status failure when unread-body cancellation throws synchronously', async () => {
  const response = new Response(new ReadableStream({}, { highWaterMark: 0 }), { status: 403 });
  vi.spyOn(response.body!, 'cancel').mockImplementation(() => {
    throw new Error('secondary cancellation failure');
  });
  const h = guardedResponse({ response });
  await expect(fetchProductionRuntimeModule({ assets, runtimeFetch: h.runtimeFetch })).rejects.toThrow('complete HTTP 200');
});

it('rejects an already locked body and does not release another owner\'s reader', async () => {
  const response = new Response(originalBytes, { headers: { 'Content-Type': 'text/javascript' } });
  const owner = response.body!.getReader();
  const h = guardedResponse({ response });
  try {
    await expect(fetchProductionRuntimeModule({ assets, runtimeFetch: h.runtimeFetch })).rejects.toBeInstanceOf(TypeError);
    expect(response.body?.locked).toBe(true);
  } finally {
    await owner.cancel();
    owner.releaseLock();
  }
});

it('requires a tight owned ArrayBuffer rather than a subview or excess backing bytes', () => {
  expect(runtimeModuleBytesSchema.safeParse(originalBytes).success).toBe(true);
  expect(runtimeModuleBytesSchema.safeParse(new Uint8Array(new ArrayBuffer(47_390), 1, 47_389)).success).toBe(false);
  expect(runtimeModuleBytesSchema.safeParse(new Uint8Array(new ArrayBuffer(47_390), 0, 47_389)).success).toBe(false);
  expect(runtimeModuleBytesSchema.safeParse(new Uint8Array(47_390)).success).toBe(false);
  expect(runtimeModuleBytesSchema.safeParse(new Uint8Array()).success).toBe(false);
});

it('rejects shared backing memory that could change while the host hashes it', async () => {
  const bytes = new Uint8Array(new SharedArrayBuffer(47_389));
  bytes.set(originalBytes);
  expect(runtimeModuleBytesSchema.safeParse(bytes).success).toBe(false);
  await expect(verifiedRuntimeModuleBlob({ bytes, variant: 'asyncify' })).rejects.toThrow('exact ArrayBuffer');
});

it('hashes and returns the same immutable Blob snapshot when input bytes change after verification starts', async () => {
  const bytes = originalBytes.slice();
  const pending = verifiedRuntimeModuleBlob({ bytes, variant: 'asyncify' });
  bytes.fill(0);
  const blob = await pending;
  expect(blob.type).toBe('text/javascript');
  expect(blob.size).toBe(47_389);
  expect(createHash('sha256').update(new Uint8Array(await blob.arrayBuffer())).digest('hex')).toBe(originalSha256);
});
