import parsedMetadata from './model-parsed-metadata.evidence.json';
import { assertParsedMetadataModelRequest, cleanupParsedMetadataRequests, parsedMetadataFixtureSchema } from '@/features/transformers-js/replay-models/support/model-parsed-metadata-requests';
// @vitest-environment node
import { afterEach, describe, it } from 'vitest';
import { assertRawModelSelection, assertRawTokenizer, installRawReplay } from '@/features/transformers-js/replay-models/support/model-runtime-input-harness';

const modelId = 'onnx-community/gemma-4-E2B-it-ONNX';
// Fixed model evidence: do not regenerate these expectations to make a failing test pass.
installRawReplay({ evidence: {
  modelId,
  revision: '9f4bef82ea6e296bc69f8a2f5939f73af81b07a6',
  files: {
    'config.json': { sha256: '5494e6677d9e150ea20ba3101ae8a32b0f141004626f052725d8bf48991b9faa', byteLength: 5549 },
    'tokenizer_config.json': { sha256: '06afbf54e228050cba79c4a0afd83543cc89070a2d62b8337d0aa8b4cdc348c3', byteLength: 18807 },
    'generation_config.json': { sha256: 'e6a0b50de21a511f15ac4857b7f227f68ee60ecb1f11255d07b75e0bdc60e155', byteLength: 238 },
    'processor_config.json': { sha256: '32bdf45d2ad4cc29a0822ddd157a182de76644f0419a6228d151495256e9813c', byteLength: 1689 },
    'preprocessor_config.json': { sha256: '4457c6e8a09070d7d5d1cd983fbfb67ebafe602bd98120c3543a024f5d07056b', byteLength: 43 },
    'chat_template.jinja': { sha256: '781d10940fbc44be40064b5d43a056fc486c84ceaa55538226368b57314132bf', byteLength: 16317 },
    'tokenizer.json': { sha256: '47bd35616c7c782aaca6ccf48c75f3461d5877170984b8836b375107d0a9f566', byteLength: 19439251 },
  },
} });

describe('gemma4-e2b raw metadata replay', () => {
  it('constructs the Production tokenizer/processor and renders its original template', async () => {
    await assertRawTokenizer({ modelId, expectedProcessor: { processor: 'Gemma4Processor', image: 'Gemma4ImageProcessor', audio: 'Gemma4AudioFeatureExtractor' }, template: 'render' });
  });

  it.each(['q4f16', 'q4'] as const)('observes repository-listed %s paths without real ONNX execution', async dtype => {
    await assertRawModelSelection({
      modelId, dtype, sessions: { audio_encoder: 1, decoder_model_merged: 1, embed_tokens: 1, vision_encoder: 1 },
      probeOnly: [], expectedMissing: [],
    });
  });
});

// Independent expectations for parsed metadata; these do not certify original response bytes.
describe('parsed metadata candidate requests', () => {
  afterEach(cleanupParsedMetadataRequests);
  it.each(['q4f16', 'q4'] as const)('replays unmodified config at %s through the expected Production AutoClass', async dtype => {
    await assertParsedMetadataModelRequest({
      fixture: parsedMetadataFixtureSchema.parse(parsedMetadata),
      expected: { modelId: 'onnx-community/gemma-4-E2B-it-ONNX', chunks: { q4f16: { audio_encoder: 1, decoder_model_merged: 1, embed_tokens: 1, vision_encoder: 1 }, q4: { audio_encoder: 1, decoder_model_merged: 1, embed_tokens: 1, vision_encoder: 1 } }, registryExtra: [], missing: [] },
      dtype, expectedAutoClass: 'AutoModelForImageTextToText',
    });
  });
});
