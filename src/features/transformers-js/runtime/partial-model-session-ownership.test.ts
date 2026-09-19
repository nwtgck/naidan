// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { rawRuntime } from '@/features/transformers-js/replay-models/support/model-runtime-input-helpers';
import { readModelFixture } from '@/features/transformers-js/replay-models/support/model-runtime-fixture';

afterEach(() => vi.unstubAllGlobals());

it('releases fulfilled native session siblings after model construction fails and keeps the next model independently owned', async () => {
  const modelId = 'onnx-community/Qwen3.5-2B-ONNX';
  const archive = readModelFixture({ modelId });
  const bodyPaths = [
    'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data',
    'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data',
    'onnx/vision_encoder_q4f16.onnx', 'onnx/vision_encoder_q4f16.onnx_data',
  ];
  const h = await rawRuntime({ archive, bodyPaths });
  try {
    const completed: number[] = [];
    const releases = [vi.fn(async () => {
      completed.push(1);
    }), vi.fn(async () => {
      completed.push(3);
    })];
    const failure = new Error('Synthetic ORT sibling rejected');
    h.sessions.mockResolvedValueOnce({ inputNames: [], outputNames: [], release: releases[0] })
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ inputNames: [], outputNames: [], release: releases[1] });
    const options = { revision: archive.summary.revision, local_files_only: true as const, device: 'webgpu' as const, dtype: 'q4f16' as const, progress_callback: () => undefined };
    const load = h.runtime.AutoModelForImageTextToText.from_pretrained(modelId, options);
    h.gate.resolve();
    await expect(load).rejects.toBe(failure);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(h.sessions).toHaveBeenCalledTimes(3);
    for (const release of releases) expect(release).toHaveBeenCalledOnce();
    expect(completed.sort()).toEqual([1, 3]);

    const followupReleases = [vi.fn(async () => undefined), vi.fn(async () => undefined), vi.fn(async () => undefined)];
    h.sessions.mockResolvedValueOnce({ inputNames: [], outputNames: [], release: followupReleases[0] })
      .mockResolvedValueOnce({ inputNames: [], outputNames: [], release: followupReleases[1] })
      .mockResolvedValueOnce({ inputNames: [], outputNames: [], release: followupReleases[2] });
    const next = await h.runtime.AutoModelForImageTextToText.from_pretrained(modelId, options);
    for (const release of followupReleases) expect(release).not.toHaveBeenCalled();
    await next.dispose();
    for (const release of followupReleases) expect(release).toHaveBeenCalledOnce();
    for (const release of releases) expect(release).toHaveBeenCalledOnce();
    expect(h.sessions).toHaveBeenCalledTimes(6);
    expect(h.transport).not.toHaveBeenCalled();
    expect(h.mutations).not.toHaveBeenCalled();
    expect(h.unknownRequests).toEqual([]);
    expect([...new Set(h.bodyReads)].sort()).toEqual(bodyPaths);
  } finally {
    h.restoreSessionSpy();
  }
}, 30_000);
