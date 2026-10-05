import type { ImageDownloadFormat } from '@/features/image-generation/use-image-generation-types';

export function imageDownloadMime({ format }: { format: ImageDownloadFormat }): string {
  switch (format) {
  case 'png': return 'image/png';
  case 'webp': return 'image/webp';
  case 'jpeg': return 'image/jpeg';
  default: { const exhaustive: never = format; throw new Error(String(exhaustive)); }
  }
}

export async function validateDownloadImage({ blob, format }: { blob: Blob, format: ImageDownloadFormat }): Promise<void> {
  const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const signatureMatches = (() => {
    switch (format) {
    case 'png': return [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
    case 'webp': return new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP';
    case 'jpeg': return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    default: { const exhaustive: never = format; throw new Error(String(exhaustive)); }
    }
  })();
  if (blob.type !== imageDownloadMime({ format }) || !signatureMatches) {
    throw new Error(`The browser did not produce a valid ${format.toUpperCase()} image. Choose another download format.`);
  }
}

/** Re-encode a download copy; inference output and stored PNG bytes stay intact. */
export async function convertDownloadImage({ png, format }: { png: Blob, format: ImageDownloadFormat }): Promise<Blob> {
  await validateDownloadImage({ blob: png, format: 'png' });
  switch (format) {
  case 'png': return png;
  case 'webp': case 'jpeg': break;
  default: { const exhaustive: never = format; throw new Error(String(exhaustive)); }
  }
  const canvas = document.createElement('canvas');
  const bitmap = await createImageBitmap(png);
  try {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image conversion is unavailable in this browser');
    context.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(result => {
        if (result) resolve(result);
        else reject(new Error('The browser could not encode the downloaded image'));
      }, imageDownloadMime({ format }), 1);
    });
    // Canvas is allowed to return PNG when an encoder is unsupported. Reject
    // that fallback instead of silently giving it a .webp or .jpeg extension.
    await validateDownloadImage({ blob, format });
    return blob;
  } finally {
    bitmap.close();
    canvas.width = 0;
    canvas.height = 0;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
