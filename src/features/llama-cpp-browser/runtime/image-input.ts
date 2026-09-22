import { blobImageInput, decodeNativeBlobImage, parseBlobImagePixels, type BlobImageDecoder } from '@/utils/blob-image';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';

/** Current providers receive local attachments as data URLs; never fetch remote URLs here. */
export function imageFromDataUrl({ url }: { url: string }): Blob {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(url);
  if (!match || match[2]!.length > 96 * 1024 * 1024) throw new LlamaCppBrowserError({ code: 'unsupported-input' });
  try {
    const decoded = atob(match[2]!);
    return new Blob([Uint8Array.from(decoded, character => character.charCodeAt(0))], { type: match[1] });
  } catch {
    throw new LlamaCppBrowserError({ code: 'unsupported-input' });
  }
}
/** Also bound raw Blob inputs to 72 MiB; keep the existing decoded-pixel ceiling. */
export const IMAGE_DECODE_LIMITS = Object.freeze({ maxBytes: 72 * 1024 * 1024, maxPixels: 64 * 1024 * 1024 });

export async function decodeImage({ blob, decoder, signal }: {
  blob: Blob,
  decoder?: BlobImageDecoder,
  signal?: AbortSignal,
}): Promise<{ width: number, height: number, rgb: Uint8Array<ArrayBuffer> }> {
  signal?.throwIfAborted();
  try {
    blobImageInput({ blob, limits: IMAGE_DECODE_LIMITS });
    const pixels = parseBlobImagePixels({
      value: decoder === undefined
        ? await decodeNativeBlobImage({ blob, limits: IMAGE_DECODE_LIMITS, signal: signal ?? new AbortController().signal })
        : await decoder.decode({ blob, signal }),
      limits: IMAGE_DECODE_LIMITS,
    });
    signal?.throwIfAborted();
    const { width, height, rgba } = pixels;
    const rgb = new Uint8Array(width * height * 3);
    for (let pixel = 0; pixel < width * height; pixel++) {
      // Preserve the existing white-background alpha composition for mtmd.
      const alpha = rgba[pixel * 4 + 3]! / 255;
      for (let channel = 0; channel < 3; channel++) rgb[pixel * 3 + channel] = Math.round(rgba[pixel * 4 + channel]! * alpha + 255 * (1 - alpha));
    }
    signal?.throwIfAborted();
    return { width, height, rgb };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new LlamaCppBrowserError({ code: 'unsupported-input' });
  }
}
export const TEST_ONLY = {
};
