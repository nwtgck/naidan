import { describe, expect, it } from 'vitest';
import { archiveFor, installRawReplay, rawSource, start } from './harness';
import { openRawZip } from './helpers';

installRawReplay({ evidence: undefined });

describe('raw Evidence ZIP identity and fail-closed cross-model contracts', () => {
  it('requires explicit input and verifies exactly nine models and 52 raw files', async () => {
    await expect(openRawZip({ inputPath: undefined })).rejects.toThrow('requires NAIDAN_REPLAY_ZIP');
    // Batch provenance is separate from each independently selectable model test.
    expect(rawSource().zipSha256).toBe('edb14c44a251ef15d422d13dd4a7dc40b39db1d1cbe5f58982cb406c48ee30e3');
    expect(rawSource().batch.targetCount).toBe(9);
    expect(rawSource().batch.packagedModelCount).toBe(9);
    const ids = rawSource().batch.targets.map(target => target.target);
    expect(ids).toEqual([
      'HuggingFaceTB/SmolLM2-1.7B-Instruct', 'HuggingFaceTB/SmolLM2-135M-Instruct',
      'LiquidAI/LFM2.5-2.6B-ONNX', 'LiquidAI/LFM2.5-230M-ONNX', 'LiquidAI/LFM2.5-350M-ONNX',
      'onnx-community/gemma-4-E2B-it-ONNX', 'onnx-community/gpt-oss-20b-ONNX',
      'onnx-community/Qwen3.5-2B-ONNX', 'onnx-community/Qwen3.5-4B-ONNX',
    ]);
    let fileCount = 0;
    let byteCount = 0;
    for (const modelId of ids) {
      const archive = await archiveFor({ modelId });
      expect(archive.summary.status).toBe('complete');
      expect(archive.files.has('tokenizer.json')).toBe(true);
      fileCount += archive.files.size;
      byteCount += [...archive.files.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0);
    }
    expect(fileCount).toBe(52);
    expect(byteCount).toBe(116075337);
  });

  it('rejects a wrong revision and an unknown required input without transport or writes', async () => {
    const archive = await archiveFor({ modelId: rawSource().batch.targets[0]!.target });
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
    const archive = await archiveFor({ modelId: rawSource().batch.targets[0]!.target });
    archive.files.delete('tokenizer.json');
    const { harness: h } = await start({ archive, bodyPaths: [] });
    await expect(h.runtime.AutoTokenizer.from_pretrained(archive.summary.modelId, { revision: archive.summary.revision, local_files_only: true, progress_callback: () => undefined })).rejects.toThrow(/tokenizer\.json/u);
    expect(h.guardedFetch.mock.calls.map(([input]) => input)).toEqual([`/models/${archive.summary.modelId}/tokenizer.json`]);
    expect(h.sessions).not.toHaveBeenCalled();
  });
});
