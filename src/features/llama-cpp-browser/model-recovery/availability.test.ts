import { Blob as NodeBlob } from 'node:buffer';
import { temporaryModels } from '@/features/llama-cpp-browser/runtime/temporary-model-store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';
import { createModelAvailabilityCache, inspectLocalModel, type ModelAvailability } from './availability';
const calls = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('../runtime/model-resolution', () => ({ resolveModel: (args: unknown) => calls.resolve(args) }));

beforeEach(() => vi.resetAllMocks());

describe('local-only missing-model inspection', () => {
  it('resolves the public HF modelId without substituting an exact file locator', async () => {
    const modelId = 'hf.co/owner/Model-GGUF:Q4';
    calls.resolve.mockResolvedValue({});
    expect(await inspectLocalModel({ modelId })).toBe('available');
    expect(calls.resolve).toHaveBeenCalledExactlyOnceWith({ modelId, signal: undefined });
  });

  it.each(['Q4', 'Q%20A'])('resolves a current host folder alias and literal public variant %s', async variant => {
    const modelId = `host/MyModels1/owner/repo:${variant}`;
    calls.resolve.mockResolvedValue({});
    expect(await inspectLocalModel({ modelId })).toBe('available');
    expect(calls.resolve).toHaveBeenCalledExactlyOnceWith({ modelId, signal: undefined });
  });

  it('reports a removed public root alias as missing', async () => {
    calls.resolve.mockRejectedValue(new LlamaCppBrowserError({ code: 'missing-model' }));
    expect(await inspectLocalModel({ modelId: 'host/MyModels1/owner/repo:Q4' })).toBe('missing');
  });

  it('looks up the resolved model rather than listing all models or launching a Worker', async () => {
    calls.resolve.mockResolvedValue({});
    expect(await inspectLocalModel({ modelId: 'user/example' })).toBe('available');
    expect(calls.resolve).toHaveBeenCalledExactlyOnceWith({ modelId: 'user/example', signal: undefined });
  });

  it.each([new DOMException('no folder', 'NotFoundError'), new LlamaCppBrowserError({ code: 'missing-model' })])('recognizes confirmed absence', async error => {
    calls.resolve.mockRejectedValue(error);
    expect(await inspectLocalModel({ modelId: 'user/example' })).toBe('missing');
  });

  it.each([new DOMException('denied', 'NotAllowedError'), new DOMException('wrong kind', 'TypeMismatchError'), new LlamaCppBrowserError({ code: 'unavailable' }), new LlamaCppBrowserError({ code: 'invalid-gguf' }), new LlamaCppBrowserError({ code: 'unsupported-input' }), new Error('private storage path')])('does not relabel storage errors as absent model files', async error => {
    calls.resolve.mockRejectedValue(error);
    expect(await inspectLocalModel({ modelId: 'user/example' })).toBe('unreadable');
  });
});

describe('bounded availability observation cache', () => {
  it('shares an in-flight check between panes and caches only a short observation', async () => {
    const gate = Promise.withResolvers<ModelAvailability>();
    const inspect = vi.fn(() => gate.promise);
    let time = 0;
    const cache = createModelAvailabilityCache({ inspect, now: () => time });
    const first = cache.check({ modelId: 'one' });
    const second = cache.check({ modelId: 'one' });
    expect(first).toBe(second);
    await Promise.resolve();
    expect(inspect).toHaveBeenCalledOnce();
    gate.resolve('available');
    await first;
    expect(await cache.check({ modelId: 'one' })).toBe('available');
    expect(inspect).toHaveBeenCalledOnce();
    time = 5001;
    await cache.check({ modelId: 'one' });
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it('does not allow an old in-flight observation to undo invalidation', async () => {
    const gate = Promise.withResolvers<ModelAvailability>();
    const inspect = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue('missing');
    const cache = createModelAvailabilityCache({ inspect, now: () => 0 });
    const old = cache.check({ modelId: 'one' });
    await Promise.resolve();
    cache.invalidate();
    expect(await cache.check({ modelId: 'one' })).toBe('missing');
    gate.resolve('available');
    await old;
    expect(await cache.check({ modelId: 'one' })).toBe('missing');
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it('limits retained keys and does not cache storage failures', async () => {
    const inspect = vi.fn().mockResolvedValue('missing');
    const cache = createModelAvailabilityCache({ inspect, now: () => 0 });
    for (let i = 0; i < 33; i++) {
      await cache.check({ modelId: String(i) });
    }
    await cache.check({ modelId: '0' });
    expect(inspect).toHaveBeenCalledTimes(34);
    inspect.mockRejectedValueOnce(new Error('disk'));
    expect(await cache.check({ modelId: 'bad' })).toBe('unreadable');
    expect(await cache.check({ modelId: 'bad' })).toBe('missing');
  });
});

it('finds page-local temporary models without any storage lookup and reports them missing after unregister', async () => {
  const bytes = new Uint8Array(32);
  bytes.set([71, 71, 85, 70, 3, 0, 0, 0]);
  const file = new File([bytes], 'model.gguf');
  Object.defineProperty(file, 'slice', { value: (start: number, end: number) => new NodeBlob([bytes.slice(start, end)]) });
  const [model] = await temporaryModels.registerDirectory({ directory: { rootName: 'available', files: [{ relativePath: 'model.gguf', file }] }, signal: undefined });
  using _registration = { [Symbol.dispose]: () => temporaryModels.removeModel({ modelId: model!.modelId }) };
  const actual = await vi.importActual<typeof import('@/features/llama-cpp-browser/runtime/model-resolution')>('../runtime/model-resolution');
  calls.resolve.mockImplementation(actual.resolveModel);
  expect(await inspectLocalModel({ modelId: model!.modelId })).toBe('available');
  temporaryModels.removeModel({ modelId: model!.modelId });
  expect(await inspectLocalModel({ modelId: model!.modelId })).toBe('missing');
});
