// @vitest-environment node
import { describe, it } from 'vitest';
import { assertRawModelSelection, assertRawTokenizer, installRawReplay } from './harness';

const modelId = 'onnx-community/Qwen3.5-4B-ONNX';
// Fixed model evidence: do not regenerate these expectations to make a failing test pass.
installRawReplay({ evidence: {
  modelId,
  revision: '74d8caba2117fd5f41d655e9cc27eda1338662b3',
  files: {
    // Additional exact-revision inputs used by fresh investigation replay supplements.
    'chat_template.jinja': { sha256: 'a4aee8afcf2e0711942cf848899be66016f8d14a889ff9ede07bca099c28f715', byteLength: 7756 },
    'config.json': { sha256: 'c6f9834460177e3821e035900320fa24bd11ad1c9f14bfe2e78e4398e38c4937', byteLength: 3198 },
    'tokenizer_config.json': { sha256: '2de621ec071dd61438efdd6d0183bd3d612e98d05ac10d19ed75f1fef9299bc9', byteLength: 9162 },
    'generation_config.json': { sha256: 'dc0cbe66543f310896469b7b1448af792f403293a1080baaf04d586c57b23e48', byteLength: 248 },
    'processor_config.json': { sha256: '14932921ca485d458a04dafd8069fbb0a4505622a48208d19ed247115801385b', byteLength: 1300 },
    'preprocessor_config.json': { sha256: '6a970fd06f30e6943b3e2c14d5d3b42d49b06cf99b99103d56689bef462d90f8', byteLength: 336 },
    'tokenizer.json': { sha256: '89da80cc6689bef4d90cc1028249436975ffb0814618f1d93c65310e05801a9b', byteLength: 19226111 },
  },
} });

describe('qwen3.5-4b raw metadata replay', () => {
  it('constructs the Production tokenizer/processor and renders its original template', async () => {
    await assertRawTokenizer({ modelId, expectedProcessor: { processor: 'Qwen3VLProcessor', image: 'Qwen2VLImageProcessor', audio: undefined }, template: 'render' });
  });

  it.each(['q4f16', 'q4'] as const)('observes repository-listed %s paths without real ONNX execution', async dtype => {
    await assertRawModelSelection({
      modelId, dtype, sessions: { decoder_model_merged: 2, embed_tokens: 1 },
      probeOnly: [`onnx/vision_encoder_${dtype}.onnx`, `onnx/vision_encoder_${dtype}.onnx_data`], expectedMissing: [],
    });
  });
});
