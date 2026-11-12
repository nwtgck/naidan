import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvedModelFixture } from '@/features/llama-cpp-browser/worker/test-utils/resolved-model.test-support';
import type { WorkerPrepareInput, WorkerGenerateInput } from '@/features/llama-cpp-browser/worker/types';
import { prepare, generateWithRegisteredGraph } from './worker-router';
const calls = vi.hoisted(() => ({ prepare: vi.fn(), releaseGraph: vi.fn(), releaseRuntime: vi.fn(), generate: vi.fn() }));
vi.mock('./session', () => ({ prepareRegisteredGraph: calls.prepare, releaseRegisteredGraph: calls.releaseGraph }));
vi.mock('./generation', () => ({ generateWithRegisteredGraph: calls.generate }));
vi.mock('@/features/llama-cpp-browser/worker/session', () => ({ releaseSession: calls.releaseRuntime }));

beforeEach(() => {
  for (const call of Object.values(calls)) {
    call.mockReset();
  }
});

const request: WorkerPrepareInput = { modelId: 'user/fixture', resolvedModel: resolvedModelFixture({ modelId: 'user/fixture' }), options: { profile: 'cpu-wasm32' } };

describe('registered graph runtime retirement', () => {
  it.each(['trap', 'cleanup'] as const)('retires the shared module on %s while preserving the preparation error', async kind => {
    const original = kind === 'trap' ? new WebAssembly.RuntimeError('primary trap') : new Error('primary failure');
    calls.prepare.mockRejectedValueOnce(original);
    if (kind === 'cleanup') {
      calls.releaseGraph.mockRejectedValueOnce(new Error('cleanup failed'));
    }
    calls.releaseRuntime.mockRejectedValueOnce(new Error('runtime cleanup failed'));
    await expect(prepare({ request, signal: undefined, onProgress() {}, purpose: 'text' })).rejects.toBe(original);
    expect(calls.releaseGraph).toHaveBeenCalledOnce();
    expect(calls.releaseRuntime).toHaveBeenCalledWith({ releaseRuntime: true });
  });

  it('retires a module trapped during generation without a native fallback', async () => {
    const original = new WebAssembly.RuntimeError('generation trap');
    calls.generate.mockRejectedValueOnce(original);
    const native = vi.fn(async () => ({ content: '', reasoningContent: '', toolCalls: [], finishReason: 'stop' as const }));
    const input: WorkerGenerateInput = { ...request, messages: [{ role: 'user', content: 'hello' }], temperature: 0, topP: 1, presencePenalty: 0, frequencyPenalty: 0, stop: [] };
    await expect(generateWithRegisteredGraph({ request: input, signal: undefined, onEvent() {}, onProgress() {}, onSummary: undefined, native })).rejects.toBe(original);
    expect(calls.releaseRuntime).toHaveBeenCalledWith({ releaseRuntime: true });
    expect(native).not.toHaveBeenCalled();
  });

  it('does not discard an otherwise healthy runtime for ordinary validation errors', async () => {
    const original = new Error('invalid declaration');
    calls.prepare.mockRejectedValueOnce(original);
    await expect(prepare({ request, signal: undefined, onProgress() {}, purpose: 'text' })).rejects.toBe(original);
    expect(calls.releaseGraph).toHaveBeenCalledOnce();
    expect(calls.releaseRuntime).not.toHaveBeenCalled();
  });
});

export const TEST_ONLY = {
};
