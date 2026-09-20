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
export async function decodeImage({ blob }: { blob: Blob }): Promise<{ width: number, height: number, rgb: Uint8Array }> {
  if (!blob.type.startsWith('image/') || typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') throw new LlamaCppBrowserError({ code: 'unsupported-input' });
  const bitmap = await createImageBitmap(blob);
  try {
    const { width, height } = bitmap;
    if (!width || !height || width * height > 64 * 1024 * 1024) throw new LlamaCppBrowserError({ code: 'unsupported-input' });
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new LlamaCppBrowserError({ code: 'unsupported-input' });
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, width, height);
    const rgb = new Uint8Array(width * height * 3);
    for (let pixel = 0; pixel < width * height; pixel++) {
      // Composite transparent pixels onto white, consistently across decoders.
      const alpha = data[pixel * 4 + 3]! / 255;
      for (let channel = 0; channel < 3; channel++) rgb[pixel * 3 + channel] = Math.round(data[pixel * 4 + channel]! * alpha + 255 * (1 - alpha));
    }
    canvas.width = 0; canvas.height = 0;
    return { width, height, rgb };
  } finally {
    bitmap.close();
  }
}
export const TEST_ONLY = {
};
