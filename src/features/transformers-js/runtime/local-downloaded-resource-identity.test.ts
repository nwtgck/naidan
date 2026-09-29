// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { createDownloadedModelReadOnlyCache } from './downloaded-model-cache';
import { createRequiredDownloadedResourceOperation } from './required-downloaded-resource-operation';
import { createMemoryFiles } from '@/features/transformers-js/replay-models/support/download-memory-files';

const workerLocationUrl = 'https://app.example.test/assets/worker.js';
const requiredPath = 'onnx/model_q4f16.onnx';
const storedPath = 'models/user/uploaded/onnx/model_q4f16.onnx';
const body = new Uint8Array([7, 11, 13]);
const forbiddenFetch = vi.fn<typeof fetch>(async () => {
  throw new Error('Unexpected local model transport');
});

async function setup({ modelId }: { modelId: string }) {
  const fs = createMemoryFiles();
  let directory = fs.root;
  for (const name of ['models', 'user', 'uploaded', 'onnx']) {
    directory = await directory.getDirectoryHandle(name, { create: true });
  }
  fs.files.set(storedPath, body);
  fs.files.set('models/user/uploaded/onnx/.model_q4f16.onnx.complete', new Uint8Array());
  fs.activity.length = 0;
  fs.enter({ nextPhase: 'load', mutationPolicy: 'read-only' });
  vi.stubGlobal('self', { location: new URL(workerLocationUrl) });
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => fs.root } });
  vi.stubGlobal('fetch', forbiddenFetch);
  const operation = createRequiredDownloadedResourceOperation({
    modelId, revision: undefined, requiredPaths: [requiredPath], workerLocationUrl,
    modelCache: createDownloadedModelReadOnlyCache({ modelId, revision: undefined }),
    cacheOnlyFetch: forbiddenFetch,
  });
  return { fs, operation };
}

afterEach(() => {
  expect(forbiddenFetch).not.toHaveBeenCalled();
  forbiddenFetch.mockClear();
  vi.unstubAllGlobals();
});

it('reads the selected user model through the upstream /models/user/ cache spelling', async () => {
  const { fs, operation } = await setup({ modelId: 'user/uploaded' });
  try {
    // hub.buildResourcePaths treats user/uploaded as a valid repository-shaped
    // identifier and prefixes env.localModelPath (/models/) for its local lookup.
    const response = await operation.cache.match('/models/user/uploaded/onnx/model_q4f16.onnx');
    expect(response).toBeDefined();
    expect(fs.activity.some(entry => entry.operation === 'stat' && entry.path === storedPath)).toBe(true);
    expect(await response!.arrayBuffer()).toEqual(body.buffer);
    expect(operation.assertHealthy).not.toThrow();
    expect(fs.activity.filter(entry => entry.operation !== 'stat').map(entry => entry.operation)).toEqual(['body-read']);
  } finally {
    await operation.close();
  }
});

it('reads the selected local model through its existing OPFS user-directory alias', async () => {
  const { fs, operation } = await setup({ modelId: 'local/uploaded' });
  try {
    const response = await operation.cache.match('/models/local/uploaded/onnx/model_q4f16.onnx');
    expect(response).toBeDefined();
    expect(fs.activity.some(entry => entry.operation === 'stat' && entry.path === storedPath)).toBe(true);
    expect(await response!.arrayBuffer()).toEqual(body.buffer);
    expect(operation.assertHealthy).not.toThrow();
    expect(fs.activity.filter(entry => entry.operation !== 'stat').map(entry => entry.operation)).toEqual(['body-read']);
  } finally {
    await operation.close();
  }
});

it('does not admit another local model through an equivalent path spelling', async () => {
  const { fs, operation } = await setup({ modelId: 'user/another' });
  try {
    await expect(operation.cache.match('/models/user/uploaded/onnx/model_q4f16.onnx')).resolves.toBeUndefined();
    expect(fs.activity).toEqual([]);
    expect(operation.assertHealthy).not.toThrow();
  } finally {
    await operation.close();
  }
});
