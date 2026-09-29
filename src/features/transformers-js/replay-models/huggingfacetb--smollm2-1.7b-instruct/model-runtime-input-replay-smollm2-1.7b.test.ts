import parsedMetadata from './model-parsed-metadata.evidence.json';
import { assertParsedMetadataModelRequest, cleanupParsedMetadataRequests, parsedMetadataFixtureSchema } from '@/features/transformers-js/replay-models/support/model-parsed-metadata-requests';
// @vitest-environment node
import { afterEach, describe, it } from 'vitest';
import { assertRawModelSelection, assertRawTokenizer, installRawReplay } from '@/features/transformers-js/replay-models/support/model-runtime-input-harness';

const modelId = 'HuggingFaceTB/SmolLM2-1.7B-Instruct';
// Fixed model evidence: do not regenerate these expectations to make a failing test pass.
installRawReplay({ evidence: {
  modelId,
  revision: '31b70e2e869a7173562077fd711b654946d38674',
  files: {
    // Additional exact-revision inputs used by fresh investigation replay supplements.
    'special_tokens_map.json': { sha256: '2b7379f3ae813529281a5c602bc5a11c1d4e0a99107aaa597fe936c1e813ca52', byteLength: 655 },
    'config.json': { sha256: '994f50b16abb4ae00880baefe03c10260b5bd608d2bf586f7056ca05a534feea', byteLength: 908 },
    'tokenizer_config.json': { sha256: '4ec77d44f62efeb38d7e044a1db318f6a939438425312dfa333b8382dbad98df', byteLength: 3764 },
    'generation_config.json': { sha256: '87b916edaaab66b3899b9d0dd0752727dff6666686da0504d89ae0a6e055a013', byteLength: 132 },
    'tokenizer.json': { sha256: '9ca9acddb6525a194ec8ac7a87f24fbba7232a9a15ffa1af0c1224fcd888e47c', byteLength: 2104556 },
  },
} });

describe('smollm2-1.7b raw metadata replay', () => {
  it('constructs the Production tokenizer/processor and renders its original template', async () => {
    await assertRawTokenizer({ modelId, expectedProcessor: undefined, template: 'render' });
  });

  it.each(['q4f16', 'q4'] as const)('observes repository-listed %s paths without real ONNX execution', async dtype => {
    await assertRawModelSelection({
      modelId, dtype, sessions: { model: 0 },
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
      expected: { modelId: 'HuggingFaceTB/SmolLM2-1.7B-Instruct', chunks: { q4f16: { model: 0 }, q4: { model: 0 } }, registryExtra: [], missing: [] },
      dtype, expectedAutoClass: 'AutoModelForCausalLM',
    });
  });
});
