// Keep the default jsdom environment: its module runner must not reinterpret
// the already-built artifact, while the native module sees the test's globals.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { getProductionTransformersArtifact, importProductionTransformersArtifact } from './production-transformers-artifact';

it('preserves emitted code bytes and its source map with distinct provenance identities', async () => {
  const artifact = await getProductionTransformersArtifact();
  const code = await readFile(new URL(artifact.moduleUrl));
  expect(createHash('sha256').update(code).digest('hex')).toBe(artifact.artifactSha256);
  expect(artifact.originalBundleSha256).not.toBe(artifact.transformedBundleSha256);
  expect(code.toString().match(/\/\/# sourceMappingURL=(.+)/u)?.[1]).toBe('transformers-js-fixes.mjs.map');
  const map = await readFile(new URL(`${artifact.moduleUrl}.map`));
  expect(map.byteLength).toBeGreaterThan(0);
});

it('evaluates a fresh runtime for each query without replacing native ESM identity within a query', async () => {
  const artifact = await getProductionTransformersArtifact();
  const firstUrl = new URL(artifact.moduleUrl);
  firstUrl.searchParams.set('native-runtime', 'first');
  const secondUrl = new URL(artifact.moduleUrl);
  secondUrl.searchParams.set('native-runtime', 'second');
  type Runtime = typeof import('@huggingface/transformers');
  const first = await importProductionTransformersArtifact({ moduleUrl: firstUrl.href }) as Runtime;
  const repeated = await importProductionTransformersArtifact({ moduleUrl: firstUrl.href });
  const second = await importProductionTransformersArtifact({ moduleUrl: secondUrl.href }) as Runtime;
  expect(first === repeated).toBe(true);
  expect(first === second).toBe(false);
  expect(first.env === second.env).toBe(false);
  expect(typeof first.AutoModelForCausalLM.from_pretrained).toBe('function');
});

it('rejects a different file, fragment, or network URL before native evaluation', async () => {
  const artifact = await getProductionTransformersArtifact();
  const sibling = new URL('./not-the-artifact.mjs', artifact.moduleUrl);
  await expect(importProductionTransformersArtifact({ moduleUrl: sibling.href })).rejects.toThrow('verified production artifact');
  await expect(importProductionTransformersArtifact({ moduleUrl: `${artifact.moduleUrl}#other` })).rejects.toThrow('verified production artifact');
  await expect(importProductionTransformersArtifact({ moduleUrl: 'https://example.invalid/runtime.mjs' })).rejects.toThrow('verified production artifact');
});
