// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareSession } from './session';
import { prepareVisionMeasurement } from './vision-admission';
import { resolvedModelFixture } from './test-utils/resolved-model.test-support';
import type { WorkerPrepareInput } from './types';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';

vi.mock('./session', () => ({ prepareSession: vi.fn() }));

beforeEach(() => {
  vi.mocked(prepareSession).mockReset();
});

function request({ projector }: { projector: 'present' | 'absent' }): WorkerPrepareInput {
  const resolvedModel = resolvedModelFixture({ modelId: 'user/fixture' });
  if (projector === 'present') {
    resolvedModel.directory.projectorFile = resolvedModel.directory.primaryFile;
  }
  return { modelId: resolvedModel.modelId, resolvedModel, options: { profile: 'cpu-wasm32' }, debug: 'off' };
}

describe('native vision admission before sending image bytes', () => {
  it('skips a missing projector before model/native loading', async () => {
    const result = await prepareVisionMeasurement({ request: request({ projector: 'absent' }), signal: new AbortController().signal, onProgress: () => {}, now: () => 0 });
    expect(result).toMatchObject({ status: 'skipped', reason: 'missing-projector' });
    expect(prepareSession).not.toHaveBeenCalled();
  });

  it.each([0, 1, undefined] as const)('uses the loaded native capability, recording unknown explicitly: %s', async supported => {
    const query = vi.fn(async () => supported);
    vi.mocked(prepareSession).mockResolvedValue({ core: { api: supported === undefined ? {} : { mtmd_support_vision: query } }, projector: 7n } as unknown as Awaited<ReturnType<typeof prepareSession>>);
    const result = await prepareVisionMeasurement({ request: request({ projector: 'present' }), signal: new AbortController().signal, onProgress: () => {}, now: () => 0 });
    if (supported === 0) {
      expect(result).toMatchObject({ status: 'skipped', reason: 'native-no-vision' });
    } else {
      expect(result).toMatchObject({ status: 'ready', capability: supported === 1 ? 'native-vision' : 'unknown-attempted-native' });
    }
    expect(query).toHaveBeenCalledTimes(supported === undefined ? 0 : 1);
    if (supported !== undefined) {
      expect(query).toHaveBeenCalledWith(7n);
    }
  });

  it('keeps initialization/OOM failures as failures instead of claiming an unsupported model', async () => {
    vi.mocked(prepareSession).mockRejectedValue(new LlamaCppBrowserError({ code: 'runtime-error' }));
    const result = await prepareVisionMeasurement({ request: request({ projector: 'present' }), signal: new AbortController().signal, onProgress: () => {}, now: () => 0 });
    expect(result).toMatchObject({ status: 'failed', error: 'runtime-error', diagnostic: { outcome: 'failed' } });
  });

  it('rejects cancellation after pending native capability settles without proceeding to image evaluation', async () => {
    const pending = Promise.withResolvers<number>(), control = new AbortController();
    vi.mocked(prepareSession).mockResolvedValue({ core: { api: { mtmd_support_vision: () => pending.promise } }, projector: 7n } as unknown as Awaited<ReturnType<typeof prepareSession>>);
    const result = prepareVisionMeasurement({ request: request({ projector: 'present' }), signal: control.signal, onProgress: () => {}, now: () => 0 });
    await vi.waitFor(() => expect(prepareSession).toHaveBeenCalledOnce());
    control.abort();
    pending.resolve(1);
    expect(await result).toMatchObject({ status: 'failed', error: 'aborted', diagnostic: { outcome: 'aborted' } });
  });
});

it('preserves the original native decision when observation schema validation fails', async () => {
  const input = request({ projector: 'present' });
  const file = input.resolvedModel.directory.primaryFile;
  file.file = new File(['model'], 'model.gguf', { lastModified: -1 });
  vi.mocked(prepareSession).mockRejectedValue(new LlamaCppBrowserError({ code: 'runtime-error' }));
  const result = await prepareVisionMeasurement({ request: input, signal: new AbortController().signal, onProgress: () => {}, now: () => 0 });
  expect(result).toMatchObject({ status: 'failed', error: 'runtime-error', diagnostic: { captureStatus: 'unavailable', outcome: 'failed' } });
});
