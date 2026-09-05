import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface RepositoryFixtureFile {
  path: string;
  size: number;
  blobId?: string;
  lfs?: {
    sha256: string;
    size: number;
    pointerSize: number;
  };
  xet?: unknown;
}

interface RepositoryFixture {
  schemaVersion: number;
  source: {
    kind: string;
    observedAt: string;
    note: string;
  };
  modelId: string;
  requestedRevision: string;
  resolvedRevision: string;
  modelType: string;
  architectures: string[];
  transformersJsConfig: unknown;
  files: RepositoryFixtureFile[];
}

interface ProductionObservationFixture {
  schemaVersion: number;
  source: {
    kind: string;
    observedAt: string;
    note: string;
  };
  modelId: string;
  resolvedRevision: string;
  candidate: {
    device: string;
    dtype: string;
  };
  autoClass: string;
  modelType: string;
  sessionNames: string[];
}

function readFixtureDirectory<T>({ directory }: { directory: string }): Record<string, T> {
  return Object.fromEntries(
    readdirSync(directory)
      .filter(fileName => fileName.endsWith('.json'))
      .sort((a, b) => a.localeCompare(b))
      .map(fileName => {
        const parsed = JSON.parse(readFileSync(resolve(directory, fileName), 'utf8')) as T;
        return [fileName.replace(/\.json$/, ''), parsed];
      }),
  );
}

function requireFixture<T>({ fixtures, name }: { fixtures: Record<string, T>; name: string }): T {
  const fixture = fixtures[name];
  if (fixture === undefined) throw new Error(`Missing Download Verification fixture: ${name}`);
  return fixture;
}

const fixtureRoot = resolve(process.cwd(), 'src/features/transformers-js/download-verification/fixtures');
const repositories = readFixtureDirectory<RepositoryFixture>({
  directory: resolve(fixtureRoot, 'repositories'),
});
const productionObservations = readFixtureDirectory<ProductionObservationFixture>({
  directory: resolve(fixtureRoot, 'production-observations'),
});

describe('Download Verification repository fixtures', () => {
  it('pins representative public repositories to exact revisions with available file identity metadata', () => {
    expect(Object.keys(repositories)).toEqual([
      'gemma-4-e2b-it',
      'gpt-oss-20b',
      'lfm2-5-2-6b',
      'lfm2-5-230m',
      'qwen3-5-2b',
      'smollm2-135m-instruct',
    ]);

    for (const fixture of Object.values(repositories)) {
      expect(fixture.schemaVersion).toBe(1);
      expect([
        'hugging-face-model-api-captured-by-model-support-investigation',
        'hugging-face-commit-page-public-facts',
      ]).toContain(fixture.source.kind);
      expect(fixture.resolvedRevision).toMatch(/^[0-9a-f]{40}$/);
      expect(fixture.files.length).toBeGreaterThan(0);

      const paths = fixture.files.map(file => file.path);
      expect(new Set(paths).size).toBe(paths.length);
      for (const file of fixture.files) {
        expect(file.path).not.toMatch(/^https?:\/\//);
        expect(file.size).toBeGreaterThanOrEqual(0);
        if (file.blobId !== undefined) expect(file.blobId).toMatch(/^[0-9a-f]{40}$/);
        if (file.blobId === undefined) expect(file.lfs).toBeDefined();
        if (file.lfs !== undefined) {
          expect(file.lfs.sha256).toMatch(/^[0-9a-f]{64}$/);
          expect(file.lfs.size).toBe(file.size);
          expect(file.lfs.pointerSize).toBeGreaterThan(0);
        }
      }
    }
  });

  it('preserves the Qwen3.5 repository-vs-historical-production counterexample without conflating the layers', () => {
    const repository = requireFixture({ fixtures: repositories, name: 'qwen3-5-2b' });
    const observation = requireFixture({ fixtures: productionObservations, name: 'qwen3-5-2b' });

    const q4f16Paths = repository.files
      .map(file => file.path)
      .filter(path => path.includes('q4f16'));
    expect(q4f16Paths).toContain('onnx/decoder_model_merged_q4f16.onnx');
    expect(q4f16Paths).toContain('onnx/embed_tokens_q4f16.onnx');
    expect(q4f16Paths).toContain('onnx/vision_encoder_q4f16.onnx');
    expect(observation.sessionNames).toEqual(['decoder_model_merged', 'embed_tokens']);
    expect(observation.sessionNames).not.toContain('vision_encoder');
    expect(observation.source.kind).toBe('historical-model-support-investigation-production-observation');
  });

  it('keeps historical Production observations separate from current routing expectations', () => {
    expect(Object.keys(productionObservations)).toEqual([
      'gemma-4-e2b-it',
      'gpt-oss-20b',
      'lfm2-5-2-6b',
      'qwen3-5-2b',
      'smollm2-135m-instruct',
    ]);
    const gemmaObservation = requireFixture({ fixtures: productionObservations, name: 'gemma-4-e2b-it' });
    expect(gemmaObservation.autoClass).toBe('AutoModelForCausalLM');
    expect(gemmaObservation.source.note).toContain('not a declaration of the current Production route');
  });


  it('captures the LFM2.5-230M q4-only WebGPU artifact inventory without inventing q4f16 files', () => {
    const lfm230 = requireFixture({ fixtures: repositories, name: 'lfm2-5-230m' });
    expect(lfm230.source.kind).toBe('hugging-face-commit-page-public-facts');
    expect(lfm230.resolvedRevision).toBe('c6f46e4e3f885ebcad164d14059a49f90e27eb4d');

    const paths = lfm230.files.map(file => file.path);
    expect(paths).toContain('onnx/model_q4.onnx');
    expect(paths).toContain('onnx/model_q4.onnx_data');
    expect(paths.some(path => path.includes('q4f16'))).toBe(false);

    expect(lfm230.files.find(file => file.path === 'onnx/model_q4.onnx')).toMatchObject({
      size: 154010,
      lfs: {
        sha256: '82a442c44d3d143432edff57984a4e7e8da65179d3a960a170d294aed8c5dd8d',
      },
    });
    expect(lfm230.files.find(file => file.path === 'onnx/model_q4.onnx_data')).toMatchObject({
      size: 211111936,
      lfs: {
        sha256: 'b51a4580a88a2cd0486032cfdaf8694b09359abca5a97df8deb0a314ea6e5b34',
      },
    });
  });

  it('captures external-data metadata needed by the representative model families', () => {
    const lfm = requireFixture({ fixtures: repositories, name: 'lfm2-5-2-6b' });
    expect(lfm.files.map(file => file.path)).toEqual(expect.arrayContaining([
      'onnx/model_q4f16.onnx',
      'onnx/model_q4f16.onnx_data',
      'onnx/model_q4f16.onnx_data_1',
    ]));

    const gptOss = requireFixture({ fixtures: repositories, name: 'gpt-oss-20b' });
    const gptOssQ4f16ExternalData = gptOss.files
      .map(file => file.path)
      .filter(path => /^onnx\/model_q4f16\.onnx_data(?:_\d+)?$/.test(path));
    expect(gptOssQ4f16ExternalData).toHaveLength(7);
  });
});
