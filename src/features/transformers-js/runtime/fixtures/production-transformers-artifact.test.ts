// Keep the default jsdom environment: its module runner must not reinterpret
// the already-built artifact, while the native module sees the test's globals.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { getProductionTransformersArtifact, importProductionTransformersArtifact, TEST_ONLY } from './production-transformers-artifact';

it('preserves emitted code bytes and its source map with distinct provenance identities', async () => {
  const artifact = await getProductionTransformersArtifact();
  const code = await readFile(new URL(artifact.moduleUrl));
  expect(createHash('sha256').update(code).digest('hex')).toBe(artifact.artifactSha256);
  expect(artifact.originalBundleSha256).not.toBe(artifact.transformedBundleSha256);
  expect(code.toString().match(/\/\/# sourceMappingURL=(.+)/u)?.[1]).toBe('transformers-js-fixes.mjs.map');
  const map = await readFile(new URL(`${artifact.moduleUrl}.map`));
  expect(map.byteLength).toBeGreaterThan(0);
});

it('rejects changed owned artifact bytes before evaluation and accepts the restored original', async () => {
  const artifact = await getProductionTransformersArtifact();
  const path = new URL(artifact.moduleUrl);
  const original = await readFile(path);
  try {
    await writeFile(path, 'throw new Error("Changed artifact must not execute");');
    await expect(importProductionTransformersArtifact({ moduleUrl: artifact.moduleUrl })).rejects.toThrow('Production replay artifact bytes changed before evaluation');
  } finally {
    await writeFile(path, original);
  }
  expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(artifact.artifactSha256);
  const restored = await importProductionTransformersArtifact({ moduleUrl: artifact.moduleUrl }) as { env: object };
  expect(restored.env).toBeDefined();
});

it('evaluates an independent runtime even for the same URL', async () => {
  const artifact = await getProductionTransformersArtifact();
  const firstUrl = new URL(artifact.moduleUrl);
  firstUrl.searchParams.set('native-runtime', 'first');
  const secondUrl = new URL(artifact.moduleUrl);
  secondUrl.searchParams.set('native-runtime', 'second');
  type Runtime = typeof import('@huggingface/transformers');
  const first = await importProductionTransformersArtifact({ moduleUrl: firstUrl.href }) as Runtime;
  const repeated = await importProductionTransformersArtifact({ moduleUrl: firstUrl.href }) as Runtime;
  const second = await importProductionTransformersArtifact({ moduleUrl: secondUrl.href }) as Runtime;
  // URL-keyed Node imports retained all prior runtime/cache closures. This
  // fixture now intentionally owns a fresh module per call, not a URL cache.
  expect(first === repeated).toBe(false);
  expect(first.env === repeated.env).toBe(false);
  expect(first === second).toBe(false);
  expect(first.env === second.env).toBe(false);
  first.env.allowRemoteModels = false;
  expect(repeated.env.allowRemoteModels).toBe(true);
  expect(second.env.allowRemoteModels).toBe(true);
  expect(typeof first.AutoModelForCausalLM.from_pretrained).toBe('function');
});

it('preserves the external ORT Tensor identity in separate browser-branch runtimes', async () => {
  const artifact = await getProductionTransformersArtifact();
  const originalProcess = globalThis.process;
  // The web bundle's Node branch intentionally has no onnxruntime-node export.
  // Match the existing replay's browser branch before evaluating either module.
  vi.stubGlobal('process', { ...originalProcess, release: { ...originalProcess.release, name: 'browser-test' } });
  try {
    type Runtime = typeof import('@huggingface/transformers');
    const first = await importProductionTransformersArtifact({ moduleUrl: artifact.moduleUrl }) as Runtime;
    const second = await importProductionTransformersArtifact({ moduleUrl: artifact.moduleUrl }) as Runtime;
    const ort = await import(/* @vite-ignore */ artifact.ortCommonUrl) as typeof import('onnxruntime-common');
    const tensor = new first.Tensor('float32', new Float32Array([1]), [1]);
    const other = new second.Tensor('float32', new Float32Array([2]), [1]);
    expect(tensor.ort_tensor).toBeInstanceOf(ort.Tensor);
    expect(other.ort_tensor).toBeInstanceOf(ort.Tensor);
    expect(Array.from(tensor.data)).toEqual([1]);
    expect(Array.from(other.data)).toEqual([2]);
  } finally {
    vi.stubGlobal('process', originalProcess);
  }
});

it('preserves import.meta.url when evaluating unchanged ESM source', async () => {
  const artifact = await getProductionTransformersArtifact();
  const moduleUrl = `${artifact.moduleUrl}?meta=source-derived`;
  // A synthetic module probes VM metadata without modifying the real bundle.
  const result = await TEST_ONLY.evaluateArtifactModule({
    code: 'export const url = import.meta.url;',
    moduleUrl,
    ortWebGpuUrl: artifact.ortWebGpuUrl,
    ortCommonUrl: artifact.ortCommonUrl,
  }) as { url: string };
  expect(result.url).toBe(moduleUrl);
});

it('rejects an unprovided static dependency before importing it', async () => {
  const artifact = await getProductionTransformersArtifact();
  await expect(TEST_ONLY.evaluateArtifactModule({
    code: 'import "https://example.invalid/unprovided.mjs";',
    moduleUrl: artifact.moduleUrl,
    ortWebGpuUrl: artifact.ortWebGpuUrl,
    ortCommonUrl: artifact.ortCommonUrl,
  })).rejects.toThrow('Unprovided static production artifact dependency: https://example.invalid/unprovided.mjs');
});

it('rejects dynamic imports instead of granting the native loader a fallback', async () => {
  const artifact = await getProductionTransformersArtifact();
  const result = await TEST_ONLY.evaluateArtifactModule({
    code: 'export async function run() { return import("https://example.invalid/unprovided.mjs"); }',
    moduleUrl: artifact.moduleUrl,
    ortWebGpuUrl: artifact.ortWebGpuUrl,
    ortCommonUrl: artifact.ortCommonUrl,
  }) as { run(): Promise<unknown> };
  await expect(result.run()).rejects.toThrow('Unprovided dynamic production artifact dependency: https://example.invalid/unprovided.mjs');
});

it('rejects a different file, fragment, or network URL before native evaluation', async () => {
  const artifact = await getProductionTransformersArtifact();
  const sibling = new URL('./not-the-artifact.mjs', artifact.moduleUrl);
  await expect(importProductionTransformersArtifact({ moduleUrl: sibling.href })).rejects.toThrow('verified production artifact');
  await expect(importProductionTransformersArtifact({ moduleUrl: `${artifact.moduleUrl}#other` })).rejects.toThrow('verified production artifact');
  await expect(importProductionTransformersArtifact({ moduleUrl: 'https://example.invalid/runtime.mjs' })).rejects.toThrow('verified production artifact');
});
