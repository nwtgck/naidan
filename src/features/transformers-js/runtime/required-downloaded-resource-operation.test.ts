import { afterEach, expect, it, vi } from 'vitest';
import { classifyProductionAcceptanceError } from '@/features/transformers-js/download-verification/logic/production-acceptance-error';
import {
  createRequiredDownloadedResourceOperation,
  disposeRejectedDownloadedRuntime,
  RequiredDownloadedModelResourceError,
  RequiredDownloadedResourceCleanupError,
  REQUIRED_DOWNLOADED_RESOURCE_CLEANUP_TIMEOUT_MS,
} from './required-downloaded-resource-operation';

const modelId = 'org/model';
const revision = '0123456789abcdef0123456789abcdef01234567';
const requiredPath = 'onnx/model_q4f16.onnx';
const requiredUrl = `https://huggingface.co/${modelId}/resolve/${revision}/${requiredPath}`;

function setup({ match }: { match: (request: string | Request) => Promise<Response | undefined> }) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    throw new Error('Offline fetch denied');
  });
  const operation = createRequiredDownloadedResourceOperation({
    modelId, revision, requiredPaths: [requiredPath], workerLocationUrl: 'http://localhost/worker.js',
    modelCache: { match, put: vi.fn() }, cacheOnlyFetch: fetch,
  });
  return { operation, fetch };
}

afterEach(() => vi.useRealTimers());

it('retains an own-scope optional metadata lookup I/O failure after the consumer catches it', async () => {
  const url = `https://huggingface.co/${modelId}/resolve/${revision}/generation_config.json`;
  const cause = new DOMException('Optional metadata permission denied', 'NotAllowedError');
  const { operation } = setup({ match: async () => {
    throw cause;
  } });
  const error = await operation.cache.match(url).catch((error: unknown) => error);
  await operation.close();
  expect(error).toMatchObject({ name: 'RequiredDownloadedModelResourceError', failure: 'io', url, cause });
  expect(operation.assertHealthy).toThrow(error as Error);
});

it('does not treat an optional NotFound lookup as an operation I/O failure', async () => {
  const cause = new DOMException('Optional metadata absent', 'NotFoundError');
  const { operation } = setup({ match: async () => {
    throw cause;
  } });
  await operation.cache.match(`https://huggingface.co/${modelId}/resolve/${revision}/generation_config.json`).catch(() => undefined);
  expect(operation.assertHealthy).not.toThrow();
  await operation.close();
});

it('ignores a non-GET cache request before invoking native lookup or recording a required miss', async () => {
  const match = vi.fn(async () => {
    throw new Error('A non-GET must not reach native storage');
  });
  const { operation } = setup({ match });
  await expect(operation.cache.match(new Request(requiredUrl, { method: 'POST' }))).resolves.toBeUndefined();
  expect(match).not.toHaveBeenCalled();
  expect(operation.assertHealthy).not.toThrow();
  await operation.close();
});

it('keeps the first optional lookup failure when a previously admitted body later fails cancellation', async () => {
  const url = `https://huggingface.co/${modelId}/resolve/${revision}/generation_config.json`;
  const firstCause = new DOMException('First lookup I/O', 'NotAllowedError');
  const laterCause = new DOMException('Later cancellation I/O', 'NotReadableError');
  const match = vi.fn().mockResolvedValueOnce(new Response(new ReadableStream({
    cancel() {
      throw laterCause;
    },
  }, { highWaterMark: 0 }))).mockRejectedValue(firstCause);
  const { operation } = setup({ match });
  await operation.cache.match(url);
  const first = await operation.cache.match(url).catch((error: unknown) => error);
  await operation.close();
  expect(first).toMatchObject({ name: 'RequiredDownloadedModelResourceError', failure: 'io', url, cause: firstCause });
  expect(operation.assertHealthy).toThrow(first as Error);
});

it('records a known main metadata alias lookup I/O against its canonical exact identity', async () => {
  const cause = new DOMException('Canonical metadata unavailable', 'NotReadableError');
  const { operation } = setup({ match: async () => {
    throw cause;
  } });
  const error = await operation.cache.match(`https://huggingface.co/${modelId}/resolve/main/tokenizer_config.json`).catch((error: unknown) => error);
  await operation.close();
  expect(error).toMatchObject({
    name: 'RequiredDownloadedModelResourceError', failure: 'io', cause,
    url: `https://huggingface.co/${modelId}/resolve/${revision}/tokenizer_config.json`,
  });
  expect(operation.assertHealthy).toThrow(error as Error);
});

it('stops on true I/O during an own-scope unselected ONNX metadata prepass', async () => {
  const url = `https://huggingface.co/${modelId}/resolve/${revision}/onnx/vision_encoder_q4f16.onnx`;
  const cause = new DOMException('Prepass storage failure', 'NotReadableError');
  const { operation } = setup({ match: async () => {
    throw cause;
  } });
  const error = await operation.cache.match(url).catch((error: unknown) => error);
  await operation.close();
  // Unlike a normal absent optional modality, a failed native read cannot
  // establish either absence or runtime incompatibility with this candidate.
  expect(error).toMatchObject({ name: 'RequiredDownloadedModelResourceError', failure: 'io', url, cause });
  expect(operation.assertHealthy).toThrow(error as Error);
});

it('retains an optional metadata body read I/O failure even when its consumer catches it', async () => {
  const url = `https://huggingface.co/${modelId}/resolve/${revision}/generation_config.json`;
  const cause = new DOMException('Optional file disappeared mid-read', 'NotFoundError');
  const { operation } = setup({ match: async () => new Response(new ReadableStream({
    pull(controller) {
      controller.error(cause);
    },
  }, { highWaterMark: 0 })) });
  const response = await operation.cache.match(url);
  const error = await response!.text().catch((error: unknown) => error);
  await operation.close();
  // NotFound after a body was admitted is not an ordinary cache lookup MISS.
  expect(error).toMatchObject({ name: 'RequiredDownloadedModelResourceError', failure: 'io', url, cause });
  expect(operation.assertHealthy).toThrow(error as Error);
});

it('retains optional metadata cancellation I/O discovered during cleanup without pulling bytes', async () => {
  const url = `https://huggingface.co/${modelId}/resolve/${revision}/generation_config.json`;
  const cause = new DOMException('Optional cancel failed', 'NotReadableError');
  const pull = vi.fn();
  const { operation } = setup({ match: async () => new Response(new ReadableStream({
    pull, cancel() {
      throw cause;
    },
  }, { highWaterMark: 0 })) });
  await operation.cache.match(url);
  await operation.close();
  expect(pull).not.toHaveBeenCalled();
  expect(operation.assertHealthy).toThrow(RequiredDownloadedModelResourceError);
  try {
    operation.assertHealthy();
  } catch (error) {
    expect(error).toMatchObject({ failure: 'io', url, cause });
  }
});

it('retains optional source reader acquisition failure as operation I/O', async () => {
  const url = `https://huggingface.co/${modelId}/resolve/${revision}/generation_config.json`;
  const source = new ReadableStream<Uint8Array>({}, { highWaterMark: 0 });
  const response = new Response(source);
  const lock = source.getReader();
  const { operation } = setup({ match: async () => response });
  const cached = await operation.cache.match(url);
  const error = await cached!.text().catch((error: unknown) => error);
  lock.releaseLock();
  await operation.close();
  expect(error).toMatchObject({ name: 'RequiredDownloadedModelResourceError', failure: 'io', url, cause: expect.any(TypeError) });
  expect(operation.assertHealthy).toThrow(error as Error);
});

it('retains optional reader release I/O after end-of-stream', async () => {
  const url = `https://huggingface.co/${modelId}/resolve/${revision}/generation_config.json`;
  const cause = new Error('Release lock failed');
  const source = new ReadableStream<Uint8Array>({ pull(controller) {
    controller.close();
  } }, { highWaterMark: 0 });
  const getReader = source.getReader.bind(source);
  const getReaderSpy = vi.spyOn(source, 'getReader').mockImplementation(() => {
    const reader = getReader();
    vi.spyOn(reader, 'releaseLock').mockImplementationOnce(() => {
      throw cause;
    });
    return reader;
  });
  const { operation } = setup({ match: async () => new Response(source) });
  try {
    const cached = await operation.cache.match(url);
    const error = await cached!.text().catch((error: unknown) => error);
    await operation.close();
    expect(error).toMatchObject({ name: 'RequiredDownloadedModelResourceError', failure: 'io', url, cause });
    expect(operation.assertHealthy).toThrow(error as Error);
  } finally {
    getReaderSpy.mockRestore();
  }
});

it('retains cancellation I/O from an optional response arriving after close began', async () => {
  const url = `https://huggingface.co/${modelId}/resolve/${revision}/generation_config.json`;
  const cause = new DOMException('Late response cancel failed', 'NotReadableError');
  const pending = Promise.withResolvers<Response>();
  const { operation } = setup({ match: () => pending.promise });
  const matching = operation.cache.match(url).catch((error: unknown) => error);
  const closing = operation.close();
  pending.resolve(new Response(new ReadableStream({ cancel() {
    throw cause;
  } }, { highWaterMark: 0 })));
  await closing;
  expect(await matching).toMatchObject({ name: 'RequiredDownloadedModelResourceError', failure: 'io', url, cause });
  expect(operation.assertHealthy).toThrow(RequiredDownloadedModelResourceError);
});

it('retains a canonical required miss even when the consumer catches it', async () => {
  const { operation, fetch } = setup({ match: async () => undefined });
  await operation.cache.match(requiredUrl).catch(() => undefined);
  expect(operation.assertHealthy).toThrow(RequiredDownloadedModelResourceError);
  expect(operation.assertHealthy).toThrow(requiredUrl);
  expect(fetch).not.toHaveBeenCalled();
  await operation.close();
});

it('retains the first required I/O cause even after a later miss', async () => {
  const cause = new DOMException('Permission denied', 'NotAllowedError');
  const match = vi.fn().mockRejectedValueOnce(cause).mockResolvedValue(undefined);
  const { operation } = setup({ match });
  const first = await operation.cache.match(requiredUrl).catch((error: unknown) => error);
  expect(first).toMatchObject({ name: 'RequiredDownloadedModelResourceError', failure: 'io', cause });
  await expect(operation.cache.match(requiredUrl)).rejects.toBe(first);
  expect(() => operation.assertHealthy()).toThrow(first as Error);
  await operation.close();
});

it('allows the preceding local namespace miss before an exact required hit', async () => {
  const { operation } = setup({ match: async request => request === requiredUrl ? new Response('core') : undefined });
  expect(await operation.cache.match(`/models/${modelId}/${requiredPath}`)).toBeUndefined();
  const response = await operation.cache.match(requiredUrl);
  expect(await response!.text()).toBe('core');
  expect(operation.assertHealthy).not.toThrow();
  await operation.close();
});

it('propagates local-probe I/O without classifying it as an exact required failure', async () => {
  const cause = new DOMException('Local namespace is inaccessible', 'NotReadableError');
  const { operation } = setup({ match: async request => {
    if (request !== requiredUrl) throw cause;
    return new Response('core');
  } });
  await expect(operation.cache.match(`/models/${modelId}/${requiredPath}`)).rejects.toBe(cause);
  const response = await operation.cache.match(requiredUrl);
  expect(await response!.text()).toBe('core');
  expect(operation.assertHealthy).not.toThrow();
  await operation.close();
});

it('does not mark optional generation metadata or unselected vision misses as required', async () => {
  const { operation, fetch } = setup({ match: async () => undefined });
  expect(await operation.cache.match(`https://huggingface.co/${modelId}/resolve/${revision}/generation_config.json`)).toBeUndefined();
  expect(await operation.cache.match(`https://huggingface.co/${modelId}/resolve/${revision}/onnx/vision_encoder_q4f16.onnx`)).toBeUndefined();
  await operation.fetch(`/models/${modelId}/generation_config.json`).catch(() => undefined);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(operation.assertHealthy).not.toThrow();
  await operation.close();
});

it('does not confuse another revision with the required exact identity', async () => {
  const { operation } = setup({ match: async () => undefined });
  expect(await operation.cache.match(`https://huggingface.co/${modelId}/resolve/main/${requiredPath}`)).toBeUndefined();
  expect(operation.assertHealthy).not.toThrow();
  await operation.close();
});

it('records canonical required fetch rejection without calling its transport', async () => {
  const { operation, fetch } = setup({ match: async () => undefined });
  await operation.fetch(requiredUrl).catch(() => undefined);
  expect(operation.assertHealthy).toThrow(RequiredDownloadedModelResourceError);
  expect(fetch).not.toHaveBeenCalled();
  await operation.close();
});

it('does not prefetch a model body when returning or cancelling a metadata-only cache hit', async () => {
  const pull = vi.fn();
  const cancel = vi.fn();
  const { operation } = setup({ match: async () => new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 })) });
  const response = await operation.cache.match(requiredUrl);
  await Promise.resolve();
  expect(pull).not.toHaveBeenCalled();
  await response!.body!.cancel();
  expect(pull).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledTimes(1);
  await operation.close();
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('permits metadata-only inspection and cancellation of an unplanned ONNX cache hit', async () => {
  const url = `https://huggingface.co/${modelId}/resolve/${revision}/onnx/vision_encoder_q4f16.onnx`;
  const pull = vi.fn();
  const cancel = vi.fn();
  const { operation, fetch } = setup({ match: async () => new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
    headers: { 'Content-Length': '3' },
  }) });
  try {
    const response = await operation.cache.match(url);
    expect(response?.headers.get('Content-Length')).toBe('3');
    expect(operation.assertHealthy).not.toThrow();
    await response?.body?.cancel();
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(operation.assertHealthy).not.toThrow();
  } finally {
    await operation.close();
  }
});

it('rejects an unplanned model body before reading bytes and retains its terminal failure', async () => {
  const url = `https://huggingface.co/${modelId}/resolve/${revision}/onnx/model_q4f16.onnx_data`;
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    controller.enqueue(new Uint8Array([1, 2, 3])); controller.close();
  });
  const { operation, fetch } = setup({ match: async () => new Response(new ReadableStream({ pull }, { highWaterMark: 0 })) });
  try {
    const response = await operation.cache.match(url);
    if (response === undefined) throw new Error('Synthetic unplanned cache hit was lost');
    const outcome = await response.arrayBuffer().then(
      bytes => ({ status: 'read' as const, bytes: bytes.byteLength }),
      (error: unknown) => ({ status: 'failed' as const, error }),
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(pull, JSON.stringify({ outcome })).not.toHaveBeenCalled();
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed' || !(outcome.error instanceof Error)) throw new Error('Unplanned body consumption must fail with a typed Error');
    expect(classifyProductionAcceptanceError({ error: outcome.error })).toBe('terminal');
    expect(outcome.error.message).toContain(url);
    expect(operation.assertHealthy).toThrow(outcome.error);
  } finally {
    await operation.close();
  }
});

it('keeps query and fragment out of the required resource identity', async () => {
  const { operation } = setup({ match: async () => new Response('core') });
  try {
    const response = await operation.cache.match(`${requiredUrl}?download=true#fragment`);
    expect(await response!.text()).toBe('core');
    expect(operation.assertHealthy).not.toThrow();
  } finally {
    await operation.close();
  }
});

it('does not read a later planned body after an unplanned body has poisoned the operation', async () => {
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    controller.enqueue(new Uint8Array([1])); controller.close();
  });
  const { operation } = setup({ match: async () => new Response(new ReadableStream({ pull }, { highWaterMark: 0 })) });
  try {
    const unplanned = await operation.cache.match(`${requiredUrl}_data`);
    const first = await unplanned!.arrayBuffer().catch((error: unknown) => error);
    expect(first).toMatchObject({ name: 'RequiredDownloadedModelResourceError', failure: 'unplanned' });
    const planned = await operation.cache.match(requiredUrl);
    await expect(planned!.arrayBuffer()).rejects.toBe(first);
    expect(pull).not.toHaveBeenCalled();
  } finally {
    await operation.close();
  }
});

it('does not turn a relative local model body hit into an HF required resource', async () => {
  const pull = vi.fn();
  const { operation } = setup({ match: async () => new Response(new ReadableStream({ pull }, { highWaterMark: 0 })) });
  try {
    const response = await operation.cache.match(`/models/${modelId}/${requiredPath}`);
    await expect(response!.arrayBuffer()).rejects.toMatchObject({ name: 'RequiredDownloadedModelResourceError', failure: 'unplanned' });
    expect(pull).not.toHaveBeenCalled();
    expect(operation.assertHealthy).toThrow(RequiredDownloadedModelResourceError);
  } finally {
    await operation.close();
  }
});

it('detects an encoded ONNX external suffix without aliasing its cache key', async () => {
  const pull = vi.fn();
  const { operation } = setup({ match: async () => new Response(new ReadableStream({ pull }, { highWaterMark: 0 })) });
  try {
    const response = await operation.cache.match(`${requiredUrl}%5fdata?download=true`);
    await expect(response!.arrayBuffer()).rejects.toMatchObject({ name: 'RequiredDownloadedModelResourceError', failure: 'unplanned', url: `${requiredUrl}%5fdata` });
    expect(pull).not.toHaveBeenCalled();
  } finally {
    await operation.close();
  }
});

it('refuses a cached model body at another revision even when its filename is planned', async () => {
  const pull = vi.fn();
  const { operation } = setup({ match: async () => new Response(new ReadableStream({ pull }, { highWaterMark: 0 })) });
  try {
    const response = await operation.cache.match(`https://huggingface.co/${modelId}/resolve/main/${requiredPath}`);
    await expect(response!.arrayBuffer()).rejects.toMatchObject({ name: 'RequiredDownloadedModelResourceError', failure: 'unplanned' });
    expect(pull).not.toHaveBeenCalled();
  } finally {
    await operation.close();
  }
});

it('does not turn readable optional JSON metadata into an unplanned model failure', async () => {
  const { operation } = setup({ match: async () => new Response('{"eos_token_id":2}') });
  try {
    const response = await operation.cache.match(`https://huggingface.co/${modelId}/resolve/${revision}/generation_config.json`);
    expect(await response!.json()).toEqual({ eos_token_id: 2 });
    expect(operation.assertHealthy).not.toThrow();
  } finally {
    await operation.close();
  }
});

it('permits a required user model body through its same-origin relative resource URL', async () => {
  const operation = createRequiredDownloadedResourceOperation({
    modelId: 'user/synthetic', revision: undefined, requiredPaths: [requiredPath], workerLocationUrl: 'http://localhost/worker.js',
    modelCache: { match: async () => new Response('local core'), put: vi.fn() },
    cacheOnlyFetch: vi.fn(async () => {
      throw new Error('Unexpected user-model fetch');
    }),
  });
  try {
    const response = await operation.cache.match(`/user/synthetic/${requiredPath}`);
    expect(await response!.text()).toBe('local core');
    expect(operation.assertHealthy).not.toThrow();
  } finally {
    await operation.close();
  }
});

it('retains a body read I/O failure even if the runtime swallows its rejection', async () => {
  const cause = new DOMException('File disappeared during reading', 'NotReadableError');
  const { operation } = setup({ match: async () => new Response(new ReadableStream({
    pull(controller) {
      controller.error(cause);
    },
  }, { highWaterMark: 0 })) });
  const response = await operation.cache.match(requiredUrl);
  await response!.arrayBuffer().catch(() => undefined);
  expect(operation.assertHealthy).toThrow(RequiredDownloadedModelResourceError);
  await operation.close();
  try {
    operation.assertHealthy();
    throw new Error('Expected sticky read failure');
  } catch (error) {
    expect(error).toMatchObject({ failure: 'io', cause });
  }
});

it('records required cancellation I/O discovered only during final cleanup', async () => {
  const cause = new Error('Cancel failed');
  const { operation } = setup({ match: async () => new Response(new ReadableStream({
    cancel() {
      throw cause;
    },
  }, { highWaterMark: 0 })) });
  await operation.cache.match(requiredUrl);
  expect(operation.assertHealthy).not.toThrow();
  await operation.close();
  expect(operation.assertHealthy).toThrow(RequiredDownloadedModelResourceError);
});

it('closes old response readers and rejects later cache calls without reading more bytes', async () => {
  const pull = vi.fn(controller => controller.enqueue(new Uint8Array([1])));
  const cancel = vi.fn();
  const { operation } = setup({ match: async () => new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 })) });
  const response = await operation.cache.match(requiredUrl);
  await operation.close();
  await expect(response!.arrayBuffer()).rejects.toThrow('closed');
  await expect(operation.cache.match(requiredUrl)).rejects.toThrow('closed');
  expect(pull).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('waits for and cancels a response arriving during operation closure', async () => {
  const pending = Promise.withResolvers<Response>();
  const cancel = vi.fn();
  const { operation } = setup({ match: () => pending.promise });
  const matching = operation.cache.match(requiredUrl).catch((error: unknown) => error);
  const closing = operation.close();
  pending.resolve(new Response(new ReadableStream({ cancel }, { highWaterMark: 0 })));
  await closing;
  expect(await matching).toBeInstanceOf(Error);
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('fails cleanup on a stuck cache lookup and cancels its later response after the deadline', async () => {
  vi.useFakeTimers();
  const pending = Promise.withResolvers<Response>();
  const cancel = vi.fn();
  const { operation } = setup({ match: () => pending.promise });
  const matching = operation.cache.match(requiredUrl).catch((error: unknown) => error);
  const closed = operation.close().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(REQUIRED_DOWNLOADED_RESOURCE_CLEANUP_TIMEOUT_MS);
  expect(await closed).toBeInstanceOf(RequiredDownloadedResourceCleanupError);
  expect(operation.assertHealthy).toThrow(RequiredDownloadedResourceCleanupError);
  pending.resolve(new Response(new ReadableStream({ cancel }, { highWaterMark: 0 })));
  expect(await matching).toBeInstanceOf(Error);
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('fails cleanup rather than certifying success when source cancellation never settles', async () => {
  vi.useFakeTimers();
  const cancellation = Promise.withResolvers<void>();
  const { operation } = setup({ match: async () => new Response(new ReadableStream({
    cancel: () => cancellation.promise,
  }, { highWaterMark: 0 })) });
  await operation.cache.match(requiredUrl);
  const closed = operation.close().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(REQUIRED_DOWNLOADED_RESOURCE_CLEANUP_TIMEOUT_MS);
  expect(await closed).toBeInstanceOf(RequiredDownloadedResourceCleanupError);
  cancellation.resolve();
});

it('bounds rejected-model disposal and preserves the original resource failure as its cause', async () => {
  vi.useFakeTimers();
  const disposal = Promise.withResolvers<void>();
  const cause = new RequiredDownloadedModelResourceError({ url: requiredUrl, failure: 'missing', cause: undefined });
  const result = disposeRejectedDownloadedRuntime({ dispose: () => disposal.promise, cause }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(REQUIRED_DOWNLOADED_RESOURCE_CLEANUP_TIMEOUT_MS);
  expect(await result).toMatchObject({ name: 'RequiredDownloadedResourceCleanupError', cause });
  disposal.resolve();
});

it('does not wait for rejected-model disposal after resource cleanup already timed out', async () => {
  const disposal = Promise.withResolvers<void>();
  const dispose = vi.fn(() => disposal.promise);
  const cause = new RequiredDownloadedResourceCleanupError({ cause: undefined });
  await disposeRejectedDownloadedRuntime({ dispose, cause });
  expect(dispose).toHaveBeenCalledTimes(1);
  disposal.resolve();
});

it('does not replace the original failure when rejected-model disposal throws', async () => {
  const cause = new RequiredDownloadedModelResourceError({ url: requiredUrl, failure: 'missing', cause: undefined });
  await expect(disposeRejectedDownloadedRuntime({
    dispose: async () => {
      throw new Error('Secondary disposal failure');
    }, cause,
  })).resolves.toBeUndefined();
});
