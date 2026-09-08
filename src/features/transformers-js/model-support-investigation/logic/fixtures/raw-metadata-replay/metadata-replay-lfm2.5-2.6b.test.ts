import { describe, it } from 'vitest';
import { assertRawModelSelection, assertRawTokenizer, installRawReplay } from './harness';

const modelId = 'LiquidAI/LFM2.5-2.6B-ONNX';
// Fixed model evidence: do not regenerate these expectations to make a failing test pass.
installRawReplay({ evidence: {
  modelId,
  revision: '66826372fd4fa166f53be0371c9315745c07cace',
  files: {
    'config.json': { sha256: '3df9ebb278bf43eddd8a240086449f197976a1783d6c4d2bfe9eaec4920f4184', byteLength: 1728 },
    'tokenizer_config.json': { sha256: 'cf46c3cdb18cf88542ee0d5d2afd98d78b3eeffd0e6d00a26f8b76800ff9a446', byteLength: 6063 },
    'generation_config.json': { sha256: 'e5e1e91829a9ae65809b578bff350dca876febbda88a9e36f415b002f6b3ddf0', byteLength: 146 },
    'chat_template.jinja': { sha256: '8ea15224003c2e89a1ac8d3b0a3362e8e587896f2bcc41df5dcc2d9c5d0ee82c', byteLength: 5404 },
    'tokenizer.json': { sha256: '695be7802a0e4b8a81048f0ff5ebb7fc811a0ba5a6be63dbb24deb5a81096f41', byteLength: 17905598 },
  },
} });

describe('LFM2.5 2.6B raw metadata replay', () => {
  it('constructs the tokenizer and renders its original template', async () => {
    await assertRawTokenizer({ modelId, expectedProcessor: undefined, template: 'render' });
  });

  it('observes repository-listed q4f16 core plus two chunks (not ONNX execution)', async () => {
    await assertRawModelSelection({ modelId, dtype: 'q4f16', sessions: { model: 2 }, probeOnly: [], expectedMissing: [] });
  });

  it('observes repository-listed q4 core plus one chunk (not ONNX execution)', async () => {
    await assertRawModelSelection({ modelId, dtype: 'q4', sessions: { model: 1 }, probeOnly: [], expectedMissing: [] });
  });
});
