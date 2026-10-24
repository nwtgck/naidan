import { resolvedModelFixture } from './test-utils/resolved-model.test-support';
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generate } from './generation';
import { prepareGenerationSession } from './session';
import { createGpuProfileFixture, createMeasurementFixture } from '@/features/llama-cpp-browser/runtime/gpu-profiler.test-support';
import { gpuProfilingProfile } from '@/features/llama-cpp-browser/types';
import type { Diagnostic } from '@/features/llama-cpp-browser/debug-log';
import type { WorkerGenerateInput } from './types';

vi.mock('./session', () => ({ prepareGenerationSession: vi.fn() }));

function request(): WorkerGenerateInput {
  return { modelId: 'user/fixture.gguf', resolvedModel: resolvedModelFixture({ modelId: 'user/fixture.gguf' }), messages: [{ role: 'user', content: 'fixture' }], temperature: 0, topP: 0.95, maxTokens: 5, presencePenalty: 0, frequencyPenalty: 0, stop: [], options: { profile: gpuProfilingProfile }, measurement: { sequence: 'fresh' } };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('generation profiling lifetime', () => {
  it('rejects the profiling binary for ordinary chat before creating a session', async () => {
    const input = request();
    input.measurement = undefined;
    await expect(generate({ request: input, signal: undefined, onEvent() {}, onProgress() {} })).rejects.toThrow('unavailable');
    expect(prepareGenerationSession).not.toHaveBeenCalled();
  });

  it('captures initialization failure observations and closes ownership before the next request', async () => {
    using gpu = createGpuProfileFixture();
    const failure = new Error('initialization fixture');
    vi.mocked(prepareGenerationSession).mockImplementation(async () => {
      const querySet = gpu.query();
      gpu.pass({ querySet }).end();
      gpu.read({ querySet });
      throw failure;
    });
    const reports: Diagnostic[] = [];
    await expect(generate({
      request: request(),
      signal: undefined,
      onEvent() {},
      onProgress() {},
      onSummary({ diagnostic }) {
        reports.push(diagnostic);
      },
    })).rejects.toBe(failure);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.performance!.gpuProfile).toMatchObject({ status: 'complete', measuredPasses: 1, totalGpuMs: 2 });
    expect(reports[0]!.performance!.gpuProfile!.rows[0]!.phase).toBe('other');
    using following = createMeasurementFixture();
    const next = following.finish();
    expect(next).toMatchObject({ status: 'unavailable', observedPasses: 0, instrumentationErrors: 0 });
    expect(reports[0]!.performance!.gpuProfile!.measuredPasses).toBe(1);
  });

  it('does not open profiling ownership for standard measured generation', async () => {
    using gpu = createGpuProfileFixture();
    using sentinel = createMeasurementFixture();
    const failure = new Error('standard fixture');
    vi.mocked(prepareGenerationSession).mockImplementation(async () => {
      const querySet = gpu.query();
      gpu.pass({ querySet }).end();
      gpu.read({ querySet });
      throw failure;
    });
    const input = request();
    input.options.profile = 'webgpu-wasm64-jspi';
    const reports: Diagnostic[] = [];
    await expect(generate({
      request: input,
      signal: undefined,
      onEvent() {},
      onProgress() {},
      onSummary({ diagnostic }) {
        reports.push(diagnostic);
      },
    })).rejects.toBe(failure);
    expect(reports[0]!.performance!.gpuProfile).toBeUndefined();
    expect(sentinel.finish()).toMatchObject({ status: 'complete', instrumentationErrors: 0, measuredPasses: 1 });
  });
});
