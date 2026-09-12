// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createProviderReplayTestRuntime } from '@/features/transformers-js/replay-models/support/provider-replay-test-runtime';
import { createSyntheticModelBody } from '@/features/transformers-js/replay-models/support/download-synthetic-session-oracle';

const modelId = 'HuggingFaceTB/SmolLM2-135M-Instruct';
const revision = '12fd25f77366fa6b3b4b768ec3050bf629380bac';
const modelPath = 'onnx/model_q4f16.onnx';
const cachePrefix = `models/huggingface.co/${modelId}/resolve/`;

function createRuntime() {
  return createProviderReplayTestRuntime({
    modelId, expectedRevision: revision, cacheRevision: 'main', metadataCache: 'all-fixture',
    artifacts: [{ path: modelPath, bytes: createSyntheticModelBody({ modelId, revision, path: modelPath }) }],
    imagePlatform: undefined,
    generate: async () => {
      throw new Error('Revision selection must not generate');
    },
  });
}

async function seedImmutable({ harness, paths, malformedConfig, targetRevision }: {
  harness: Awaited<ReturnType<typeof createRuntime>>;
  paths: string[];
  malformedConfig: boolean;
  targetRevision: string;
}) {
  const fs = harness.observations.fs;
  fs.enter({ nextPhase: 'fixture-setup', mutationPolicy: 'read-write' });
  for (const path of paths) {
    const source = fs.files.get(`${cachePrefix}main/${path}`);
    if (source === undefined) throw new Error(`Unprovided fixture path ${path}`);
    const key = `${cachePrefix}${targetRevision}/${path}`;
    let directory = fs.root;
    for (const part of key.split('/').slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create: true });
    fs.files.set(key, malformedConfig && path === 'config.json' ? new TextEncoder().encode('{broken') : Uint8Array.from(source));
    const slash = key.lastIndexOf('/');
    fs.files.set(`${key.slice(0, slash + 1)}.${key.slice(slash + 1)}.complete`, new Uint8Array());
  }
  fs.activity.length = 0;
  fs.enter({ nextPhase: 'offline-load', mutationPolicy: 'read-only' });
}

function expectReadOnly({ harness }: { harness: Awaited<ReturnType<typeof createRuntime>> }) {
  expect(harness.observations.forbiddenTransport).toEqual([]);
  expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
}

describe('ordinary offline revision selection through the actual Production Worker', () => {
  it('reports missing pinned legacy config as incomplete without discovering or repairing another namespace', async () => {
    const harness = await createRuntime();
    const { createTransformersJsWorkerClient } = await import('@/features/transformers-js/worker/client-hosted');
    const client = createTransformersJsWorkerClient();
    try {
      await seedImmutable({ harness, paths: ['config.json', 'tokenizer_config.json', 'tokenizer.json', modelPath], malformedConfig: false, targetRevision: revision });
      expect(harness.observations.fs.files.delete(`${cachePrefix}main/config.json`)).toBe(true);
      await expect(client.loadDownloadedModel({
        modelId, revisionSelection: { kind: 'pinned', revision: undefined }, progressCallback: () => undefined,
      })).rejects.toMatchObject({ name: 'MissingDownloadedModelArtifact' });
      expect(harness.observations.ortCalls).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => item.path.startsWith(`${cachePrefix}${revision}/`))).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => item.operation === 'body-read')).toEqual([]);
      expectReadOnly({ harness });
    } finally {
      await client.dispose();
      await harness.close();
    }
  }, 30_000);

  it('keeps an explicitly pinned legacy namespace pinned even when an immutable namespace is complete', async () => {
    const harness = await createRuntime();
    const { createTransformersJsWorkerClient } = await import('@/features/transformers-js/worker/client-hosted');
    const client = createTransformersJsWorkerClient();
    try {
      await seedImmutable({ harness, paths: ['config.json', 'tokenizer_config.json', 'tokenizer.json', modelPath], malformedConfig: false, targetRevision: revision });
      harness.observations.fs.files.delete(`${cachePrefix}main/tokenizer.json`);
      await expect(client.loadDownloadedModel({
        modelId, revisionSelection: { kind: 'pinned', revision: undefined }, progressCallback: () => undefined,
      })).rejects.toThrow();
      expect(harness.observations.ortCalls).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => item.path.startsWith(`${cachePrefix}${revision}/`))).toEqual([]);
      expectReadOnly({ harness });
    } finally {
      await client.dispose();
      await harness.close();
    }
  }, 30_000);

  it('uses each exact namespace config independently before selecting its complete component set', async () => {
    const harness = await createRuntime();
    const firstRevision = '0'.repeat(40);
    const secondRevision = 'f'.repeat(40);
    try {
      // Directory iteration observes the complete namespace first, then the
      // partial one. Its equal-or-newer stat timestamp sorts the partial one
      // first; the lexical tie breaker agrees. No wall-clock sleep is needed.
      const paths = ['config.json', 'tokenizer_config.json', 'tokenizer.json', modelPath];
      await seedImmutable({ harness, paths, malformedConfig: false, targetRevision: secondRevision });
      await seedImmutable({ harness, paths, malformedConfig: false, targetRevision: firstRevision });
      const configKey = `${cachePrefix}${firstRevision}/config.json`;
      const config = JSON.parse(new TextDecoder().decode(harness.observations.fs.files.get(configKey)));
      config['transformers.js_config'] = { use_external_data_format: true };
      harness.observations.fs.files.set(configKey, new TextEncoder().encode(JSON.stringify(config)));
      const observedConfigs: Array<{ revision: string | undefined; external: unknown }> = [];
      const original = harness.runtime.AutoConfig.from_pretrained.bind(harness.runtime.AutoConfig);
      vi.spyOn(harness.runtime.AutoConfig, 'from_pretrained').mockImplementation(async (...args) => {
        const result = await original(...args);
        observedConfigs.push({ revision: args[1]?.revision, external: result['transformers.js_config']?.use_external_data_format });
        return result;
      });
      await expect(harness.service.loadDownloadedModel({ modelId })).resolves.toBeUndefined();
      expect(observedConfigs.slice(0, 3)).toEqual([
        { revision: firstRevision, external: true },
        { revision: secondRevision, external: undefined },
        { revision: secondRevision, external: undefined },
      ]);
      expect(harness.observations.ortCalls).toHaveLength(1);
      const modelReads = harness.observations.fs.activity.filter(item => item.operation === 'body-read' && item.path.includes('/onnx/'));
      expect(modelReads.length).toBeGreaterThan(0);
      expect(modelReads.every(item => item.path.startsWith(`${cachePrefix}${secondRevision}/`))).toBe(true);
      expectReadOnly({ harness });
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('does not retry another namespace when a selected native Load loses a required file', async () => {
    const harness = await createRuntime();
    try {
      await seedImmutable({ harness, paths: ['config.json', 'tokenizer_config.json', 'tokenizer.json', modelPath], malformedConfig: false, targetRevision: revision });
      const original = harness.runtime.AutoModelForCausalLM.from_pretrained.bind(harness.runtime.AutoModelForCausalLM);
      let nativeLoads = 0;
      vi.spyOn(harness.runtime.AutoModelForCausalLM, 'from_pretrained').mockImplementation(async (...args) => {
        nativeLoads++;
        // An external deletion after completeness was established is not a
        // new permission to discover or load the still-complete legacy cache.
        harness.observations.fs.files.delete(`${cachePrefix}${revision}/${modelPath}`);
        return original.apply(harness.runtime.AutoModelForCausalLM, args);
      });
      await expect(harness.service.loadDownloadedModel({ modelId })).rejects.toThrow();
      expect(nativeLoads).toBe(1);
      expect(harness.observations.ortCalls).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => item.operation === 'body-read' && item.path.startsWith(`${cachePrefix}main/`))).toEqual([]);
      expectReadOnly({ harness });
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('plans past a partial immutable namespace before loading the complete legacy namespace', async () => {
    const harness = await createRuntime();
    try {
      // A committed core weight makes this namespace eligible for inventory,
      // but it does not supply the tokenizer required by the actual runtime.
      await seedImmutable({ harness, paths: ['config.json', modelPath], malformedConfig: false, targetRevision: revision });
      await expect(harness.service.loadDownloadedModel({ modelId })).resolves.toBeUndefined();
      expect(harness.observations.ortCalls).toHaveLength(1);
      const modelReads = harness.observations.fs.activity.filter(item => item.operation === 'body-read' && item.path.includes('/onnx/'));
      expect(modelReads.length).toBeGreaterThan(0);
      expect(modelReads.every(item => item.path.startsWith(`${cachePrefix}main/`))).toBe(true);
      expect(harness.observations.workers).toHaveLength(1);
      expectReadOnly({ harness });
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('excludes a partial namespace with no config before any native Load', async () => {
    const harness = await createRuntime();
    try {
      await seedImmutable({ harness, paths: [modelPath], malformedConfig: false, targetRevision: revision });
      await expect(harness.service.loadDownloadedModel({ modelId })).resolves.toBeUndefined();
      expect(harness.observations.ortCalls).toHaveLength(1);
      expect(harness.observations.fs.activity.filter(item => item.operation === 'body-read' && item.path.startsWith(`${cachePrefix}${revision}/`))).toEqual([]);
      expectReadOnly({ harness });
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('does not convert native inventory I/O failure into successful legacy Load', async () => {
    const harness = await createRuntime();
    try {
      const failure = new DOMException('Transient native OPFS inspection failure', 'NotReadableError');
      vi.spyOn(navigator.storage, 'getDirectory').mockRejectedValueOnce(failure);
      await expect(harness.service.loadDownloadedModel({ modelId })).rejects.toThrow('Transient native OPFS inspection failure');
      expect(harness.observations.ortCalls).toEqual([]);
      expectReadOnly({ harness });
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('treats malformed candidate metadata as terminal instead of hiding it behind another namespace', async () => {
    const harness = await createRuntime();
    try {
      await seedImmutable({ harness, paths: ['config.json', modelPath], malformedConfig: true, targetRevision: revision });
      await expect(harness.service.loadDownloadedModel({ modelId })).rejects.toThrow();
      expect(harness.observations.ortCalls).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => item.operation === 'body-read' && item.path.includes('/onnx/'))).toEqual([]);
      expectReadOnly({ harness });
    } finally {
      await harness.close();
    }
  }, 30_000);
});
