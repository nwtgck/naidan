import { File as NodeFile, Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { computed, effectScope } from 'vue';
import JSZip from 'jszip';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { useImageGeneration } from '@/features/image-generation/test-utils/unavailable-image-view';
import { useImageBenchmark } from './use-image-benchmark-hosted';
import { targetFixture } from './benchmark/test-fixtures';
import { manifestSchema } from './benchmark/types';
import type { ImageClient } from './worker/types';

const mocks = vi.hoisted(() => ({ create: vi.fn<() => ImageClient>() }));
vi.mock('./worker/client', () => ({ createImageClient: () => mocks.create() }));
vi.mock('virtual:stable-diffusion-cpp-browser/config', () => ({
  default: {
    kind: 'available',
    sourceCommit: 'a'.repeat(40),
    artifacts: [{
      profile: 'webgpu-wasm32-asyncify',
      modulePath: `stable-diffusion-cpp-runtime/${'a'.repeat(40)}/webgpu-wasm32-asyncify/core.mjs`,
      wasmPath: `stable-diffusion-cpp-runtime/${'a'.repeat(40)}/webgpu-wasm32-asyncify/core.wasm.gz`,
      helpersPath: `stable-diffusion-cpp-runtime/${'a'.repeat(40)}/examples/runtime/index.mjs`,
      schemaSha256: '1'.repeat(64),
      wasmBytes: 8,
      wasmSha256: '0'.repeat(64),
    }],
  },
}));

let scope: ReturnType<typeof effectScope> | undefined;
let downloads: Blob[];
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  // The archive uses standard Blob streams, which jsdom does not implement.
  vi.stubGlobal('File', NodeFile);
  vi.stubGlobal('Blob', NodeBlob);
  downloads = [];
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = vi.fn((blob: Blob) => {
      downloads.push(blob); return 'blob:benchmark-archive';
    });
    static override revokeObjectURL = vi.fn();
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  mocks.create.mockReset();
  mocks.create.mockImplementation(() => ({
    async generate({ request }) {
      return {
        png: new Blob(['PNG'], { type: 'image/png' }),
        width: request.parameters.width,
        height: request.parameters.height,
        modelVersion: 'synthetic',
        uniformOutput: false,
      };
    },
    async inspectEngine() {
      return { status: 'unavailable', reason: 'unsupported' };
    },
    dispose() {},
    release() {},
    cancel() {},
    updatePreview() {},
  }));
});
afterEach(() => {
  scope?.stop(); scope = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function setup() {
  const generation = useImageGeneration();
  generation.supported = computed(() => true);
  generation.formDisabled = computed(() => generation.historyActions.busy.value || generation.historySaving.status.value === 'saving');
  generation.library.benchmarkTargets = () => [targetFixture({ id: 'a' })];
  generation.acquireBenchmark = () => true;
  scope = effectScope();
  const bench = scope.run(() => useImageBenchmark({ generation }));
  if (!bench) throw new Error('Expected an active benchmark scope');
  bench.protocol.value = { ...bench.protocol.value, cooldownSeconds: 0, repeats: 1 };
  const file = new File(['original input'], 'input.png', { type: 'image/png' });
  const stream = vi.spyOn(file, 'stream').mockImplementation(() => {
    throw new DOMException('Input file became unreadable', 'NotReadableError');
  });
  bench.chooseImageInputs({ targetId: 'a', inputs: { initImage: file, strength: 0.5, referenceImages: [] } });
  bench.includeInputImages.value = 'include';
  return { bench, stream, generation };
}

async function exportedManifest() {
  const blob = downloads.at(-1);
  if (!blob) throw new Error('Expected a downloaded benchmark ZIP');
  const zip = await JSZip.loadAsync(Buffer.from(await blob.arrayBuffer()), { checkCRC32: true });
  const entry = zip.file('manifest.json');
  if (!entry) throw new Error('Expected the benchmark manifest');
  return manifestSchema.parse(JSON.parse(await entry.async('string')));
}

it.each(['reuse', 'save'])('waits for the current history %s before acquiring the generation owner', async action => {
  const { bench, generation } = setup();
  const acquire = vi.spyOn(generation, 'acquireBenchmark');
  if (action === 'reuse') generation.historyActions.busy.value = true;
  else generation.historySaving.status.value = 'saving';
  expect(bench.canStart.value).toBe(false);
  await bench.start();
  expect(acquire).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
  expect(bench.runs.value).toEqual([]);

  generation.historyActions.busy.value = false;
  generation.historySaving.status.value = 'idle';
  expect(bench.canStart.value).toBe(true);
  await bench.start();
  expect(acquire).toHaveBeenCalledOnce();
  expect(mocks.create).toHaveBeenCalledOnce();
  expect(bench.runs.value[0]?.record.status).toBe('succeeded');
});

it('clears an obsolete archive error when export succeeds after omitting unreadable input images', async () => {
  const { bench } = setup();
  await bench.start();
  await bench.download();
  expect(bench.error.value).toContain('Input file became unreadable');
  expect(bench.exporting.value).toBe(false);
  expect(bench.feedback.value).toBe('');
  expect(downloads).toHaveLength(0);

  bench.includeInputImages.value = 'omit';
  await bench.download();
  expect(bench.error.value).toBe('');
  expect(bench.feedback.value).not.toBe('');
  expect(bench.exporting.value).toBe(false);
  expect(mocks.create).toHaveBeenCalledOnce();
  expect((await exportedManifest()).runs[0]?.status).toBe('succeeded');
});

it('reports a new archive failure on retry and preserves failed generation records after a successful export', async () => {
  mocks.create.mockImplementation(() => ({
    async generate() {
      throw new Error('Synthetic inference failed');
    },
    async inspectEngine() {
      return { status: 'unavailable', reason: 'unsupported' };
    },
    dispose() {},
    release() {},
    cancel() {},
    updatePreview() {},
  }));
  const { bench, stream } = setup();
  await bench.start();
  const original = structuredClone(bench.runs.value.map(run => run.record));
  expect(original[0]).toMatchObject({ status: 'failed', error: 'Synthetic inference failed' });
  await bench.download();
  expect(bench.error.value).toContain('Input file became unreadable');

  stream.mockImplementation(() => {
    throw new DOMException('Input file permission was revoked', 'NotAllowedError');
  });
  await bench.download();
  expect(bench.error.value).toContain('Input file permission was revoked');
  expect(bench.feedback.value).toBe('');
  expect(downloads).toHaveLength(0);

  bench.includeInputImages.value = 'omit';
  await bench.download();
  expect(bench.error.value).toBe('');
  expect(bench.runs.value.map(run => run.record)).toEqual(original);
  expect((await exportedManifest()).runs).toEqual(original);
  expect(mocks.create).toHaveBeenCalledOnce();
});
