import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import capturedCorpus from './model-parsed-metadata-corpus';
import { historicalRepositoryPaths } from './model-historical-evidence-paths';
import { assertCausalMetadataPrepass, cleanupParsedMetadataRequests } from './model-parsed-metadata-requests';

const corpus = z.object({
  schemaVersion: z.literal(1),
  source: z.object({ zipSha256: z.string(), representation: z.literal('parsed-json-not-original-bytes'), note: z.string() }).strict(),
  models: z.array(z.object({
    modelId: z.string(), revision: z.string().regex(/^[a-f0-9]{40}$/u),
    repositoryFiles: z.array(z.object({ path: z.string(), size: z.number().int().nonnegative() }).strict()),
    declarations: z.array(z.object({ path: z.string(), originalByteLength: z.number().int().nonnegative(), value: z.record(z.string(), z.unknown()) }).strict()),
  }).strict()).length(9),
}).strict().parse(capturedCorpus);

describe('parsed metadata corpus provenance', () => {
  it('pins the source ZIP and original upstream bundle underlying the production artifact', () => {
    expect(corpus.source.zipSha256).toBe('41b6073f0a3f0351171304c75ae7954895ddb97deb548839e302cc14c61ef7b0');
    const bundle = readFileSync(resolve(process.cwd(), 'node_modules/@huggingface/transformers/dist/transformers.web.js'));
    expect(createHash('sha256').update(bundle).digest('hex')).toBe('25e0cbdf5df922996299fcd2cf835101ba979b134389a0dcc54f92022ca7e0ff');
    expect(corpus.models.map(model => model.modelId)).toEqual(["HuggingFaceTB/SmolLM2-1.7B-Instruct","HuggingFaceTB/SmolLM2-135M-Instruct","LiquidAI/LFM2.5-2.6B-ONNX","LiquidAI/LFM2.5-230M-ONNX","LiquidAI/LFM2.5-350M-ONNX","onnx-community/gemma-4-E2B-it-ONNX","onnx-community/gpt-oss-20b-ONNX","onnx-community/Qwen3.5-2B-ONNX","onnx-community/Qwen3.5-4B-ONNX"]);
  });

  it('extends the older seven-model corpus without inventing old metadata coverage', () => {
    const olderSchema = z.object({ modelId: z.string(), resolvedRevision: z.string(), modelType: z.string(), architectures: z.array(z.string()), transformersJsConfig: z.record(z.string(), z.unknown()), files: z.array(z.object({ path: z.string() }).passthrough()) }).passthrough();
    const older = Object.values(historicalRepositoryPaths).map(file => olderSchema.parse(JSON.parse(readFileSync(file, 'utf8'))));
    expect(older).toHaveLength(7);
    for (const previous of older) {
      const current = corpus.models.find(model => model.modelId === previous.modelId)!;
      const config = current.declarations.find(file => file.path === 'config.json')!.value;
      expect(current.revision).toBe(previous.resolvedRevision);
      expect(config.model_type).toBe(previous.modelType);
      expect(config.architectures).toEqual(previous.architectures);
      expect(config['transformers.js_config']).toEqual(previous.transformersJsConfig);
      expect(current.repositoryFiles.filter(file => file.path.startsWith('onnx/')).map(file => file.path).sort()).toEqual(previous.files.filter(file => file.path.startsWith('onnx/')).map(file => file.path).sort());
    }
    expect(corpus.models.filter(model => !older.some(previous => previous.modelId === model.modelId)).map(model => model.modelId)).toEqual(['HuggingFaceTB/SmolLM2-1.7B-Instruct', 'LiquidAI/LFM2.5-350M-ONNX']);
  });
});

// Fixed counterexamples must not disappear when the current model route changes.
describe('explicit Causal planner prepass control', () => {
  afterEach(cleanupParsedMetadataRequests);
  it.each(['q4f16', 'q4'] as const)('distinguishes %s progress prepass from actual body consumption', async dtype => {
    const fixture = corpus.models.find(model => model.modelId === 'onnx-community/Qwen3.5-2B-ONNX')!;
    await assertCausalMetadataPrepass({ fixture, dtype, expectedConsumedPaths: [
      `onnx/decoder_model_merged_${dtype}.onnx`, `onnx/decoder_model_merged_${dtype}.onnx_data`,
      `onnx/embed_tokens_${dtype}.onnx`, `onnx/embed_tokens_${dtype}.onnx_data`,
    ] });
  });
});
