// @vitest-environment node
import { describe, it } from 'vitest';
import { assertRawModelSelection, assertRawTokenizer, installRawReplay } from './harness';

const modelId = 'onnx-community/Qwen3.5-2B-ONNX';
// Fixed model evidence: do not regenerate these expectations to make a failing test pass.
installRawReplay({ evidence: {
  modelId,
  revision: 'b1fc7ca3afafcb8e4b13d29715a6b9ea5af1d1cb',
  files: {
    // Additional exact-revision inputs used by fresh investigation replay supplements.
    'chat_template.jinja': { sha256: '273d8e0e683b885071fb17e08d71e5f2a5ddfb5309756181681de4f5a1822d80', byteLength: 7755 },
    'config.json': { sha256: 'b028de63b0ed8b37107acaaf1475d40d6d4feb5721153674e7d1d0bdbfd0f258', byteLength: 2993 },
    'tokenizer_config.json': { sha256: 'fccbff64ebe09343aa2171028657f5b038db96fb4f657609bc76743eddfa3b9d', byteLength: 9161 },
    'generation_config.json': { sha256: 'dc0cbe66543f310896469b7b1448af792f403293a1080baaf04d586c57b23e48', byteLength: 248 },
    'processor_config.json': { sha256: '14932921ca485d458a04dafd8069fbb0a4505622a48208d19ed247115801385b', byteLength: 1300 },
    'preprocessor_config.json': { sha256: '6a970fd06f30e6943b3e2c14d5d3b42d49b06cf99b99103d56689bef462d90f8', byteLength: 336 },
    'tokenizer.json': { sha256: '89da80cc6689bef4d90cc1028249436975ffb0814618f1d93c65310e05801a9b', byteLength: 19226111 },
  },
} });

describe('qwen3.5-2b raw metadata replay', () => {
  it('constructs the Production tokenizer/processor and renders its original template', async () => {
    await assertRawTokenizer({ modelId, expectedProcessor: { processor: 'Qwen3VLProcessor', image: 'Qwen2VLImageProcessor', audio: undefined }, template: 'render' });
  });

  it.each(['q4f16', 'q4'] as const)('observes repository-listed %s paths without real ONNX execution', async dtype => {
    await assertRawModelSelection({
      modelId, dtype, sessions: { decoder_model_merged: 1, embed_tokens: 1 },
      probeOnly: [`onnx/vision_encoder_${dtype}.onnx`, `onnx/vision_encoder_${dtype}.onnx_data`], expectedMissing: [],
    });
  });
});
