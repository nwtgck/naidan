/**
 * Image Processing Utilities
 */

/**
 * Re-encodes a Blob to a different image format using Canvas.
 */
export async function reencodeImage({ blob, format }: {
  blob: Blob,
  format: 'webp' | 'jpeg' | 'png'
}): Promise<Blob> {
  const img = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get canvas context');

  ctx.drawImage(img, 0, 0);

  const mimeType = `image/${format}`;
  return new Promise((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) {
        resolve(result);
      } else {
        reject(new Error(`Failed to convert image to ${format}`));
      }
    }, mimeType, 1.0);
  });
}
