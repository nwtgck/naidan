import parsedMetadata from './model-parsed-metadata.evidence.json';
import { assertParsedMetadataModelRequest, cleanupParsedMetadataRequests, parsedMetadataFixtureSchema } from '@/features/transformers-js/replay-models/support/model-parsed-metadata-requests';
// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { archiveFor, assertRawModelSelection, assertRawTokenizer, installRawReplay, jsonBody, start } from '@/features/transformers-js/replay-models/support/model-runtime-input-harness';
import { originalBundledJinjaTemplate } from '../../../../../build/transformers-js-fixes/jinja-template-fixture';

const modelId = 'LiquidAI/LFM2.5-230M-ONNX';
// Fixed model evidence: do not regenerate these expectations to make a failing test pass.
installRawReplay({ evidence: {
  modelId,
  revision: 'c6f46e4e3f885ebcad164d14059a49f90e27eb4d',
  files: {
    // Additional exact-revision inputs used by fresh investigation replay supplements.
    'chat_template.jinja': { sha256: '6d65c8804847ad74eea912dd7eca3dc1cf7a457b53a77f47d841a14121910963', byteLength: 4621 },
    'config.json': { sha256: 'c09361ba08a21a464011710ade1bab1dbe7a9c43eadb70cae04ebb4825ff8233', byteLength: 1668 },
    'tokenizer_config.json': { sha256: 'c46e3f5715c73f7ae9beeeebad8f7187fd647d2de352c3cd01fe250c88d2f960', byteLength: 5347 },
    'generation_config.json': { sha256: '85fa3172f3838eefa602843e3d97fbf532aeb585e0d7fb869dcd17c268e77f45', byteLength: 131 },
    'tokenizer.json': { sha256: 'df1d8d5ec5d091b460562ffd545e4a5e91d17d4a0db7ebe733be34ed374377bd', byteLength: 4733389 },
  },
} });

describe('LFM2.5 230M raw metadata replay', () => {
  it('constructs and encodes with the tokenizer without implying template compatibility', async () => {
    await assertRawTokenizer({ modelId, expectedProcessor: undefined, template: 'construction-only' });
  });

  it('renders the unmodified generation-tag template through the production browser artifact', async () => {
    await assertRawTokenizer({ modelId, expectedProcessor: undefined, template: 'render' });
  });

  it('preserves assistant body and turn delimiters inside the original generation block', async () => {
    const archive = await archiveFor({ modelId });
    const { harness: h } = await start({ archive, bodyPaths: [] });
    const tokenizer = await h.runtime.AutoTokenizer.from_pretrained(modelId, { revision: archive.summary.revision, local_files_only: true, progress_callback: () => undefined });
    const rendered = tokenizer.apply_chat_template([
      { role: 'user', content: 'Hello world' },
      { role: 'assistant', content: 'Original assistant body.' },
    ], { tokenize: false, add_generation_prompt: true });
    expect(rendered).toBe(`\
<|startoftext|><|im_start|>user
Hello world<|im_end|>
<|im_start|>assistant
Original assistant body.<|im_end|>
<|im_start|>assistant
`);
    expect(h.bodyReads).toEqual([]);
    expect(h.sessions).not.toHaveBeenCalled();
    expect(h.guardedFetch).not.toHaveBeenCalled();
  });

  it('retains the original generation-tag failure in the unmodified pinned browser parser', async () => {
    const archive = await archiveFor({ modelId });
    const originalTemplate = z.string().parse(jsonBody({ archive, path: 'tokenizer_config.json' }).chat_template);
    expect(originalTemplate).toMatch(/\{%[- ]*generation\s*[-]?%\}/u);
    const { harness: h } = await start({ archive, bodyPaths: [] });
    const tokenizer = await h.runtime.AutoTokenizer.from_pretrained(modelId, { revision: archive.summary.revision, local_files_only: true, progress_callback: () => undefined });
    expect(tokenizer.encode('Hello world', { add_special_tokens: false }).length).toBeGreaterThan(0);
    const OriginalTemplate = originalBundledJinjaTemplate();
    expect(() => new OriginalTemplate(originalTemplate)).toThrow('Unknown statement type: generation');
    expect(h.sessions).not.toHaveBeenCalled();
    expect(h.guardedFetch).not.toHaveBeenCalled();
  });

  it('observes repository-listed q4 core plus one chunk (not ONNX execution)', async () => {
    await assertRawModelSelection({ modelId, dtype: 'q4', sessions: { model: 1 }, probeOnly: [], expectedMissing: [] });
  });

  it('COUNTERFACTUAL: records absent q4f16 requests using spy-only bytes, not an available candidate', async () => {
    await assertRawModelSelection({
      modelId, dtype: 'q4f16', sessions: { model: 1 }, probeOnly: [],
      expectedMissing: ['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data'],
    });
  });
});

// Independent expectations for parsed metadata; these do not certify original response bytes.
describe('parsed metadata candidate requests', () => {
  afterEach(cleanupParsedMetadataRequests);
  it.each(['q4f16', 'q4'] as const)('replays unmodified config at %s through the expected Production AutoClass', async dtype => {
    await assertParsedMetadataModelRequest({
      fixture: parsedMetadataFixtureSchema.parse(parsedMetadata),
      expected: { modelId: 'LiquidAI/LFM2.5-230M-ONNX', chunks: { q4f16: { model: 1 }, q4: { model: 1 } }, registryExtra: [], missing: ['q4f16'] },
      dtype, expectedAutoClass: 'AutoModelForCausalLM',
    });
  });
});
