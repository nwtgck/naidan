// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { archiveFor, installRawReplay, start } from './harness';
import { modelFixtureIds, readModelFixture, TEST_ONLY } from '@/features/transformers-js/download-verification/fixtures/model-runtime-fixture';

installRawReplay({ evidence: undefined });

describe('checked-in original metadata identity and fail-closed cross-model contracts', () => {
  it('requires available checked-in input and verifies the selected nine-model corpus', async () => {
    expect(() => readModelFixture({ modelId: 'fixture/unknown-model' })).toThrow('No checked-in model fixture');
    expect(() => TEST_ONLY.readRecordedResource({
      directory: new URL('./nonexistent-fixture/', import.meta.url),
      resource: { path: 'tokenizer.json', status: 'recorded', asset: 'tokenizer.json', encoding: 'identity', byteLength: 1, sha256: '0'.repeat(64) },
    })).toThrow();
    // Corpus membership is independent of model behavior and archive ordering.
    const ids = modelFixtureIds();
    expect(ids.sort()).toEqual([
      'HuggingFaceTB/SmolLM2-1.7B-Instruct', 'HuggingFaceTB/SmolLM2-135M-Instruct',
      'LiquidAI/LFM2.5-2.6B-ONNX', 'LiquidAI/LFM2.5-230M-ONNX', 'LiquidAI/LFM2.5-350M-ONNX',
      'onnx-community/gemma-4-E2B-it-ONNX', 'onnx-community/gpt-oss-20b-ONNX',
      'onnx-community/Qwen3.5-2B-ONNX', 'onnx-community/Qwen3.5-4B-ONNX',
    ].sort());
    let fileCount = 0;
    let byteCount = 0;
    for (const modelId of ids) {
      const archive = await archiveFor({ modelId });
      expect(archive.files.has('tokenizer.json')).toBe(true);
      fileCount += archive.files.size;
      byteCount += [...archive.files.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0);
    }
    expect(fileCount).toBe(52);
    expect(byteCount).toBe(116075337);
  });

  it('rejects a wrong revision and an unknown required input without transport or writes', async () => {
    const archive = await archiveFor({ modelId: 'HuggingFaceTB/SmolLM2-1.7B-Instruct' });
    const tracked = await start({ archive, bodyPaths: [] });
    const h = tracked.harness;
    const wrongRevision = `https://huggingface.co/${archive.summary.modelId}/resolve/${'b'.repeat(40)}/tokenizer.json`;
    const unknown = `https://huggingface.co/${archive.summary.modelId}/resolve/${archive.summary.revision}/unknown-required.json`;
    await expect(h.runtime.env.customCache.match(wrongRevision)).rejects.toThrow('revision');
    await expect(h.runtime.env.customCache.match(unknown)).rejects.toThrow('Uncaptured');
    tracked.expectedUnknown.push(wrongRevision, unknown);
    expect(await h.cache.match(wrongRevision)).toBeUndefined();
    expect(await h.cache.match(unknown)).toBeUndefined();
    await expect(h.guardedFetch(unknown)).rejects.toThrow();
  });

  it('removing a real tokenizer body remains a terminal actual-loader failure', async () => {
    const archive = await archiveFor({ modelId: 'HuggingFaceTB/SmolLM2-1.7B-Instruct' });
    archive.files.delete('tokenizer.json');
    const { harness: h } = await start({ archive, bodyPaths: [] });
    await expect(h.runtime.AutoTokenizer.from_pretrained(archive.summary.modelId, { revision: archive.summary.revision, local_files_only: true, progress_callback: () => undefined })).rejects.toThrow(/tokenizer\.json/u);
    expect(h.guardedFetch.mock.calls.map(([input]) => input)).toEqual([`/models/${archive.summary.modelId}/tokenizer.json`]);
    expect(h.sessions).not.toHaveBeenCalled();
  });
});
