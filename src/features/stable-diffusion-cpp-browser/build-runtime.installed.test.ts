// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { readImageArtifacts } from './build-runtime';
import { readLlamaArtifactPackage } from '@/features/llama-cpp-browser/build-artifact-package';
import { readNativeLicenseDependencies } from '../../../build/native-licenses/load';

// Check both independently pinned runtime dependencies. This is package integration,
// not trained-model/GPU inference; fixtures remain in build-runtime.test.ts.
it('connects each runtime consumer to its own installed bicore dependency', async () => {
  const rootDir = process.cwd();
  const pkg = z.object({ dependencies: z.record(z.string(), z.string()) }).parse(JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8')));
  const lock = z.object({
    packages: z.record(z.string(), z.object({
      dependencies: z.record(z.string(), z.string()).optional(),
      resolved: z.string().optional(),
      integrity: z.string().optional(),
    })),
  }).parse(JSON.parse(readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8')));
  for (const name of ['llama-cpp-browser-core', 'stable-diffusion-cpp-browser-core']) {
    const specifier = pkg.dependencies[name];
    expect(specifier).toMatch(/^github:nwtgck\/browser-inference-core#[0-9a-f]{40}$/);
    expect(lock.packages['']?.dependencies?.[name]).toBe(specifier);
    expect(lock.packages['node_modules/' + name]?.resolved?.split('#')[1]).toBe(specifier?.split('#')[1]);
    // The producer's package name is independent of the consumer dependency key.
    const installed = z.object({ name: z.literal('browser-inference-core') })
      .parse(JSON.parse(readFileSync(path.join(rootDir, 'node_modules', name, 'package.json'), 'utf8')));
    expect(installed.name).toBe('browser-inference-core');
  }
  // Preserve npm's optional integrity as received; each complete Git commit is its own pin.
  expect(pkg.dependencies['browser-inference-core']).toBeUndefined();
  const llama = readLlamaArtifactPackage({ rootDir });
  const rootManifestSchema = z.object({ sourceCommit: z.string() });
  const llamaRoot = rootManifestSchema.parse(JSON.parse(readFileSync(path.join(rootDir, 'node_modules/llama-cpp-browser-core/manifest.json'), 'utf8')));
  expect(llama.sourceCommit).toBe(llamaRoot.sourceCommit);

  const name = 'stable-diffusion-cpp-browser-core';
  const manifest = z.object({ capabilities: z.object({ safetensorsFileOffsetBits: z.literal(64), ggufShards: z.literal(true) }) })
    .parse(JSON.parse(readFileSync(path.join(rootDir, 'node_modules', name, 'runtimes/stable-diffusion-cpp-browser-core/manifest.json'), 'utf8')));
  expect(manifest.capabilities.ggufShards).toBe(true);
  const result = readImageArtifacts({ rootDir, mode: 'hosted', artifactDir: undefined });
  expect(result.configuration.kind).toBe('available');
  if (result.configuration.kind !== 'available') {
    throw new Error('Install the pinned bicore image dependency with npm ci');
  }
  const imageRoot = rootManifestSchema.parse(JSON.parse(readFileSync(path.join(rootDir, 'node_modules', name, 'manifest.json'), 'utf8')));
  expect(result.configuration.sourceCommit).toBe(imageRoot.sourceCommit);
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
  const modules = mkdtempSync(path.join(os.tmpdir(), 'naidan-installed-image-host-'));
  using _modules = {
    [Symbol.dispose]() {
      rmSync(modules, { recursive: true, force: true });
    },
  };
  for (const [name, read] of result.files) {
    if (!name.startsWith(prefix + 'host/') && !name.startsWith(prefix + 'api/')) {
      continue;
    }
    expect(name.endsWith('.mjs')).toBe(true);
    const file = path.join(modules, name.slice(prefix.length));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, await read());
  }
  const host: unknown = await import(/* @vite-ignore */ pathToFileURL(path.join(modules, 'host/index.mjs')).href);
  expect(host).toMatchObject({ attachCore: expect.any(Function), mountReadOnlyFile: expect.any(Function) });
  expect(result.nativeLicenseSource?.files.has('LICENSE')).toBe(true);
  expect(result.nativeLicenseSource?.files.has('licenses/ggml/LICENSE')).toBe(true);
  if (result.nativeLicenseSource === undefined) {
    throw new Error('Expected the installed image license source');
  }
  for (const source of [{
    runtime: 'llama-cpp' as const,
    kind: 'installed' as const,
    rootDir,
    manifestPaths: llama.manifestPaths,
    files: new Set(llama.files.keys()),
    readArtifact: llama.readArtifact,
  }, result.nativeLicenseSource]) {
    const notices = await readNativeLicenseDependencies({ source, watchFile() {} });
    expect(notices.length).toBeGreaterThan(0);
    expect(notices.every(notice => notice.id?.startsWith(`native:${source.runtime}:`))).toBe(true);
  }
  expect(result.files.has(prefix + 'LICENSE')).toBe(false);
  expect(readImageArtifacts({ rootDir, mode: 'standalone', artifactDir: '/do-not-open-this-directory' }).files.size).toBe(0);
}, 60_000);
