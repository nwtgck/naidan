// @vitest-environment node
import { expect, it } from 'vitest';
import { createProviderReplayTestRuntime } from '@/features/transformers-js/replay-models/support/provider-replay-test-runtime';
import { createSyntheticModelBody } from '@/features/transformers-js/replay-models/support/download-synthetic-session-oracle';

const modelId = 'onnx-community/gemma-4-E2B-it-ONNX';
const revision = '9f4bef82ea6e296bc69f8a2f5939f73af81b07a6';
const prefix = `models/huggingface.co/${modelId}/resolve/`;

function createRuntime() {
  return createProviderReplayTestRuntime({
    modelId, expectedRevision: revision, cacheRevision: 'main', metadataCache: 'all-fixture',
    artifacts: [
      'onnx/audio_encoder_q4f16.onnx', 'onnx/audio_encoder_q4f16.onnx_data',
      'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data',
      'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data',
      'onnx/vision_encoder_q4f16.onnx', 'onnx/vision_encoder_q4f16.onnx_data',
    ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId, revision, path }) })),
    imagePlatform: undefined,
    generate: async () => {
      throw new Error('Metadata completeness does not generate');
    },
  });
}

it('excludes a Gemma processor namespace missing its required processor config before native sessions', async () => {
  const h = await createRuntime();
  try {
    const fs = h.observations.fs;
    fs.enter({ nextPhase: 'fixture-setup', mutationPolicy: 'read-write' });
    for (const [path, bytes] of [...fs.files]) {
      if (!path.startsWith(`${prefix}main/`) || path.endsWith('/processor_config.json')) continue;
      const next = path.replace(`${prefix}main/`, `${prefix}${revision}/`);
      let directory = fs.root;
      for (const part of next.split('/').slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create: true });
      fs.files.set(next, Uint8Array.from(bytes));
    }
    fs.activity.length = 0;
    fs.enter({ nextPhase: 'offline-load', mutationPolicy: 'read-only' });
    await expect(h.service.loadDownloadedModel({ modelId })).resolves.toBeUndefined();
    expect(h.observations.ortCalls).toHaveLength(4);
    expect(h.observations.processors.map(processor => processor.constructor.name)).toEqual(['Gemma4Processor']);
    const modelReads = fs.activity.filter(item => item.operation === 'body-read' && item.path.includes('/onnx/'));
    expect(modelReads.length).toBeGreaterThan(0);
    expect(modelReads.every(item => item.path.startsWith(`${prefix}main/`))).toBe(true);
    expect(h.observations.forbiddenTransport).toEqual([]);
    expect(fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
  } finally {
    await h.close();
  }
}, 30_000);

it('does not promote Gemma optional standalone chat template into a required Load artifact', async () => {
  const h = await createRuntime();
  try {
    h.observations.fs.files.delete(`${prefix}main/chat_template.jinja`);
    await expect(h.service.loadDownloadedModel({ modelId })).resolves.toBeUndefined();
    expect(h.observations.ortCalls).toHaveLength(4);
    expect(h.observations.processors.map(processor => processor.constructor.name)).toEqual(['Gemma4Processor']);
    expect(h.observations.forbiddenTransport).toEqual([]);
    expect(h.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
  } finally {
    await h.close();
  }
}, 30_000);
