import { selectHostModel } from '@/features/llama-cpp-browser/runtime/host-model-store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { storageService } from '@/00-storage/service';
import { toHostModelDirectoryId } from '@/01-models/ids';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';
import { createModelAvailabilityCache, inspectLocalModel, type ModelAvailability } from './availability';
const calls = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/00-storage/service', () => ({ storageService: { loadHostModelDirectories: vi.fn() } }));
vi.mock('../runtime/host-model-store', () => ({ selectHostModel: vi.fn() }));
vi.mock('../runtime/model-store', () => ({ storedModelDirectory: calls.read }));

beforeEach(() => vi.resetAllMocks());

describe('local-only missing-model inspection', () => {
  it.each(['model.gguf', 'Q4'])('resolves public folder aliases and %s before inspecting the canonical storage identity', async selector => {
    vi.mocked(storageService.loadHostModelDirectories).mockResolvedValue([{ id: toHostModelDirectoryId({ raw: 'root' }), name: 'Models' }]);
    vi.mocked(selectHostModel).mockResolvedValue({ id: 'host/root/owner/repo:model.gguf', name: 'host/root/owner/repo:Q4', modelPath: 'model.gguf', projectorPath: undefined, files: [] });
    calls.read.mockResolvedValue({});
    expect(await inspectLocalModel({ modelId: `host/Models/owner/repo:${selector}` })).toBe('available');
    expect(selectHostModel).toHaveBeenCalledExactlyOnceWith({ name: `host/root/owner/repo:${selector}` });
    expect(calls.read).toHaveBeenCalledExactlyOnceWith({ name: 'host/root/owner/repo:model.gguf' });
  });

  it('does not inspect a different root when a public alias is no longer registered', async () => {
    vi.mocked(storageService.loadHostModelDirectories).mockResolvedValue([]);
    expect(await inspectLocalModel({ modelId: 'host/Models/owner/repo:model.gguf' })).toBe('missing');
    expect(calls.read).not.toHaveBeenCalled();
  });

  it('looks up the resolved model rather than listing all models or launching a Worker', async () => {
    calls.read.mockResolvedValue({});
    expect(await inspectLocalModel({ modelId: 'user/example' })).toBe('available');
    expect(calls.read).toHaveBeenCalledExactlyOnceWith({ name: 'user/example' });
  });

  it.each([new DOMException('no folder', 'NotFoundError'), new LlamaCppBrowserError({ code: 'missing-model' })])('recognizes confirmed absence', async error => {
    calls.read.mockRejectedValue(error);
    expect(await inspectLocalModel({ modelId: 'user/example' })).toBe('missing');
  });

  it.each([new DOMException('denied', 'NotAllowedError'), new DOMException('wrong kind', 'TypeMismatchError'), new LlamaCppBrowserError({ code: 'unavailable' }), new LlamaCppBrowserError({ code: 'invalid-gguf' }), new LlamaCppBrowserError({ code: 'unsupported-input' }), new Error('private storage path')])('does not relabel storage errors as absent model files', async error => {
    calls.read.mockRejectedValue(error);
    expect(await inspectLocalModel({ modelId: 'user/example' })).toBe('unreadable');
  });
});

describe('bounded availability observation cache', () => {
  it('shares an in-flight check between panes and caches only a short observation', async () => {
    const gate = Promise.withResolvers<ModelAvailability>(); const inspect = vi.fn(() => gate.promise); let time = 0;
    const cache = createModelAvailabilityCache({ inspect, now: () => time });
    const first = cache.check({ modelId: 'one' }); const second = cache.check({ modelId: 'one' });
    expect(first).toBe(second); await Promise.resolve(); expect(inspect).toHaveBeenCalledOnce();
    gate.resolve('available'); await first;
    expect(await cache.check({ modelId: 'one' })).toBe('available'); expect(inspect).toHaveBeenCalledOnce();
    time = 5001; await cache.check({ modelId: 'one' }); expect(inspect).toHaveBeenCalledTimes(2);
  });

  it('does not allow an old in-flight observation to undo invalidation', async () => {
    const gate = Promise.withResolvers<ModelAvailability>();
    const inspect = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue('missing');
    const cache = createModelAvailabilityCache({ inspect, now: () => 0 });
    const old = cache.check({ modelId: 'one' }); await Promise.resolve(); cache.invalidate();
    expect(await cache.check({ modelId: 'one' })).toBe('missing');
    gate.resolve('available'); await old;
    expect(await cache.check({ modelId: 'one' })).toBe('missing'); expect(inspect).toHaveBeenCalledTimes(2);
  });

  it('limits retained keys and does not cache storage failures', async () => {
    const inspect = vi.fn().mockResolvedValue('missing'); const cache = createModelAvailabilityCache({ inspect, now: () => 0 });
    for (let i = 0; i < 33; i++) await cache.check({ modelId: String(i) });
    await cache.check({ modelId: '0' }); expect(inspect).toHaveBeenCalledTimes(34);
    inspect.mockRejectedValueOnce(new Error('disk'));
    expect(await cache.check({ modelId: 'bad' })).toBe('unreadable');
    expect(await cache.check({ modelId: 'bad' })).toBe('missing');
  });
});
