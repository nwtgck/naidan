import { boundedImageDimensions } from '@/utils/image-bounds';
import type { RuntimeValue } from './values';
import { readWorkflowBinary } from './binary';

export const WORKFLOW_IMAGE_FILE_LIMIT = 16 * 1024 * 1024;
export const WORKFLOW_IMAGE_FILES_LIMIT = 64 * 1024 * 1024;
export const WORKFLOW_IMAGE_REFERENCE_LIMIT = 8;

/** File names and declared media types are not trusted at a Workflow boundary. */
export async function readWorkflowImageFile({ value, signal }: {
  value: Extract<RuntimeValue, { type: 'binary' }>, signal: AbortSignal,
}): Promise<File> {
  const bytes = await readWorkflowBinary({ output: value.output, maxBytes: WORKFLOW_IMAGE_FILE_LIMIT, signal });
  const ascii = ({ at, text }: { at: number, text: string }): boolean => [...text].every((character, index) => bytes[at + index] === character.charCodeAt(0));
  let type: 'image/png' | 'image/jpeg' | 'image/webp';
  let name: string;
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) {
    type = 'image/png';
    name = 'input.png';
  } else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    type = 'image/jpeg';
    name = 'input.jpg';
  } else if (bytes.length >= 12 && ascii({ at: 0, text: 'RIFF' }) && ascii({ at: 8, text: 'WEBP' })) {
    type = 'image/webp';
    name = 'input.webp';
  } else {
    throw new Error('Image inputs require encoded PNG, JPEG, or WebP bytes.');
  }
  boundedImageDimensions({ bytes, mimeType: type, maxEdge: 8192, maxPixels: 16 * 1024 * 1024 });
  return new File([bytes], name, { type });
}

/** Decoding checks use the browser's actual decoder. Retain no decoded surfaces.
 * The native engine still performs its own normalization for model inputs.
 */
export async function validateWorkflowImageDimensions({ files, signal, decode }: {
  files: File[], signal: AbortSignal,
  decode: ({ image }: { image: Blob }) => Promise<{ width: number, height: number, close: () => void }>,
}): Promise<void> {
  if (files.length > WORKFLOW_IMAGE_REFERENCE_LIMIT + 1 || files.reduce((total, file) => total + file.size, 0) > WORKFLOW_IMAGE_FILES_LIMIT) {
    throw new Error('Image inputs exceed the aggregate file limit.');
  }
  let pixels = 0;
  for (const file of files) {
    signal.throwIfAborted();
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > WORKFLOW_IMAGE_FILE_LIMIT) {
      throw new Error('Unsupported or excessive image input.');
    }
    const mimeType = file.type as 'image/png' | 'image/jpeg' | 'image/webp';
    const bytes = new Uint8Array(await file.arrayBuffer());
    boundedImageDimensions({ bytes, mimeType, maxEdge: 8192, maxPixels: 16 * 1024 * 1024 });
    signal.throwIfAborted();
    const image = await decode({ image: file });
    try {
      signal.throwIfAborted();
      pixels += image.width * image.height;
      if (pixels > 16 * 1024 * 1024 || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)
        || image.width < 1 || image.height < 1 || image.width > 8192 || image.height > 8192
        || image.width * image.height > 16 * 1024 * 1024) {
        throw new Error('Image inputs must be at most 8192 pixels per side and 16 megapixels.');
      }
    } finally {
      image.close();
    }
  }
}

export const TEST_ONLY = {
};
