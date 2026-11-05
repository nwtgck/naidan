import { boundedImageDimensions, ImageBoundsError } from '@/utils/image-bounds';

/** Keep the remote-image capability's stricter bounds and error contract. */
export function peerImageDimensions({ bytes, mimeType }: {
  bytes: Uint8Array, mimeType: 'image/png' | 'image/jpeg' | 'image/webp',
}): { width: number, height: number } {
  try {
    return boundedImageDimensions({ bytes, mimeType, maxEdge: 8192, maxPixels: 4 * 1024 * 1024 });
  } catch (cause) {
    if (cause instanceof ImageBoundsError) {
      throw new Error(({ dimensions: 'Remote image pixel limit exceeded', malformed: 'Unsupported or malformed remote image' } satisfies Record<ImageBoundsError['reason'], string>)[cause.reason], { cause });
    }
    throw cause;
  }
}

export const TEST_ONLY = {
};
