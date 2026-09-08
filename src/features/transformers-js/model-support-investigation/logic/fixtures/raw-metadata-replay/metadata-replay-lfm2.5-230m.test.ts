import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { archiveFor, assertRawModelSelection, assertRawTokenizer, installRawReplay, jsonBody, start } from './harness';

const modelId = 'LiquidAI/LFM2.5-230M-ONNX';
// Fixed model evidence: do not regenerate these expectations to make a failing test pass.
installRawReplay({ evidence: {
  modelId,
  revision: 'c6f46e4e3f885ebcad164d14059a49f90e27eb4d',
  files: {
    'config.json': { sha256: 'c09361ba08a21a464011710ade1bab1dbe7a9c43eadb70cae04ebb4825ff8233', byteLength: 1668 },
    'tokenizer_config.json': { sha256: 'c46e3f5715c73f7ae9beeeebad8f7187fd647d2de352c3cd01fe250c88d2f960', byteLength: 5347 },
    'generation_config.json': { sha256: '85fa3172f3838eefa602843e3d97fbf532aeb585e0d7fb869dcd17c268e77f45', byteLength: 131 },
    'chat_template.jinja': { sha256: '6d65c8804847ad74eea912dd7eca3dc1cf7a457b53a77f47d841a14121910963', byteLength: 4621 },
    'tokenizer.json': { sha256: 'df1d8d5ec5d091b460562ffd545e4a5e91d17d4a0db7ebe733be34ed374377bd', byteLength: 4733389 },
  },
} });

describe('LFM2.5 230M raw metadata replay', () => {
  it('constructs and encodes with the tokenizer without implying template compatibility', async () => {
    await assertRawTokenizer({ modelId, expectedProcessor: undefined, template: 'construction-only' });
  });

  it('rejects the original generation template tag in the pinned TJS parser', async () => {
    const archive = await archiveFor({ modelId });
    const originalTemplate = z.string().parse(jsonBody({ archive, path: 'tokenizer_config.json' }).chat_template);
    expect(originalTemplate).toMatch(/\{%[- ]*generation\s*[-]?%\}/u);
    const { harness: h } = await start({ archive, bodyPaths: [] });
    const tokenizer = await h.runtime.AutoTokenizer.from_pretrained(modelId, { revision: archive.summary.revision, local_files_only: true, progress_callback: () => undefined });
    expect(tokenizer.encode('Hello world', { add_special_tokens: false }).length).toBeGreaterThan(0);
    expect(() => tokenizer.apply_chat_template([{ role: 'user', content: 'Hello world' }], { tokenize: false, add_generation_prompt: true })).toThrow('Unknown statement type: generation');
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
