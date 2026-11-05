import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { readWorkflowImageFile, validateWorkflowImageDimensions } from './image-files';
import { readWorkflowBinary } from './binary';
import type { WorkflowOutput } from './output-store';
import { imageFixture, imageResult } from './image-generation.test-support';
import { generateWorkflowImage, type WorkflowImageEngine } from './image-generation';
import { releaseValues } from './values';
import type { PreviewFrame } from '@/features/stable-diffusion-cpp-browser/types';

function binary({ bytes, declared }: { bytes: Uint8Array, declared: number }): WorkflowOutput {
  const output: WorkflowOutput = {
    byteLength: declared,
    retain: () => output,
    release: async () => undefined,
    openStream: () => new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
  return output;
}

const signal = (): AbortSignal => new AbortController().signal;

function encoded({ name }: { name: string }): Uint8Array<ArrayBuffer> {
  return new Uint8Array(readFileSync(new URL(`../../naidan-rpc-integration/codecs/fixtures/${name}`, import.meta.url)));
}

it.each([
  { name: 'rgb.png', type: 'image/png' }, { name: 'baseline.jpg', type: 'image/jpeg' },
  { name: 'progressive.jpg', type: 'image/jpeg' }, { name: 'lossless.webp', type: 'image/webp' },
])('sniffs and bounds $name from raw bytes rather than file names or output hints', async ({ name, type }) => {
  const bytes = encoded({ name });
  const file = await readWorkflowImageFile({ value: { type: 'binary', format: 'wav', output: binary({ bytes, declared: bytes.length }) }, signal: signal() });
  expect(file.type).toBe(type);
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
});

it.each([0, -1, 0.5, 17 * 1024 * 1024, Number.NaN])('rejects invalid declared binary size %s without reading', async declared => {
  const output = binary({ bytes: new Uint8Array([1]), declared });
  const open = vi.spyOn(output, 'openStream');
  await expect(readWorkflowBinary({ output, maxBytes: 16 * 1024 * 1024, signal: signal() })).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();
});

it.each([2, 4])('rejects actual bytes different from declared size %s', async declared => {
  await expect(readWorkflowBinary({ output: binary({ bytes: new Uint8Array([1, 2, 3]), declared }), maxBytes: 16, signal: signal() })).rejects.toThrow();
});

it('rejects encoded excessive dimensions before invoking the browser decoder', async () => {
  const bytes = encoded({ name: 'rgb.png' });
  new DataView(bytes.buffer).setUint32(16, 100000);
  const decode = vi.fn();
  await expect(validateWorkflowImageDimensions({ files: [new File([bytes], 'huge.png', { type: 'image/png' })], signal: signal(), decode })).rejects.toThrow();
  expect(decode).not.toHaveBeenCalled();
});

it('closes decoded surfaces on success, dimension rejection and late cancellation', async () => {
  const bytes = encoded({ name: 'rgb.png' });
  const file = new File([bytes], 'image.png', { type: 'image/png' });
  const close = vi.fn();
  await validateWorkflowImageDimensions({ files: [file], signal: signal(), decode: async () => ({ width: 32, height: 24, close }) });
  await expect(validateWorkflowImageDimensions({ files: [file], signal: signal(), decode: async () => ({ width: 9000, height: 24, close }) })).rejects.toThrow();
  const controller = new AbortController();
  await expect(validateWorkflowImageDimensions({
    files: [file],
    signal: controller.signal,
    decode: async () => {
      controller.abort();
      return { width: 32, height: 24, close };
    },
  })).rejects.toThrow();
  expect(close).toHaveBeenCalledTimes(3);
});

it('caps aggregate decoded pixels, not just each individual image', async () => {
  const file = new File([encoded({ name: 'rgb.png' })], 'image.png', { type: 'image/png' });
  const close = vi.fn();
  await expect(validateWorkflowImageDimensions({ files: [file, file], signal: signal(), decode: async () => ({ width: 3000, height: 3000, close }) })).rejects.toThrow('16 megapixels');
  expect(close).toHaveBeenCalledTimes(2);
});

it('passes initial and reference image files with exact strength to the existing engine', async () => {
  await using fixture = imageFixture();
  const bytes = encoded({ name: 'rgb.png' });
  const value = { type: 'binary' as const, output: binary({ bytes, declared: bytes.length }) };
  await fixture.execute({ overrides: { images: { initImage: value, referenceImages: [value], strength: 0.6 } } });
  const request = fixture.generate.mock.calls[0]![0].request;
  expect(request.imageInputs?.strength).toBe(0.6);
  expect(request.imageInputs?.referenceImages).toHaveLength(1);
  expect(request.imageInputs?.initImage?.type).toBe('image/png');
});

it('rejects excessive references or invalid image bytes before starting inference', async () => {
  await using fixture = imageFixture();
  const bad = { type: 'binary' as const, output: binary({ bytes: new Uint8Array([1]), declared: 1 }) };
  await expect(fixture.execute({ overrides: { images: { initImage: undefined, referenceImages: Array.from({ length: 9 }, () => bad), strength: 0.5 } } })).rejects.toThrow();
  await expect(fixture.execute({ overrides: { images: { initImage: bad, referenceImages: [], strength: 0.5 } } })).rejects.toThrow();
  expect(fixture.generate).not.toHaveBeenCalled();
});

it('accepts bounded monotone previews, supports automatic edge, and ignores stale or late frames', async () => {
  await using fixture = imageFixture();
  fixture.input.request.preview = { enabled: true, interval: 1, startStep: 1, maxEdge: 0, mode: 'projection' };
  const frame: PreviewFrame = { type: 'naidan-image-preview-v1', runId: 1, revision: 0, step: 1, steps: 4, width: 128, height: 128, mode: 'projection', png: imageResult({ width: 128, height: 128, compression: 'small' }).png };
  let emit: Parameters<WorkflowImageEngine>[0]['onPreview'];
  fixture.generate.mockImplementation(async ({ onPreview }) => {
    emit = onPreview;
    onPreview?.({ frame });
    onPreview?.({ frame }); // duplicate
    onPreview?.({ frame: { ...frame, runId: 2, step: 2 } });
    onPreview?.({ frame: { ...frame, mode: 'vae', step: 2 } });
    onPreview?.({ frame: { ...frame, step: 2 } });
    return { result: fixture.result, profile: 'webgpu-wasm32-asyncify' };
  });
  const onPreview = vi.fn();
  const outputs = await generateWorkflowImage({ input: fixture.input, generate: fixture.generate, onProgress: () => undefined, onPreview });
  await using owned = { outputs, [Symbol.asyncDispose]: () => releaseValues({ values: Object.values(outputs) }) };
  expect(onPreview.mock.calls.map(([event]) => event.frame.step)).toEqual([1, 2]);
  emit?.({ frame: { ...frame, step: 3 } });
  expect(onPreview).toHaveBeenCalledTimes(2);
  expect(Object.keys(owned.outputs)).toEqual(['image', 'metadata']);
});

it('does not publish previews after Stop even while the engine is still settling', async () => {
  await using fixture = imageFixture();
  fixture.input.request.preview = { enabled: true, interval: 1, startStep: 1, maxEdge: 128, mode: 'projection' };
  const frame: PreviewFrame = { type: 'naidan-image-preview-v1', runId: 1, revision: 0, step: 1, steps: 4, width: 128, height: 128, mode: 'projection', png: fixture.result.png };
  const onPreview = vi.fn();
  fixture.generate.mockImplementation(async ({ onPreview }) => {
    fixture.controller.abort();
    onPreview?.({ frame });
    return { result: fixture.result, profile: 'webgpu-wasm32-asyncify' };
  });
  await expect(generateWorkflowImage({ input: fixture.input, generate: fixture.generate, onProgress: () => undefined, onPreview })).rejects.toThrow();
  expect(onPreview).not.toHaveBeenCalled();
  expect(fixture.store.getUsage().entries).toBe(0);
});

export const TEST_ONLY = {
};
