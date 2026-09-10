import parsedMetadata from './model-parsed-metadata.evidence.json';
import { assertParsedMetadataModelRequest, cleanupParsedMetadataRequests, parsedMetadataFixtureSchema } from '@/features/transformers-js/replay-models/support/model-parsed-metadata-requests';
// @vitest-environment node
import { afterEach, describe, it } from 'vitest';
import { assertRawModelSelection, assertRawTokenizer, installRawReplay } from '@/features/transformers-js/replay-models/support/model-runtime-input-harness';

const modelId = 'onnx-community/gpt-oss-20b-ONNX';
// Fixed model evidence: do not regenerate these expectations to make a failing test pass.
installRawReplay({ evidence: {
  modelId,
  revision: '6dcc680ae66791268a1e4e96fc3bfd0e5d3662e7',
  files: {
    // Additional exact-revision inputs used by fresh investigation replay supplements.
    'special_tokens_map.json': { sha256: '9ee667e324910c037718c9251f2ec97cec5530b6789a52a4d95328e61f110512', byteLength: 463 },
    'chat_template.jinja': { sha256: 'e381f0b98be3c3714676ec4102bc75a885d75b9002feb02fb6f25ad0e641bce3', byteLength: 16330 },
    'config.json': { sha256: 'dc54cf872c059cb8f510f38770176b29211d1d83a9bebb7de0d759fe77d80948', byteLength: 2096 },
    'tokenizer_config.json': { sha256: '0b27d36b62a2a939e5f8e52ebb1798be181a5f8b35685f81c142b14690d3d4b4', byteLength: 20918 },
    'generation_config.json': { sha256: '912bb474f36eb600f91a5a32f70f5dd2534313423adfc3d6726cb123e3b1de9d', byteLength: 175 },
    'tokenizer.json': { sha256: '0614fe83cadab421296e664e1f48f4261fa8fef6e03e63bb75c20f38e37d07d3', byteLength: 27868174 },
  },
} });

describe('GPT-OSS 20B raw metadata replay', () => {
  it('constructs the tokenizer and renders its original template', async () => {
    await assertRawTokenizer({ modelId, expectedProcessor: undefined, template: 'render' });
  });

  it('observes repository-listed q4f16 core plus seven chunks (not ONNX execution)', async () => {
    await assertRawModelSelection({ modelId, dtype: 'q4f16', sessions: { model: 7 }, probeOnly: [], expectedMissing: [] });
  });

  it('COUNTERFACTUAL: records the absent q4 request using spy-only bytes, not an available candidate', async () => {
    await assertRawModelSelection({ modelId, dtype: 'q4', sessions: { model: 0 }, probeOnly: [], expectedMissing: ['onnx/model_q4.onnx'] });
  });
});

// Independent expectations for parsed metadata; these do not certify original response bytes.
describe('parsed metadata candidate requests', () => {
  afterEach(cleanupParsedMetadataRequests);
  it.each(['q4f16', 'q4'] as const)('replays unmodified config at %s through the expected Production AutoClass', async dtype => {
    await assertParsedMetadataModelRequest({
      fixture: parsedMetadataFixtureSchema.parse(parsedMetadata),
      expected: { modelId: 'onnx-community/gpt-oss-20b-ONNX', chunks: { q4f16: { model: 7 }, q4: { model: 0 } }, registryExtra: [], missing: ['q4'] },
      dtype, expectedAutoClass: 'AutoModelForCausalLM',
    });
  });
});
