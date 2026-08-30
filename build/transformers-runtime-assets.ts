import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import type { OutputAsset } from 'rolldown';
import type { Plugin } from 'vite';
import {
  HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST,
  type HostedTransformersRuntimeAssetManifestEntry,
} from '../src/features/transformers-js/runtime/runtime-asset-manifest';

interface HostedTransformersRuntimeEmittedAsset {
  fileName: string,
  source: Uint8Array | string,
  sha256: string,
}

interface HostedTransformersRuntimeOutputLike {
  type: string,
  source?: OutputAsset['source'],
}

function sha256Hex({ bytes }: { bytes: Uint8Array | string }): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readPackageVersion({ packageJsonPath }: { packageJsonPath: string }): string {
  const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || typeof parsed.version !== 'string') {
    throw new Error(`Package metadata did not contain a string version: ${packageJsonPath}`);
  }
  return parsed.version;
}

function manifestFingerprintInput(): object {
  const { buildId: _buildId, ...input } = HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST;
  return input;
}

function validatePackageVersions({ rootDir }: { rootDir: string }): void {
  const expected = HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST.versions;
  const observed = {
    transformers: readPackageVersion({ packageJsonPath: path.join(rootDir, 'node_modules/@huggingface/transformers/package.json') }),
    onnxRuntimeWeb: readPackageVersion({ packageJsonPath: path.join(rootDir, 'node_modules/onnxruntime-web/package.json') }),
    onnxRuntimeCommon: readPackageVersion({ packageJsonPath: path.join(rootDir, 'node_modules/onnxruntime-common/package.json') }),
    onnxRuntimeWebBundledCommon: readPackageVersion({ packageJsonPath: path.join(rootDir, 'node_modules/onnxruntime-web/node_modules/onnxruntime-common/package.json') }),
  };
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (observed[key] !== expected[key]) {
      throw new Error(`Hosted Transformers runtime dependency mismatch for ${key}: expected ${expected[key]}, observed ${observed[key]}`);
    }
  }
}

function validateManifestBuildId(): void {
  const actual = sha256Hex({ bytes: JSON.stringify(manifestFingerprintInput()) });
  if (actual !== HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST.buildId) {
    throw new Error(`Hosted Transformers runtime manifest build ID mismatch: expected ${HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST.buildId}, computed ${actual}`);
  }
}

function runtimeEntryAssets({
  rootDir,
  entry,
}: {
  rootDir: string,
  entry: HostedTransformersRuntimeAssetManifestEntry,
}): HostedTransformersRuntimeEmittedAsset[] {
  const distDir = path.join(rootDir, 'node_modules/onnxruntime-web/dist');
  const mjs = fs.readFileSync(path.join(distDir, entry.sourceMjsFileName));
  const wasm = fs.readFileSync(path.join(distDir, entry.sourceWasmFileName));
  const compressedWasm = gzipSync(wasm, { level: 9 });

  const observed = {
    mjsByteLength: mjs.byteLength,
    mjsSha256: sha256Hex({ bytes: mjs }),
    wasmByteLength: wasm.byteLength,
    wasmSha256: sha256Hex({ bytes: wasm }),
    physicalWasmByteLength: compressedWasm.byteLength,
    physicalWasmSha256: sha256Hex({ bytes: compressedWasm }),
  };
  if (observed.mjsByteLength !== entry.mjs.byteLength || observed.mjsSha256 !== entry.mjs.sha256) {
    throw new Error(`Hosted Transformers runtime MJS fingerprint mismatch for ${entry.sourceMjsFileName}`);
  }
  if (observed.wasmByteLength !== entry.wasm.byteLength || observed.wasmSha256 !== entry.wasm.sha256) {
    throw new Error(`Hosted Transformers runtime WASM fingerprint mismatch for ${entry.sourceWasmFileName}`);
  }
  if (observed.physicalWasmByteLength !== entry.wasm.physicalByteLength || observed.physicalWasmSha256 !== entry.wasm.physicalSha256) {
    throw new Error(`Hosted Transformers runtime gzip fingerprint mismatch for ${entry.sourceWasmFileName}`);
  }

  return [
    { fileName: `transformers/${entry.mjs.publicFileName}`, source: mjs, sha256: entry.mjs.sha256 },
    { fileName: `transformers/${entry.wasm.physicalFileName}`, source: compressedWasm, sha256: entry.wasm.physicalSha256 },
  ];
}

export function createHostedTransformersRuntimeAssetBundle({ rootDir }: { rootDir: string }): {
  assets: HostedTransformersRuntimeEmittedAsset[],
  manifestFileName: string,
  manifestSource: string,
} {
  validatePackageVersions({ rootDir });
  validateManifestBuildId();
  const assets = HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST.variants.flatMap(entry => runtimeEntryAssets({ rootDir, entry }));
  const manifestFileName = `transformers/runtime-assets-${HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST.buildId}.json`;
  const manifestSource = `${JSON.stringify(HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST, undefined, 2)}\n`;
  return { assets, manifestFileName, manifestSource };
}

function outputAssetBytes({ asset }: { asset: { source: OutputAsset['source'] } }): Uint8Array | string {
  return typeof asset.source === 'string' ? asset.source : new Uint8Array(asset.source);
}

function validateHostedTransformersRuntimeOutputBundle({
  expectedBundle,
  bundle,
}: {
  expectedBundle: ReturnType<typeof createHostedTransformersRuntimeAssetBundle>,
  bundle: Readonly<Record<string, HostedTransformersRuntimeOutputLike | undefined>>,
}): void {
  for (const expected of expectedBundle.assets) {
    const output = bundle[expected.fileName];
    if (output === undefined || output.type !== 'asset' || output.source === undefined) {
      throw new Error(`Hosted Transformers runtime output is missing: ${expected.fileName}`);
    }
    const actualSha256 = sha256Hex({ bytes: outputAssetBytes({ asset: { source: output.source } }) });
    if (actualSha256 !== expected.sha256) {
      throw new Error(`Hosted Transformers runtime output fingerprint mismatch: ${expected.fileName}`);
    }
  }
  const manifestOutput = bundle[expectedBundle.manifestFileName];
  if (manifestOutput === undefined || manifestOutput.type !== 'asset' || manifestOutput.source === undefined) {
    throw new Error(`Hosted Transformers runtime manifest output is missing: ${expectedBundle.manifestFileName}`);
  }
  if (String(manifestOutput.source) !== expectedBundle.manifestSource) {
    throw new Error('Hosted Transformers runtime manifest output differs from the validated manifest');
  }
}

export function createHostedTransformersRuntimeAssetsPlugin({
  rootDir,
}: {
  rootDir: string,
}): Plugin {
  let expectedBundle: ReturnType<typeof createHostedTransformersRuntimeAssetBundle> | undefined;
  return {
    name: 'naidan-hosted-transformers-runtime-assets',
    buildStart() {
      expectedBundle = createHostedTransformersRuntimeAssetBundle({ rootDir });
      for (const asset of expectedBundle.assets) {
        this.emitFile({ type: 'asset', fileName: asset.fileName, source: asset.source });
      }
      this.emitFile({
        type: 'asset',
        fileName: expectedBundle.manifestFileName,
        source: expectedBundle.manifestSource,
      });
    },
    generateBundle(_options, bundle) {
      if (expectedBundle === undefined) throw new Error('Hosted Transformers runtime asset bundle was not initialized');
      validateHostedTransformersRuntimeOutputBundle({ expectedBundle, bundle });
    },
  };
}

export const TEST_ONLY = {
  manifestFingerprintInput,
  validateHostedTransformersRuntimeOutputBundle,
};
