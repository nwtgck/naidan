import type { Core } from './core-types';
import type { ImageInputs } from '@/features/stable-diffusion-cpp-browser/types';

export type InputImageMetadata = { role: 'initial' | 'reference', index: number, width: number, height: number, bytes: number };

/** The original encoded files stay on the request. Decoded pixels only live for
 * this native call; no image identity or state enters the model session key. */
export async function writeImageInputs({ core, params, inputs, keep, checkCancelled, onDecoded }: {
  core: Pick<Core, 'pointerBytes' | 'alloc' | 'bytes' | 'setField' | 'fieldAddress' | 'recordSize'>, params: bigint, inputs: ImageInputs,
  keep: ({ pointer }: { pointer: bigint }) => bigint,
  checkCancelled: () => void,
  onDecoded: ({ metadata }: { metadata: InputImageMetadata }) => void,
}): Promise<void> {
  if (!inputs.initImage && inputs.referenceImages.length === 0) return;
  async function write({ file, pointer, role, index }: { file: File, pointer: bigint, role: InputImageMetadata['role'], index: number }): Promise<void> {
    checkCancelled();
    const bitmap = await createImageBitmap(file);
    let canvas: OffscreenCanvas | undefined;
    try {
      checkCancelled();
      const { width, height } = bitmap;
      const pixels = width * height;
      if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= 2147483647)
        || !Number.isSafeInteger(pixels * 12) || (core.pointerBytes === 4 && pixels * 12 > 4294967295)) {
        throw new Error('Input image dimensions exceed the native addressable image range');
      }
      canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Cannot decode input image pixels');
      // Native RGB inputs have no alpha. Composite transparency against white
      // explicitly; resizing remains the native model's responsibility.
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0);
      const rgba = context.getImageData(0, 0, width, height).data;
      checkCancelled();
      const data = core.alloc(pixels * 3);
      if (!data) throw new Error('Could not allocate input image pixels');
      keep({ pointer: data });
      const rgb = core.bytes(data, pixels * 3);
      for (let source = 0, target = 0; source < rgba.length; source += 4, target += 3) {
        rgb[target] = rgba[source]!; rgb[target + 1] = rgba[source + 1]!; rgb[target + 2] = rgba[source + 2]!;
      }
      core.setField('sd_image_t', pointer, 'width', width);
      core.setField('sd_image_t', pointer, 'height', height);
      core.setField('sd_image_t', pointer, 'channel', 3);
      core.setField('sd_image_t', pointer, 'data', data);
      onDecoded({ metadata: { role, index, width, height, bytes: file.size } });
    } finally {
      bitmap.close();
      if (canvas) {
        canvas.width = 0; canvas.height = 0;
      }
    }
  }
  if (inputs.initImage) {
    await write({ file: inputs.initImage, pointer: core.fieldAddress('sd_img_gen_params_t', params, 'init_image'), role: 'initial', index: 0 });
    core.setField('sd_img_gen_params_t', params, 'strength', inputs.strength);
  }
  if (inputs.referenceImages.length) {
    const recordBytes = core.recordSize('sd_image_t');
    const bytes = recordBytes * inputs.referenceImages.length;
    if (!Number.isSafeInteger(bytes) || bytes < 1 || (core.pointerBytes === 4 && bytes > 4294967295)) throw new Error('Reference image records exceed the native addressable range');
    const records = core.alloc(bytes);
    if (!records) throw new Error('Could not allocate reference image records');
    keep({ pointer: records });
    core.bytes(records, recordBytes * inputs.referenceImages.length).fill(0);
    for (const [index, file] of inputs.referenceImages.entries()) {
      await write({ file, pointer: records + BigInt(recordBytes * index), role: 'reference', index });
    }
    core.setField('sd_img_gen_params_t', params, 'ref_images', records);
    core.setField('sd_img_gen_params_t', params, 'ref_images_count', inputs.referenceImages.length);
    // Keep the native family preset; file selection alone cannot establish
    // whether a particular checkpoint was trained for reference conditioning.
  }
  checkCancelled();
}

export const TEST_ONLY = {
};
