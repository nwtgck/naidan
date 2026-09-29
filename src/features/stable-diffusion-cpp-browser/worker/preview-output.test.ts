import { expect, it, vi } from 'vitest';
import { createPreviewOutput } from './preview-output';
import type { PreviewFrame } from '@/features/stable-diffusion-cpp-browser/types';
import type { encodeImagePixels } from './image-output';
const image = { pixels: new Uint8ClampedArray([1, 2, 3, 255]), width: 1, height: 1 };
function capture({ step, revision = 0 }: { step: number, revision?: number }) {
  return { image, maxEdge: 256, frame: { type: 'naidan-image-preview-v1' as const, runId: 1, revision, step, steps: 100, mode: 'projection' as const } };
}
const encoded = () => ({ png: new Blob(['x'], { type: 'image/png' }), width: 1, height: 1 });
it('bounds active encoding to one plus the newest pending frame under rapid callbacks', async () => {
  const gate = Promise.withResolvers<ReturnType<typeof encoded>>(), publish = vi.fn();
  const encode = vi.fn<typeof encodeImagePixels>().mockResolvedValue(encoded()).mockReturnValueOnce(gate.promise);
  const output = createPreviewOutput({ publish, valid: () => true, onError: vi.fn(), encode });
  for (let step = 1; step <= 100; step++) output.push({ capture: capture({ step }) });
  expect(encode).toHaveBeenCalledTimes(1); expect(output.dropped()).toBe(98);
  gate.resolve(encoded()); await output.finish();
  expect(encode).toHaveBeenCalledTimes(2);
  expect(publish.mock.calls.map(([{ frame }]) => frame.step)).toEqual([1, 100]);
});
it('does not publish stale encodes after OFF or a new size revision and releases the pending frame on close', async () => {
  let revision = 0, enabled = true;
  const gate = Promise.withResolvers<ReturnType<typeof encoded>>(), publish = vi.fn();
  const encode = vi.fn<typeof encodeImagePixels>().mockReturnValue(gate.promise);
  const output = createPreviewOutput({ publish, valid: ({ revision: id }) => enabled && id === revision, onError: vi.fn(), encode });
  output.push({ capture: capture({ step: 1 }) }); output.push({ capture: capture({ step: 2 }) });
  revision = 1; enabled = false; output.close(); gate.resolve(encoded()); await output.finish();
  expect(publish).not.toHaveBeenCalled(); expect(encode).toHaveBeenCalledTimes(1);
  output.push({ capture: capture({ step: 3, revision: 1 }) }); expect(encode).toHaveBeenCalledTimes(1);
});
it('recovers from an encoder rejection and never strands a frame arriving at the completion boundary', async () => {
  const onError = vi.fn(), seen: number[] = [];
  const encode = vi.fn<typeof encodeImagePixels>().mockResolvedValue(encoded()).mockRejectedValueOnce(new Error('encode failure'));
  const output = createPreviewOutput({ publish: ({ frame }: { frame: PreviewFrame }) => {
    seen.push(frame.step);
  }, valid: () => true, onError, encode });
  output.push({ capture: capture({ step: 1 }) });
  await Promise.resolve();
  output.push({ capture: capture({ step: 2 }) });
  await output.finish();
  output.push({ capture: capture({ step: 3 }) }); await output.finish();
  expect(onError).toHaveBeenCalledTimes(1); expect(seen).toEqual([2, 3]);
});

it('records native and delivered sizes plus encoding/queue wall time without including native decoding', async () => {
  let time = 0; const measure = vi.fn(), gate = Promise.withResolvers<ReturnType<typeof encoded>>();
  const output = createPreviewOutput({ publish: vi.fn(), valid: () => true, onError: vi.fn(), onMeasure: measure, now: () => time,
    encode: vi.fn<typeof encodeImagePixels>().mockReturnValue(gate.promise),
  });
  output.push({ capture: capture({ step: 2 }) }); time = 15; gate.resolve(encoded()); await output.finish();
  expect(measure).toHaveBeenCalledWith({ fields: expect.objectContaining({ step: 2, nativeWidth: 1, nativeHeight: 1, outputWidth: 1, outputHeight: 1,
    queueWallMs: 0, encodeWallMs: 15, delivered: true, includesNativeDecode: false }) });
});
it('does not let a broken measurement sink change a successfully delivered preview', async () => {
  const publish = vi.fn(), onError = vi.fn();
  const output = createPreviewOutput({ publish, valid: () => true, onError, encode: vi.fn<typeof encodeImagePixels>().mockResolvedValue(encoded()),
    onMeasure() {
      throw new Error('observation only');
    },
  });
  output.push({ capture: capture({ step: 1 }) }); await output.finish(); expect(publish).toHaveBeenCalledOnce(); expect(onError).not.toHaveBeenCalled();
});
