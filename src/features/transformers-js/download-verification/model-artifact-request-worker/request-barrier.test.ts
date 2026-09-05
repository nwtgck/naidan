import { describe, expect, it, vi } from 'vitest';
import {
  createModelArtifactRequestBarrier,
  huggingFaceResolveArtifactPath,
  huggingFaceResolveArtifactRequest,
} from '@/features/transformers-js/download-verification/model-artifact-request-worker/request-barrier';

describe('model artifact request barrier', () => {
  it('extracts only the repository-relative path from a Hugging Face resolve URL', () => {
    expect(huggingFaceResolveArtifactPath({
      url: 'https://huggingface.co/org/model/resolve/0123456789abcdef/onnx/model_q4.onnx_data?download=true',
    })).toBe('onnx/model_q4.onnx_data');
    expect(huggingFaceResolveArtifactPath({ url: 'https://example.com/model.onnx' })).toBeUndefined();
    expect(huggingFaceResolveArtifactRequest({
      url: 'https://huggingface.co/org/model/resolve/0123456789abcdef/onnx/model_q4.onnx_data?download=true#fragment',
    })).toEqual({
      path: 'onnx/model_q4.onnx_data',
      url: 'https://huggingface.co/org/model/resolve/0123456789abcdef/onnx/model_q4.onnx_data',
    });
  });

  it('waits until observed requests have been quiet and then rejects pending fetches on stop', async () => {
    vi.useFakeTimers();
    try {
      const barrier = createModelArtifactRequestBarrier({ quiescenceMs: 50 });
      const first = barrier.observe({ request: {
        path: 'onnx/decoder_q4.onnx',
        url: 'https://huggingface.co/org/model/resolve/revision/onnx/decoder_q4.onnx',
      } });
      const quiescence = barrier.waitForQuiescence();
      await vi.advanceTimersByTimeAsync(30);
      const second = barrier.observe({ request: {
        path: 'onnx/decoder_q4.onnx_data',
        url: 'https://huggingface.co/org/model/resolve/revision/onnx/decoder_q4.onnx_data',
      } });
      await vi.advanceTimersByTimeAsync(49);
      let settled = false;
      void quiescence.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(quiescence).resolves.toEqual([
        {
          path: 'onnx/decoder_q4.onnx',
          url: 'https://huggingface.co/org/model/resolve/revision/onnx/decoder_q4.onnx',
        },
        {
          path: 'onnx/decoder_q4.onnx_data',
          url: 'https://huggingface.co/org/model/resolve/revision/onnx/decoder_q4.onnx_data',
        },
      ]);

      const reason = new Error('observation complete');
      barrier.stop({ reason });
      await expect(first).rejects.toBe(reason);
      await expect(second).rejects.toBe(reason);
      barrier.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
