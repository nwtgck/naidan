import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import capturedCorpus from './fixtures/replay-metadata-corpus.json';
import { collectReplayMetadata, REPLAY_METADATA_PATHS, REPLAY_METADATA_TARGET_BYTES } from './collect-replay-metadata';
import { createInitialInvestigationCheckpoint } from './investigation-recovery';
import { runInvestigationTargetsSequentially } from './run-investigation-targets-sequentially';

const corpus = z.object({
  schemaVersion: z.literal(1),
  source: z.object({ zipSha256: z.string(), representation: z.literal('parsed-json-not-original-bytes'), note: z.string() }).strict(),
  models: z.array(z.object({
    modelId: z.string(),
    revision: z.string().regex(/^[a-f0-9]{40}$/u),
    repositoryFiles: z.array(z.object({ path: z.string(), size: z.number().int().nonnegative() }).strict()),
    declarations: z.array(z.object({ path: z.string(), originalByteLength: z.number().int().nonnegative(), value: z.record(z.string(), z.unknown()) }).strict()),
  }).strict()).length(9),
}).strict().parse(capturedCorpus);
type ModelFixture = typeof corpus.models[number];

beforeEach(() => {
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('External internet is forbidden in replay corpus tests');
  }));
});
afterEach(() => vi.unstubAllGlobals());

async function replay({ fixture, configVariant }: { fixture: ModelFixture, configVariant: 'captured' | 'invalid' }) {
  // Historical Evidence retained parsed JSON, not raw response bytes. Match the
  // fixture transport to reserialized bytes; never reuse the original size/hash
  // as though this were a byte-for-byte repository replay.
  const bodies = new Map(fixture.declarations.map(file => [file.path, new Blob([
    file.path === 'config.json' && configVariant === 'invalid' ? '{' : JSON.stringify(file.value),
  ])]));
  const localRead = vi.fn(async ({ path, revision }: { path: string, revision: string }) => {
    expect(revision).toBe(fixture.revision);
    expect(REPLAY_METADATA_PATHS).toContain(path);
    return bodies.get(path);
  });
  const result = await collectReplayMetadata({
    modelId: fixture.modelId,
    revision: fixture.revision,
    files: fixture.repositoryFiles.map(file => ({ path: file.path, size: bodies.get(file.path)?.size ?? file.size })),
    budgetBytes: REPLAY_METADATA_TARGET_BYTES,
    fileTimeoutMs: 5_000,
    modelAccess: 'public-request',
    localRead,
    remoteFetch: undefined,
    onSnapshot: () => undefined,
  });
  expect(fetch).not.toHaveBeenCalled();
  return result;
}

describe('nine-model historical metadata replay corpus', () => {
  it('includes successful small and large models alongside the observed problematic families', () => {
    expect(corpus.models.map(model => model.modelId)).toEqual([
      'HuggingFaceTB/SmolLM2-1.7B-Instruct',
      'HuggingFaceTB/SmolLM2-135M-Instruct',
      'LiquidAI/LFM2.5-2.6B-ONNX',
      'LiquidAI/LFM2.5-230M-ONNX',
      'LiquidAI/LFM2.5-350M-ONNX',
      'onnx-community/gemma-4-E2B-it-ONNX',
      'onnx-community/gpt-oss-20b-ONNX',
      'onnx-community/Qwen3.5-2B-ONNX',
      'onnx-community/Qwen3.5-4B-ONNX',
    ]);
    expect(corpus.source.zipSha256).toBe('41b6073f0a3f0351171304c75ae7954895ddb97deb548839e302cc14c61ef7b0');
  });

  it.each(corpus.models)('collects every captured declaration for $modelId without inventing absent tokenizer bodies', async fixture => {
    const result = await replay({ fixture, configVariant: 'captured' });
    expect(result.sidecars.map(file => file.path).sort()).toEqual(fixture.declarations.map(file => file.path).sort());
    for (const sidecar of result.sidecars) {
      expect(JSON.parse(await sidecar.blob.text())).toEqual(fixture.declarations.find(file => file.path === sidecar.path)?.value);
    }
    expect(result.summary.status).toBe('partial');
    expect(result.summary.files.find(file => file.path === 'tokenizer.json')?.status).not.toBe('collected');
    expect(result.summary.retainedBytes).toBeLessThan(REPLAY_METADATA_TARGET_BYTES);
  });

  it('keeps processing all nine models after one fixture produces invalid metadata', async () => {
    const executions = await runInvestigationTargetsSequentially({
      targets: corpus.models.map(model => model.modelId),
      runTarget: async ({ target }) => {
        const fixture = corpus.models.find(model => model.modelId === target);
        if (fixture === undefined) throw new Error(`Missing fixture: ${target}`);
        const result = await replay({ fixture, configVariant: target === 'LiquidAI/LFM2.5-230M-ONNX' ? 'invalid' : 'captured' });
        const checkpoint = createInitialInvestigationCheckpoint({ modelId: target, runId: `fixture-${target}`, now: () => '2026-09-08T00:00:00.000Z' });
        // This status is only a metadata-fixture check, never model Load acceptance.
        const configCollected = result.summary.files.some(file => file.path === 'config.json' && file.status === 'collected');
        return { ...checkpoint.run, replayMetadata: result.summary, status: configCollected ? 'passed' as const : 'failed' as const };
      },
      onUpdate: () => undefined,
      shouldInterrupt: () => false,
      takeSkipRequest: () => false,
      recoverRunAfterError: () => undefined,
    });
    expect(executions).toHaveLength(9);
    expect(executions.map(execution => execution.status)).toEqual(['passed', 'passed', 'passed', 'failed', 'passed', 'passed', 'passed', 'passed', 'passed']);
  });
});
