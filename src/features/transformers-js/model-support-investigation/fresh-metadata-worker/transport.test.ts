// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createFreshMetadataTransport } from './transport';

const modelId = 'fixture/public-model';
const revision = 'a'.repeat(40);
const base = `https://huggingface.co/${modelId}/resolve/${revision}/`;

it('records missing Content-Length and a size probe without retaining signed queries', async () => {
  const originalFetch = vi.fn<typeof fetch>(async () => new Response(Uint8Array.of(123), {
    status: 206, headers: { 'Content-Range': 'bytes 0-0/100' },
  }));
  const transport = createFreshMetadataTransport({ modelId, revision, maximumBytes: 8, originalFetch, signal: new AbortController().signal, onObservation: () => undefined });
  try {
    const response = await transport.fetch(`${base}config.json?token=private-fixture-value`, { headers: { Range: 'bytes=0-0' } });
    expect(response.status).toBe(206);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.of(123));
    expect(transport.snapshot()).toEqual({ receivedBytes: 1, requests: [{
      consumer: 'runtime-preparation',
      path: 'config.json', request: 'size-probe', status: 'complete', httpStatus: 206,
      contentLength: undefined, contentRange: 'bytes 0-0/100', receivedBytes: 1,
    }] });
    expect(originalFetch.mock.calls[0]![1]).toMatchObject({ credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
  } finally {
    transport.dispose();
  }
});

it('counts bodies across requests and rejects the chunk that crosses the operation budget', async () => {
  const originalFetch = vi.fn<typeof fetch>(async () => new Response(Uint8Array.of(1, 2)));
  const transport = createFreshMetadataTransport({ modelId, revision, maximumBytes: 3, originalFetch, signal: new AbortController().signal, onObservation: () => undefined });
  try {
    await (await transport.fetch(`${base}config.json`)).arrayBuffer();
    await expect((await transport.fetch(`${base}tokenizer.json`)).arrayBuffer()).rejects.toThrow('budget');
    expect(transport.snapshot().receivedBytes).toBe(4);
    expect(transport.snapshot().requests.map(item => item.status)).toEqual(['complete', 'failed']);
    await expect(transport.fetch(`${base}processor_config.json`)).rejects.toThrow('budget');
    expect(originalFetch).toHaveBeenCalledTimes(2);
  } finally {
    transport.dispose();
  }
});

it('rejects weights before transport even if another caller bypasses the metadata operation', async () => {
  const originalFetch = vi.fn<typeof fetch>();
  const transport = createFreshMetadataTransport({ modelId, revision, maximumBytes: 8, originalFetch, signal: new AbortController().signal, onObservation: () => undefined });
  await expect(transport.fetch(`${base}onnx/model_q4.onnx`)).rejects.toThrow('model weights');
  expect(originalFetch).not.toHaveBeenCalled();
  expect(transport.snapshot().requests).toEqual([]);
  transport.dispose();
});

it('cancels a transport response that arrives after disposal', async () => {
  const arrived = Promise.withResolvers<Response>();
  const originalFetch = vi.fn<typeof fetch>(() => arrived.promise);
  const cancel = vi.fn();
  const transport = createFreshMetadataTransport({ modelId, revision, maximumBytes: 8, originalFetch, signal: new AbortController().signal, onObservation: () => undefined });
  const result = transport.fetch(`${base}config.json`).then(() => 'accepted', (error: unknown) => error);
  transport.dispose();
  arrived.resolve(new Response(new ReadableStream({ cancel })));
  expect(await result).toBeInstanceOf(Error);
  expect(cancel).toHaveBeenCalledOnce();
});

it('does not report a size probe as cancelled until its source acknowledges cancellation', async () => {
  const started = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const transport = createFreshMetadataTransport({
    modelId, revision, maximumBytes: 1024, signal: new AbortController().signal, onObservation: () => undefined,
    originalFetch: async () => new Response(new ReadableStream({ cancel() {
      started.resolve();
      return finished.promise;
    } })),
  });
  const response = await transport.fetch(`${base}config.json`, { headers: { Range: 'bytes=0-0' } });
  const cancellation = response.body!.cancel();
  try {
    await started.promise;
    expect(transport.snapshot().requests[0]?.status).toBe('cancelling');
    finished.resolve();
    await cancellation;
    expect(transport.snapshot().requests[0]?.status).toBe('cancelled');
  } finally {
    finished.resolve();
    await cancellation;
    transport.dispose();
  }
});
