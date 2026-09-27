import type { ImageGenerationRecord } from '@/01-models/image-generation-history';
import type { ImageDownloadFormat } from '@/features/stable-diffusion-cpp-browser/use-image-generation-types';
import { convertDownloadImage } from './download-format';
import { generationXmp, jpegWithXmp, webpWithXmp } from './download-xmp';

export type ImageGenerationExportImage =
  | { kind: 'final', width: number, height: number }
  | { kind: 'preview', width: number, height: number, step: number, steps: number, mode: 'projection' | 'vae' };

function crc32({ bytes }: { bytes: Uint8Array }): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

/** Convert/embed settings only in an explicitly downloaded copy. */
export async function imageGenerationDownloadBlob({ png, request, image, format, includeMetadata }: {
  png: Blob,
  request: ImageGenerationRecord['request'],
  image: ImageGenerationExportImage,
  format: ImageDownloadFormat,
  includeMetadata: boolean,
}): Promise<Blob> {
  const output = await convertDownloadImage({ png, format });
  if (!includeMetadata) return output;
  const bytes = new Uint8Array(await output.arrayBuffer());
  const json = JSON.stringify({ request, image });
  switch (format) {
  case 'jpeg': return jpegWithXmp({ bytes, packet: generationXmp({ json }) });
  case 'webp': return webpWithXmp({ bytes, packet: generationXmp({ json }) });
  case 'png': break;
  default: { const exhaustive: never = format; throw new Error(String(exhaustive)); }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let endOffset: number | undefined;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset);
    if (offset + length + 12 > bytes.length) throw new Error('Generated PNG contains a truncated chunk');
    if (bytes[offset + 4] === 73 && bytes[offset + 5] === 69 && bytes[offset + 6] === 78 && bytes[offset + 7] === 68) {
      endOffset = offset; break;
    }
    offset += length + 12;
  }
  if (endOffset === undefined) throw new Error('Generated PNG is missing its end chunk');
  // Requested seed -1 remains a request for randomness. We do not invent the
  // actual native seed or promise deterministic reproduction across runtimes.
  const payload = new TextEncoder().encode(`Naidan image generation\0\0\0\0\0${json}`);
  const chunk = new Uint8Array(payload.length + 12);
  const chunkView = new DataView(chunk.buffer);
  chunkView.setUint32(0, payload.length);
  chunk.set([105, 84, 88, 116], 4);
  chunk.set(payload, 8);
  chunkView.setUint32(chunk.length - 4, crc32({ bytes: chunk.subarray(4, chunk.length - 4) }));
  return new Blob([bytes.subarray(0, endOffset), chunk, bytes.subarray(endOffset)], { type: 'image/png' });
}

export function downloadImageBlob({ blob, filename }: { blob: Blob, filename: string }): void {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
