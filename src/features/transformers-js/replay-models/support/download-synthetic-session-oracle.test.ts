// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createSyntheticModelBody, inspectSyntheticOrtSession, readSyntheticModelBody } from '@/features/transformers-js/replay-models/support/download-synthetic-session-oracle';

const modelId = 'fixture/model';
const revision = '1234567890abcdef1234567890abcdef12345678';
const corePath = 'onnx/model_q4f16.onnx';
const dataPath = 'onnx/model_q4f16.onnx_data';

describe('synthetic model session oracle', () => {
  it('round-trips model, exact revision, and artifact path in bounded synthetic bytes', () => {
    const bytes = createSyntheticModelBody({ modelId, revision, path: corePath });
    expect(bytes.byteLength).toBeLessThan(512);
    expect(readSyntheticModelBody({ bytes })).toEqual({ modelId, revision, path: corePath });
    expect(new TextDecoder().decode(bytes)).toContain('naidan-synthetic-model-body-v1');
  });

  it('distinguishes another model even when revision and artifact name agree', () => {
    const first = createSyntheticModelBody({ modelId, revision, path: corePath });
    const second = createSyntheticModelBody({ modelId: 'fixture/other', revision, path: corePath });
    expect(first).not.toEqual(second);
  });

  it('distinguishes another exact revision for the same artifact', () => {
    const first = createSyntheticModelBody({ modelId, revision, path: corePath });
    const second = createSyntheticModelBody({ modelId, revision: 'abcdef1234567890abcdef1234567890abcdef12', path: corePath });
    expect(first).not.toEqual(second);
  });

  it('distinguishes quantizations and external chunks instead of reusing one body', () => {
    const paths = [corePath, 'onnx/model_q4.onnx', dataPath, `${dataPath}_1`];
    const bodies = paths.map(path => new TextDecoder().decode(createSyntheticModelBody({ modelId, revision, path })));
    expect(new Set(bodies).size).toBe(4);
  });

  it('rejects truncated synthetic data', () => {
    const bytes = createSyntheticModelBody({ modelId, revision, path: corePath });
    expect(() => readSyntheticModelBody({ bytes: bytes.slice(0, -1) })).toThrow();
  });

  it('rejects parseable identity corruption without a matching checksum', () => {
    const encoded = new TextDecoder().decode(createSyntheticModelBody({ modelId, revision, path: corePath }));
    const corrupted = new TextEncoder().encode(encoded.replace('model_q4f16.onnx', 'model_q4.onnx'));
    expect(() => readSyntheticModelBody({ bytes: corrupted })).toThrow('checksum mismatch');
  });

  it('rejects arbitrary tiny bytes that the former ORT spy accepted', () => {
    expect(() => readSyntheticModelBody({ bytes: new Uint8Array([17, 23, 41]) })).toThrow();
  });

  it('validates core and external binding identities and records the actual provider list', () => {
    const observed = inspectSyntheticOrtSession({
      modelId, revision, repositoryPaths: new Set([corePath, dataPath]),
      core: createSyntheticModelBody({ modelId, revision, path: corePath }),
      options: {
        executionProviders: ['webgpu'],
        externalData: [{ path: 'model_q4f16.onnx_data', data: createSyntheticModelBody({ modelId, revision, path: dataPath }) }],
      },
    });
    expect(observed).toEqual({
      modelId, revision, corePath,
      externalData: [{ path: 'model_q4f16.onnx_data', artifactPath: dataPath }],
      executionProviders: ['webgpu'],
    });
  });

  it('rejects a core copied from another model', () => {
    expect(() => inspectSyntheticOrtSession({
      modelId, revision, repositoryPaths: new Set([corePath]),
      core: createSyntheticModelBody({ modelId: 'fixture/other', revision, path: corePath }),
      options: { executionProviders: ['webgpu'] },
    })).toThrow('identity mismatch');
  });

  it('rejects external bytes copied from a different revision', () => {
    expect(() => inspectSyntheticOrtSession({
      modelId, revision, repositoryPaths: new Set([corePath, dataPath]),
      core: createSyntheticModelBody({ modelId, revision, path: corePath }),
      options: {
        executionProviders: ['webgpu'],
        externalData: [{ path: 'model_q4f16.onnx_data', data: createSyntheticModelBody({ modelId, revision: 'abcdef1234567890abcdef1234567890abcdef12', path: dataPath }) }],
      },
    })).toThrow('identity mismatch');
  });

  it('rejects an external chunk bound to a different filename', () => {
    expect(() => inspectSyntheticOrtSession({
      modelId, revision, repositoryPaths: new Set([corePath, dataPath, `${dataPath}_1`]),
      core: createSyntheticModelBody({ modelId, revision, path: corePath }),
      options: {
        executionProviders: ['webgpu'],
        externalData: [{ path: 'model_q4f16.onnx_data_1', data: createSyntheticModelBody({ modelId, revision, path: dataPath }) }],
      },
    })).toThrow('binding mismatch');
  });

  it('rejects an external file from a different core even when the binding matches its bytes', () => {
    const otherData = 'onnx/other_q4f16.onnx_data';
    expect(() => inspectSyntheticOrtSession({
      modelId, revision, repositoryPaths: new Set([corePath, otherData]),
      core: createSyntheticModelBody({ modelId, revision, path: corePath }),
      options: {
        executionProviders: ['webgpu'],
        externalData: [{ path: 'other_q4f16.onnx_data', data: createSyntheticModelBody({ modelId, revision, path: otherData }) }],
      },
    })).toThrow('does not belong to core');
  });

  it('rejects a synthetic core not listed in the original repository inventory', () => {
    expect(() => inspectSyntheticOrtSession({
      modelId, revision, repositoryPaths: new Set(),
      core: createSyntheticModelBody({ modelId, revision, path: corePath }),
      options: { executionProviders: ['webgpu'] },
    })).toThrow('not in the repository inventory');
  });

  it('rejects missing provider options instead of silently recording an unverified session', () => {
    expect(() => inspectSyntheticOrtSession({
      modelId, revision, repositoryPaths: new Set([corePath]),
      core: createSyntheticModelBody({ modelId, revision, path: corePath }),
      options: {},
    })).toThrow();
  });

  it('preserves wasm as observed rather than rewriting it to the preferred webgpu provider', () => {
    const observed = inspectSyntheticOrtSession({
      modelId, revision, repositoryPaths: new Set([corePath]),
      core: createSyntheticModelBody({ modelId, revision, path: corePath }),
      options: { executionProviders: ['wasm'] },
    });
    expect(observed.executionProviders).toEqual(['wasm']);
  });
});
