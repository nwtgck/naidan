import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { historicalRepositoryPaths, historicalObservationPaths } from './model-historical-evidence-paths';
import { compareModelArtifactRequestPaths } from '@/features/transformers-js/download-verification/logic/compare-model-artifact-request-paths';
import type { DownloadVerificationModelArtifactRequestObservation } from '@/features/transformers-js/download-verification/types';

interface RepositoryFixture {
  modelId: string;
  resolvedRevision: string;
  files: Array<{ path: string }>;
}

interface ProductionObservationFixture {
  modelId: string;
  resolvedRevision: string;
  candidate: {
    device: 'webgpu' | 'wasm';
    dtype: 'q4f16' | 'q4';
  };
  autoClass: DownloadVerificationModelArtifactRequestObservation['autoClass'];
  sessionNames: string[];
}

function readFixtureFiles<T>({ files }: { files: Record<string, string> }): Record<string, T> {
  return Object.fromEntries(
    Object.entries(files)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, file]) => [
        name,
        JSON.parse(readFileSync(file, 'utf8')) as T,
      ]),
  );
}

function escapeRegularExpression({ value }: { value: string }): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function historicalExpectedArtifactPaths({ repository, observation }: {
  repository: RepositoryFixture;
  observation: ProductionObservationFixture;
}): string[] {
  const repositoryPaths = repository.files.map(file => file.path);
  const expectedPaths: string[] = [];

  for (const sessionName of observation.sessionNames) {
    const corePath = `onnx/${sessionName}_${observation.candidate.dtype}.onnx`;
    expect(repositoryPaths, `${observation.modelId}: missing historical core path for ${sessionName}`).toContain(corePath);
    expectedPaths.push(corePath);

    const externalDataPattern = new RegExp(`^${escapeRegularExpression({ value: corePath })}_data(?:_\\d+)?$`, 'u');
    expectedPaths.push(...repositoryPaths.filter(path => externalDataPattern.test(path)));
  }

  return [...new Set(expectedPaths)].sort((left, right) => left.localeCompare(right));
}

function historicalObservationAsArtifactObservation({ fixture, paths }: {
  fixture: ProductionObservationFixture;
  paths: string[];
}): DownloadVerificationModelArtifactRequestObservation {
  return {
    modelId: fixture.modelId,
    revision: fixture.resolvedRevision,
    autoClass: fixture.autoClass,
    candidate: fixture.candidate,
    status: 'observed',
    observationMethod: 'held-model-artifact-fetch-quiescence',
    quiescenceMs: 500,
    timeoutMs: 10_000,
    paths,
    requests: paths.map(path => ({
      path,
      url: `https://huggingface.co/${fixture.modelId}/resolve/${fixture.resolvedRevision}/${path}`,
    })),
    error: undefined,
  };
}

const repositories = readFixtureFiles<RepositoryFixture>({
  files: historicalRepositoryPaths,
});
const productionObservations = readFixtureFiles<ProductionObservationFixture>({
  files: historicalObservationPaths,
});

describe('historical Production model artifact parity fixtures', () => {
  it('derives a non-empty q4f16 artifact expectation for the five historical successful sessions', () => {
    expect(Object.keys(productionObservations)).toEqual([
      'gemma-4-e2b-it',
      'gpt-oss-20b',
      'lfm2-5-2-6b',
      'qwen3-5-2b',
      'smollm2-135m-instruct',
    ]);
    expect(repositories['lfm2-5-230m']).toBeDefined();
    expect(productionObservations['lfm2-5-230m']).toBeUndefined();

    for (const [name, fixture] of Object.entries(productionObservations)) {
      const repository = repositories[name];
      expect(repository).toBeDefined();
      expect(repository?.modelId).toBe(fixture.modelId);
      expect(repository?.resolvedRevision).toBe(fixture.resolvedRevision);
      expect(fixture.candidate).toEqual({ device: 'webgpu', dtype: 'q4f16' });

      const expectedPaths = historicalExpectedArtifactPaths({ repository: repository!, observation: fixture });
      expect(expectedPaths.length).toBeGreaterThan(0);
      expect(expectedPaths.every(path => path.includes('_q4f16.onnx'))).toBe(true);
    }
  });

  it('keeps the Qwen3.5 historical CausalLM expectation free of vision encoder artifacts', () => {
    const repository = repositories['qwen3-5-2b'];
    const fixture = productionObservations['qwen3-5-2b'];
    expect(repository).toBeDefined();
    expect(fixture).toBeDefined();

    const expectedPaths = historicalExpectedArtifactPaths({ repository: repository!, observation: fixture! });
    expect(expectedPaths).toEqual([
      'onnx/decoder_model_merged_q4f16.onnx',
      'onnx/decoder_model_merged_q4f16.onnx_data',
      'onnx/embed_tokens_q4f16.onnx',
      'onnx/embed_tokens_q4f16.onnx_data',
    ]);
    expect(expectedPaths.some(path => path.includes('vision_encoder'))).toBe(false);
  });

  it('would flag the raw Qwen3.5 q4f16 repository set as an over-download against historical CausalLM sessions', () => {
    const repository = repositories['qwen3-5-2b'];
    const fixture = productionObservations['qwen3-5-2b'];
    expect(repository).toBeDefined();
    expect(fixture).toBeDefined();

    const expectedPaths = historicalExpectedArtifactPaths({ repository: repository!, observation: fixture! });
    const rawRepositoryQ4f16Paths = repository!.files
      .map(file => file.path)
      .filter(path => path.startsWith('onnx/') && path.includes('_q4f16.onnx'));
    const parity = compareModelArtifactRequestPaths({
      expectedPaths,
      observation: historicalObservationAsArtifactObservation({ fixture: fixture!, paths: rawRepositoryQ4f16Paths }),
    });

    expect(parity.status).toBe('mismatch');
    expect(parity.missingPaths).toEqual([]);
    expect(parity.unexpectedPaths).toEqual([
      'onnx/vision_encoder_q4f16.onnx',
      'onnx/vision_encoder_q4f16.onnx_data',
    ]);
  });

  it('accepts an observer path set that exactly matches the historical session-derived expectation', () => {
    for (const [name, fixture] of Object.entries(productionObservations)) {
      const repository = repositories[name];
      expect(repository).toBeDefined();
      const expectedPaths = historicalExpectedArtifactPaths({ repository: repository!, observation: fixture });
      const parity = compareModelArtifactRequestPaths({
        expectedPaths,
        observation: historicalObservationAsArtifactObservation({ fixture, paths: [...expectedPaths].reverse() }),
      });
      expect(parity).toMatchObject({
        status: 'match',
        missingPaths: [],
        unexpectedPaths: [],
      });
    }
  });
});
