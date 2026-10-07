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
  const runner = createBenchmarkRunner({
    now: () => ++calls,
    date: () => '2026-09-27T00:00:00.000Z',
    observeVisibility: () => () => {},
    publish() {},
    createClient: () => {
      let count = 0; return {
        async generate({ request, onDiagnostic }) {
          onDiagnostic?.({ diagnostic: metricFixture({ metric: 'worker-selection', fields: { reusedWorker: count++ > 0, reason: 'fixture' } }) });
          return { png: new Blob(['PNG-test'], { type: 'image/png' }), width: request.parameters.width, height: request.parameters.height, modelVersion: 'fixture', uniformOutput: false };
        },
        async inspectEngine() {
          return { status: 'unavailable', reason: 'unsupported' };
        },
        dispose() {},
        release() {},
        cancel() {},
        updatePreview() {},
      };
    },
  });
  const plan = planFixture({ mode: 'cold-warm', repeats: 2 }); plan.protocol.keepImages = true;
  plan.models[0]!.target.label = '../日本語/duplicate?.gguf'; plan.models[1]!.target.label = '../日本語/duplicate?.gguf';
  plan.models[0]!.request.parameters.prompt = 'private prompt'; plan.models[0]!.request.parameters.negativePrompt = 'private negative';
  plan.models[0]!.request.parameters.bf16WeightType = 'f16'; plan.models[0]!.overrides.bf16WeightType = 'f16';
  plan.models[0]!.request.baseUrl = 'https://host.invalid/?token=do-not-export'; plan.models[0]!.request.models[0]!.sourceId = 'opaque-identity-do-not-export';
  await runner.start({ plan }); return runner.snapshot()!;
}

it('exports validated immutable settings, per-model directories and real PNG bytes; no filename becomes a ZIP path', async () => {
  const snapshot = await snapshotFixture();
  const blob = await benchmarkArchiveBlob({ snapshot, includePrompts: false, includeInputImages: 'omit', exportedAt: '2026-09-27T01:00:00.000Z', signal: new AbortController().signal });
  const zip = await JSZip.loadAsync(await blob.arrayBuffer(), { checkCRC32: true });
  const manifestText = await zip.file('manifest.json')!.async('string');
  const manifest = manifestSchema.parse(JSON.parse(manifestText));
  expect(manifest.models).toHaveLength(2); expect(manifest.runs).toHaveLength(4);
  expect(manifestText).not.toContain('private prompt'); expect(manifestText).not.toContain('private negative'); expect(manifestText).not.toContain('do-not-export');
  expect(manifest.models[0]!.request.artifact.wasmSha256).toHaveLength(64);
  expect(manifest.models.map(model => model.request.parameters.bf16WeightType)).toEqual(['f16', 'f32']);
  expect(manifest.models[0]!.overrideKeys).toContain('bf16WeightType');
  for (const index of [1, 2]) {
    const root = `models/m00${index}`; expect(zip.file(`${root}/settings.json`)).not.toBeNull();
    expect(JSON.parse(await zip.file(`${root}/settings.json`)!.async('string')).request.parameters.bf16WeightType).toBe(index === 1 ? 'f16' : 'f32');
    for (const ri of [1, 2]) {
      expect(await zip.file(`${root}/runs/r00${ri}/result.png`)!.async('string')).toBe('PNG-test');
      expect(await zip.file(`${root}/runs/r00${ri}/diagnostics.jsonl`)!.async('string')).toContain('worker-selection');
    }
  }
  expect(Object.keys(zip.files).some(name => name.includes('..') || name.includes('日本語'))).toBe(false);
});

it('only includes prompts after explicit opt-in and never looks at the live configuration', async () => {
  const snapshot = await snapshotFixture();
  const data = benchmarkManifest({ snapshot, includePrompts: true, includeInputImages: 'omit', exportedAt: 'now' });
  expect(data.models[0]!.request.prompt).toBe('private prompt'); expect(data.models[0]!.request.negativePrompt).toBe('private negative');
  expect(data.protocol.repeats).toBe(2);
});

it('keeps legacy diagnostics readable and records requested adapter strengths without copying weights', async () => {
  const snapshot = await snapshotFixture();
  const before = benchmarkManifest({ snapshot, includePrompts: false, includeInputImages: 'omit', exportedAt: '2026-09-27T00:00:00Z' });
  expect(before.models[0]!.request).not.toHaveProperty('loras');
  expect(manifestSchema.safeParse(before).success).toBe(true);
  const file = new File(['adapter-data'], 'style.safetensors', { lastModified: 42 });
  Object.defineProperty(file, 'arrayBuffer', {
    value: () => {
      throw new Error('Do not read adapter weights for diagnostics');
    },
  });
  snapshot.plan.models[0]!.request.loras = [{ file, path: 'styles/style.safetensors', strength: 0.75 }];
  const after = benchmarkManifest({ snapshot, includePrompts: false, includeInputImages: 'omit', exportedAt: '2026-09-27T00:00:00Z' });
  expect(after.models[0]!.request.loras).toEqual([{ file: { path: 'styles/style.safetensors', bytes: 12, lastModified: 42 }, strength: 0.75 }]);
  expect(after.models[1]!.request).not.toHaveProperty('loras');
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
    Object.defineProperty(member.file, 'arrayBuffer', {
      value: () => {
        throw new Error('weight read');
      },
    });
    Object.defineProperty(member.file, 'stream', {
      value: () => {
        throw new Error('weight read');
      },
    });
  }
  await expect(benchmarkArchiveBlob({ snapshot, includePrompts: false, includeInputImages: 'omit', exportedAt: '2026-09-27T00:00:00Z', signal: new AbortController().signal })).resolves.toBeInstanceOf(Blob);
});

it('settles producer and consumer cancellation without orphaned ZIP work', async () => {
  const snapshot = await snapshotFixture();
  const archive = createBenchmarkArchive({ snapshot, includePrompts: false, includeInputImages: 'omit', exportedAt: '2026-09-27T00:00:00Z' });
  await archive.stream.cancel(new Error('cancel export')); await expect(archive.completed).rejects.toThrow();
  const stop = new AbortController(); stop.abort();
  await expect(benchmarkArchiveBlob({ snapshot, includePrompts: false, includeInputImages: 'omit', exportedAt: '2026-09-27T00:00:00Z', signal: stop.signal })).rejects.toMatchObject({ name: 'AbortError' });
});

it.each(['omit', 'include'] as const)('exports input metadata and original bytes only with explicit include: %s', async inputImages => {
  const snapshot = await snapshotFixture();
  const file = new File(['original input bytes'], '../photo.png', { type: 'image/png', lastModified: 42 });
  snapshot.plan.models[0]!.request.imageInputs = { initImage: file, strength: 0.4, referenceImages: [file] };
  const blob = await benchmarkArchiveBlob({ snapshot, includePrompts: false, includeInputImages: inputImages, exportedAt: '2026-09-27T01:00:00.000Z', signal: new AbortController().signal });
  const zip = await JSZip.loadAsync(await blob.arrayBuffer(), { checkCRC32: true });
  const manifest = manifestSchema.parse(JSON.parse(await zip.file('manifest.json')!.async('string')));
  expect(manifest.models[0]!.request.imageInputs).toMatchObject({ strength: 0.4, initImage: { path: 'photo.png', bytes: 20, mime: 'image/png' }, bytesIncluded: inputImages === 'include' });
  expect(manifest.models[1]!.request).not.toHaveProperty('imageInputs');
  const paths = Object.keys(zip.files).filter(path => path.includes('/inputs/'));
  if (inputImages === 'include') {
    expect(paths).toEqual(['models/m001/inputs/initial-1.png', 'models/m001/inputs/reference-1.png']);
    for (const path of paths) expect(await zip.file(path)!.async('string')).toBe('original input bytes');
    expect(manifest.models[0]!.request.imageInputs!.initImage!.archivePath).toBe(paths[0]);
  } else {
    expect(paths).toEqual([]); expect(manifest.models[0]!.request.imageInputs!.initImage!).not.toHaveProperty('archivePath');
  }
});

it('re-exports the same completed measurement without source images and does not report unused initial-image strength', async () => {
  const snapshot = await snapshotFixture();
  const file = new File(['original photo'], 'photo.png', { type: 'image/png' });
  snapshot.plan.models[0]!.request.imageInputs = { initImage: undefined, strength: 0.75, referenceImages: [file] };
  const originalRecords = JSON.stringify(snapshot.runs.map(run => run.record));
  for (const includeInputImages of ['include', 'omit'] as const) {
    const blob = await benchmarkArchiveBlob({ snapshot, includePrompts: false, includeInputImages, exportedAt: '2026-09-27T01:00:00.000Z', signal: new AbortController().signal });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const manifest = manifestSchema.parse(JSON.parse(await zip.file('manifest.json')!.async('string')));
    expect(manifest.inputImages).toBe(includeInputImages);
    expect(manifest.models[0]!.request.imageInputs).not.toHaveProperty('strength');
    expect(manifest.models[0]!.request.imageInputs!.bytesIncluded).toBe(includeInputImages === 'include');
    expect(zip.file('models/m001/inputs/reference-1.png') !== null).toBe(includeInputImages === 'include');
  }
  expect(snapshot.plan.models[0]!.request.imageInputs.referenceImages[0]).toBe(file);
  expect(JSON.stringify(snapshot.runs.map(run => run.record))).toBe(originalRecords);
});
