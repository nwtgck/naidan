import crypto from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createHostedTransformersRuntimeAssetBundle,
  TEST_ONLY,
} from './transformers-runtime-assets';
import { HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST } from '../src/features/transformers-js/runtime/runtime-asset-manifest';

function sha256Hex({ bytes }: { bytes: Uint8Array | string }): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function createValidatedOutputBundle() {
  const expectedBundle = createHostedTransformersRuntimeAssetBundle({ rootDir: path.resolve(__dirname, '..') });
  const outputBundle = Object.fromEntries([
    ...expectedBundle.assets.map(asset => [asset.fileName, { type: 'asset', source: asset.source }] as const),
    [expectedBundle.manifestFileName, { type: 'asset', source: expectedBundle.manifestSource }] as const,
  ]);
  return { expectedBundle, outputBundle };
}

describe('hosted Transformers runtime assets', () => {
  it('matches the pinned dependency packages and runtime bytes', () => {
    const bundle = createHostedTransformersRuntimeAssetBundle({ rootDir: path.resolve(__dirname, '..') });

    expect(bundle.assets.map(asset => ({
      fileName: asset.fileName,
      sha256: sha256Hex({ bytes: asset.source }),
    }))).toEqual([
      {
        fileName: 'transformers/ort-wasm-simd-threaded-5f2cd9145548.mjs',
        sha256: '5f2cd914554830762579c372d0211614c1e3f40ab3f6c0cfcf0900343229071d',
      },
      {
        fileName: 'transformers/ort-wasm-simd-threaded-454e43e733b9.wasm.gz',
        sha256: '454e43e733b9102fd20d0cde55cdb928700e81fa875a804fb48fa3b0a37d6f8f',
      },
      {
        fileName: 'transformers/ort-wasm-simd-threaded.asyncify-5959c6733039.mjs',
        sha256: '5959c6733039619c9af710d8e1bae8d6e84402787990637be987c2b1bd6c5fa9',
      },
      {
        fileName: 'transformers/ort-wasm-simd-threaded.asyncify-f06c09f2db45.wasm.gz',
        sha256: 'f06c09f2db4563e1a585ce4527e88a0cc35541d33f336e91547c8caf458a26b4',
      },
    ]);
    expect(bundle.manifestFileName).toBe(
      `transformers/runtime-assets-${HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST.buildId}.json`,
    );
    expect(JSON.parse(bundle.manifestSource)).toEqual(HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST);
  });

  it('binds the build ID to every manifest field except the build ID itself', () => {
    const actual = sha256Hex({ bytes: JSON.stringify(TEST_ONLY.manifestFingerprintInput()) });
    expect(actual).toBe(HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST.buildId);
  });

  it('does not emit the legacy stable production runtime filenames', () => {
    const bundle = createHostedTransformersRuntimeAssetBundle({ rootDir: path.resolve(__dirname, '..') });
    const fileNames = bundle.assets.map(asset => asset.fileName);
    expect(fileNames).not.toContain('transformers/ort-wasm-simd-threaded.mjs');
    expect(fileNames).not.toContain('transformers/ort-wasm-simd-threaded.wasm.gz');
    expect(fileNames).not.toContain('transformers/ort-wasm-simd-threaded.asyncify.mjs');
    expect(fileNames).not.toContain('transformers/ort-wasm-simd-threaded.asyncify.wasm.gz');
  });


  it('rejects a missing emitted runtime asset', () => {
    const { expectedBundle, outputBundle } = createValidatedOutputBundle();
    delete outputBundle[expectedBundle.assets[0]!.fileName];

    expect(() => TEST_ONLY.validateHostedTransformersRuntimeOutputBundle({
      expectedBundle,
      bundle: outputBundle,
    })).toThrow(/runtime output is missing/u);
  });

  it('rejects a tampered emitted runtime asset', () => {
    const { expectedBundle, outputBundle } = createValidatedOutputBundle();
    const fileName = expectedBundle.assets[0]!.fileName;
    outputBundle[fileName] = { type: 'asset', source: 'tampered' };

    expect(() => TEST_ONLY.validateHostedTransformersRuntimeOutputBundle({
      expectedBundle,
      bundle: outputBundle,
    })).toThrow(/runtime output fingerprint mismatch/u);
  });

  it('rejects a missing or tampered emitted runtime manifest', () => {
    const first = createValidatedOutputBundle();
    delete first.outputBundle[first.expectedBundle.manifestFileName];
    expect(() => TEST_ONLY.validateHostedTransformersRuntimeOutputBundle({
      expectedBundle: first.expectedBundle,
      bundle: first.outputBundle,
    })).toThrow(/runtime manifest output is missing/u);

    const second = createValidatedOutputBundle();
    second.outputBundle[second.expectedBundle.manifestFileName] = { type: 'asset', source: '{"tampered":true}' };
    expect(() => TEST_ONLY.validateHostedTransformersRuntimeOutputBundle({
      expectedBundle: second.expectedBundle,
      bundle: second.outputBundle,
    })).toThrow(/runtime manifest output differs/u);
  });
});
