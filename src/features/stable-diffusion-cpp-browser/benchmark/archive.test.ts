// @vitest-environment node
import { expect, it } from 'vitest';
import JSZip from 'jszip';
import { benchmarkArchiveBlob, benchmarkManifest, benchmarkAggregate, createBenchmarkArchive } from './archive';
import { createBenchmarkRunner } from './runner';
import { metricFixture, planFixture } from './test-fixtures';
import { manifestSchema } from './types';
import type { BenchmarkSnapshot } from './types';
async function snapshotFixture(): Promise<BenchmarkSnapshot> {
  let calls = 0;
  const runner = createBenchmarkRunner({ now: () => ++calls, date: () => '2026-09-27T00:00:00.000Z', observeVisibility: () => () => {}, publish() {},
    createClient: () => {
      let count = 0; return {
        async generate({ request, onDiagnostic }) {
          onDiagnostic?.({ diagnostic: metricFixture({ metric: 'worker-selection', fields: { reusedWorker: count++ > 0, reason: 'fixture' } }) });
          return { png: new Blob(['PNG-test'], { type: 'image/png' }), width: request.parameters.width, height: request.parameters.height, modelVersion: 'fixture', uniformOutput: false };
        }, dispose() {}, release() {}, cancel() {}, updatePreview() {},
      };
    },
  });
  const plan = planFixture({ mode: 'cold-warm', repeats: 2 }); plan.protocol.keepImages = true;
  plan.models[0]!.target.label = '../日本語/duplicate?.gguf'; plan.models[1]!.target.label = '../日本語/duplicate?.gguf';
  plan.models[0]!.request.parameters.prompt = 'private prompt'; plan.models[0]!.request.parameters.negativePrompt = 'private negative';
  plan.models[0]!.request.baseUrl = 'https://host.invalid/?token=do-not-export'; plan.models[0]!.request.models[0]!.sourceId = 'opaque-identity-do-not-export';
  await runner.start({ plan }); return runner.snapshot()!;
}
it('exports validated immutable settings, per-model directories and real PNG bytes; no filename becomes a ZIP path', async () => {
  const snapshot = await snapshotFixture();
  const blob = await benchmarkArchiveBlob({ snapshot, includePrompts: false, exportedAt: '2026-09-27T01:00:00.000Z', signal: new AbortController().signal });
  const zip = await JSZip.loadAsync(await blob.arrayBuffer(), { checkCRC32: true });
  const manifestText = await zip.file('manifest.json')!.async('string');
  const manifest = manifestSchema.parse(JSON.parse(manifestText));
  expect(manifest.models).toHaveLength(2); expect(manifest.runs).toHaveLength(4);
  expect(manifestText).not.toContain('private prompt'); expect(manifestText).not.toContain('private negative'); expect(manifestText).not.toContain('do-not-export');
  expect(manifest.models[0]!.request.artifact.wasmSha256).toHaveLength(64);
  for (const index of [1,2]) {
    const root = `models/m00${index}`; expect(zip.file(`${root}/settings.json`)).not.toBeNull();
    for (const ri of [1,2]) {
      expect(await zip.file(`${root}/runs/r00${ri}/result.png`)!.async('string')).toBe('PNG-test');
      expect(await zip.file(`${root}/runs/r00${ri}/diagnostics.jsonl`)!.async('string')).toContain('worker-selection');
    }
  }
  expect(Object.keys(zip.files).some(name => name.includes('..') || name.includes('日本語'))).toBe(false);
});
it('only includes prompts after explicit opt-in and never looks at the live configuration', async () => {
  const snapshot = await snapshotFixture();
  const data = benchmarkManifest({ snapshot, includePrompts: true, exportedAt: 'now' });
  expect(data.models[0]!.request.prompt).toBe('private prompt'); expect(data.models[0]!.request.negativePrompt).toBe('private negative');
  expect(data.protocol.repeats).toBe(2);
});
it('aggregates warm and cold separately and excludes missing or mismatched reuse evidence', async () => {
  const snapshot = await snapshotFixture(); snapshot.runs[1]!.record.elapsedMs = 20;
  let aggregate = benchmarkAggregate({ snapshot }); expect(aggregate[0]).toMatchObject({ coldSamples: 1, warmSamples: 1, warmMedianMs: 20 });
  delete snapshot.runs[1]!.record.metrics.reuse;
  aggregate = benchmarkAggregate({ snapshot }); expect(aggregate[0]).toMatchObject({ warmSamples: 0, missingReuseEvidence: 1 }); expect(aggregate[0]!.warmMedianMs).toBeUndefined();
  snapshot.runs[1]!.record.metrics.reuse = { reusedWorker: false, reason: 'unexpected' };
  expect(benchmarkAggregate({ snapshot })[0]!.warmSamples).toBe(0);
});
it('does not reread or hash any model weights for export', async () => {
  const snapshot = await snapshotFixture();
  for (const model of snapshot.plan.models) for (const member of model.request.models) {
    Object.defineProperty(member.file, 'arrayBuffer', { value: () => {
      throw new Error('weight read');
    } });
    Object.defineProperty(member.file, 'stream', { value: () => {
      throw new Error('weight read');
    } });
  }
  await expect(benchmarkArchiveBlob({ snapshot, includePrompts: false, exportedAt: '2026-09-27T00:00:00Z', signal: new AbortController().signal })).resolves.toBeInstanceOf(Blob);
});
it('settles producer and consumer cancellation without orphaned ZIP work', async () => {
  const snapshot = await snapshotFixture();
  const archive = createBenchmarkArchive({ snapshot, includePrompts: false, exportedAt: '2026-09-27T00:00:00Z' });
  await archive.stream.cancel(new Error('cancel export')); await expect(archive.completed).rejects.toThrow();
  const stop = new AbortController(); stop.abort();
  await expect(benchmarkArchiveBlob({ snapshot, includePrompts: false, exportedAt: '2026-09-27T00:00:00Z', signal: stop.signal })).rejects.toMatchObject({ name: 'AbortError' });
});
