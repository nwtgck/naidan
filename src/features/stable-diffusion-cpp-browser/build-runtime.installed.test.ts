// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { readImageArtifacts } from './build-runtime';
import { readLlamaArtifactPackage } from '@/features/llama-cpp-browser/build-artifact-package';

// Check both runtimes in the actual unified dependency. This is package integration,
// not trained-model/GPU inference; fixtures remain in build-runtime.test.ts.
it('connects both runtime consumers to the same installed bicore dependency', async () => {
  const rootDir = process.cwd();
  const pkg = z.object({ dependencies: z.record(z.string(), z.string()) }).parse(JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8')));
  const lock = z.object({
    packages: z.record(z.string(), z.object({
      dependencies: z.record(z.string(), z.string()).optional(),
      resolved: z.string().optional(),
      integrity: z.string().optional(),
    })),
  }).parse(JSON.parse(readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8')));
  const name = 'browser-inference-core';
  const specifier = pkg.dependencies[name];
  expect(specifier).toMatch(/^github:nwtgck\/browser-inference-core#[0-9a-f]{40}$/);
  expect(lock.packages['']?.dependencies?.[name]).toBe(specifier);
  expect(lock.packages['node_modules/' + name]?.resolved?.split('#')[1]).toBe(specifier?.split('#')[1]);
  expect(lock.packages['node_modules/' + name]?.integrity).toMatch(/^sha512-/);
  expect(pkg.dependencies['llama-cpp-browser-core']).toBeUndefined();
  expect(pkg.dependencies['stable-diffusion-cpp-browser-core']).toBeUndefined();
  const llama = readLlamaArtifactPackage({ rootDir });

  const manifest = z.object({ capabilities: z.object({ safetensorsFileOffsetBits: z.literal(64), ggufShards: z.literal(true) }) })
    .parse(JSON.parse(readFileSync(path.join(rootDir, 'node_modules', name, 'runtimes/stable-diffusion-cpp-browser-core/manifest.json'), 'utf8')));
  expect(manifest.capabilities.ggufShards).toBe(true);
  const result = readImageArtifacts({ rootDir, mode: 'hosted', artifactDir: undefined });
  expect(result.configuration.kind).toBe('available');
  if (result.configuration.kind !== 'available') {
    throw new Error('Install the pinned bicore image dependency with npm ci');
  }
  expect(result.configuration.sourceCommit).toBe(llama.sourceCommit);
  expect(result.configuration.artifacts.map(artifact => artifact.profile)).toEqual(['webgpu-wasm32-asyncify', 'webgpu-wasm32-jspi', 'webgpu-wasm64-jspi']);
  const prefix = 'stable-diffusion-cpp-runtime/' + result.configuration.sourceCommit + '/';
  for (const artifact of result.configuration.artifacts) {
    const readWasm = result.files.get(artifact.wasmPath);
    if (readWasm === undefined) {
      throw new Error('Missing emitted image Wasm');
    }
    const decoded = gunzipSync(await readWasm());
    expect(decoded.length).toBe(artifact.wasmBytes);
    expect(createHash('sha256').update(decoded).digest('hex')).toBe(artifact.wasmSha256);
    expect(result.files.has(artifact.modulePath)).toBe(true);
    expect(result.files.has(artifact.helpersPath)).toBe(true);
    expect(artifact.helpersPath).toBe(prefix + 'host/index.mjs');
  }
  expect([...result.files.keys()].every(name => name.startsWith(prefix))).toBe(true);
  for (const name of ['host/bindings.mjs', 'host/read-only-file.mjs', 'api/schema.mjs']) {
    expect(result.files.has(prefix + name), name).toBe(true);
  }
  expect(result.nativeLicenseSource?.files.has('LICENSE')).toBe(true);
  expect(result.nativeLicenseSource?.files.has('licenses/ggml/LICENSE')).toBe(true);
  expect(result.files.has(prefix + 'LICENSE')).toBe(false);
  expect(readImageArtifacts({ rootDir, mode: 'standalone', artifactDir: '/do-not-open-this-directory' }).files.size).toBe(0);
}, 60_000);
