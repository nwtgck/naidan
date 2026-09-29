import { describe, expect, it } from 'vitest';
import { compareModelArtifactRequestPaths } from '@/features/transformers-js/download-verification/logic/compare-model-artifact-request-paths';
import type { DownloadVerificationModelArtifactRequestObservation } from '@/features/transformers-js/download-verification/types';

function observation({ paths }: { paths: string[] }): DownloadVerificationModelArtifactRequestObservation {
  return {
    modelId: 'org/model',
    revision: '0123456789abcdef0123456789abcdef01234567',
    autoClass: 'AutoModelForCausalLM',
    candidate: { device: 'webgpu', dtype: 'q4f16' },
    status: 'observed',
    observationMethod: 'held-model-artifact-fetch-quiescence',
    quiescenceMs: 500,
    timeoutMs: 10_000,
    paths,
    requests: paths.map(path => ({
      path,
      url: `https://huggingface.co/org/model/resolve/0123456789abcdef0123456789abcdef01234567/${path}`,
    })),
    error: undefined,
  };
}

describe('compareModelArtifactRequestPaths', () => {
  it('normalizes ordering and duplicates before declaring an exact match', () => {
    const result = compareModelArtifactRequestPaths({
      expectedPaths: ['onnx/b.onnx', 'onnx/a.onnx'],
      observation: observation({ paths: ['onnx/a.onnx', 'onnx/b.onnx', 'onnx/a.onnx'] }),
    });

    expect(result).toEqual({
      status: 'match',
      expectedPaths: ['onnx/a.onnx', 'onnx/b.onnx'],
      observedPaths: ['onnx/a.onnx', 'onnx/b.onnx'],
      missingPaths: [],
      unexpectedPaths: [],
    });
  });

  it('reports missing and unexpected paths independently', () => {
    const result = compareModelArtifactRequestPaths({
      expectedPaths: ['onnx/decoder.onnx', 'onnx/embed.onnx'],
      observation: observation({ paths: ['onnx/decoder.onnx', 'onnx/vision.onnx'] }),
    });

    expect(result).toMatchObject({
      status: 'mismatch',
      missingPaths: ['onnx/embed.onnx'],
      unexpectedPaths: ['onnx/vision.onnx'],
    });
  });
  it('does not declare parity when the observer itself failed', () => {
    const failedObservation = observation({ paths: ['onnx/model.onnx'] });
    failedObservation.status = 'failed';
    failedObservation.error = { name: 'Error', message: 'observer failed' };

    const result = compareModelArtifactRequestPaths({
      expectedPaths: ['onnx/model.onnx'],
      observation: failedObservation,
    });

    expect(result).toMatchObject({
      status: 'observation-failed',
      missingPaths: [],
      unexpectedPaths: [],
    });
  });

});
