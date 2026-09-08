import { describe, it } from 'vitest';
import { assertRawModelSelection, assertRawTokenizer, installRawReplay } from './harness';

const modelId = 'LiquidAI/LFM2.5-350M-ONNX';
// Fixed model evidence: do not regenerate these expectations to make a failing test pass.
installRawReplay({ evidence: {
  modelId,
  revision: 'd11593fd9eb408e322667926656598896c2d5ff9',
  files: {
    'config.json': { sha256: '544d8d604bacf4cb89383c49c9a54621afa26a6741f3f55fd8b840ca1d640419', byteLength: 1443 },
    'tokenizer_config.json': { sha256: '95c85d0860d06c9529345f386004e8e67743375b15c5d39e9f46427d8977577b', byteLength: 3269 },
    'generation_config.json': { sha256: '94bfac0e1c207691baf4e172389a8efb114f8b60eb3a5c07a2f418aefa8f8bb6', byteLength: 136 },
    'chat_template.jinja': { sha256: '013eed60546434b6967e3483153d8c5c37abcb1d667f8b1f914683f2a9411531', byteLength: 2553 },
    'tokenizer.json': { sha256: '29d43b4be8e8a896fefd7cd836ca6d6b4eedd249f823866ce0453b368e646f49', byteLength: 3297793 },
  },
} });

describe('lfm2.5-350m raw metadata replay', () => {
  it('constructs the Production tokenizer/processor and renders its original template', async () => {
    await assertRawTokenizer({ modelId, expectedProcessor: undefined, template: 'render' });
  });

  it.each(['q4f16', 'q4'] as const)('observes repository-listed %s paths without real ONNX execution', async dtype => {
    await assertRawModelSelection({
      modelId, dtype, sessions: { model: 1 },
      probeOnly: [], expectedMissing: [],
    });
  });
});
