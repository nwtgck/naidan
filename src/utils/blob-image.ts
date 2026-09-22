import { z } from 'zod';
import { blobForTransport, createBlobURLScope, type BlobView } from './blob-view';
import { assertBlobBytes, waitForBlobRead } from './blob-view-io';

/** Straight-alpha, sRGB, row-major RGBA8. Never an ImageBitmap or a shared buffer. */
export interface BlobImagePixels {
  width: number,
  height: number,
  rgba: Uint8Array<ArrayBuffer>,
}

export interface BlobImageLimits {
  maxBytes: number,
  maxPixels: number,
}

/** Image decoding is a separate capability from reading a Blob's encoded bytes. */
export interface BlobImageDecoder {
  decode({ blob, signal }: { blob: Blob | BlobView, signal: AbortSignal | undefined }): Promise<BlobImagePixels>,
  dispose(): void,
}

const dimensionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const pixelsSchema = z.object({
  width: dimensionSchema,
  height: dimensionSchema,
  rgba: z.custom<Uint8Array<ArrayBuffer>>(value => ArrayBuffer.isView(value)
    && Object.prototype.toString.call(value) === '[object Uint8Array]'
    && Object.prototype.toString.call(value.buffer) === '[object ArrayBuffer]'),
}).strict();

function isNativeBlob(value: unknown): value is Blob {
  try {
    Object.getOwnPropertyDescriptor(Blob.prototype, 'size')!.get!.call(value);
    return true;
  } catch {
    return false;
  }
}

/** Interop boundary: unwrap only the view's own range, without consuming bytes. */
export function blobImageInput({ blob, limits }: { blob: Blob | BlobView, limits: BlobImageLimits }): Blob {
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1
    || !Number.isSafeInteger(limits.maxPixels) || limits.maxPixels < 1
    || limits.maxPixels > Math.floor(Number.MAX_SAFE_INTEGER / 4)) {
    throw new RangeError('Invalid image decoding limits');
  }
  const native = isNativeBlob(blob) ? blob : blobForTransport({ blob });
  if (!Number.isSafeInteger(native.size) || native.size < 1 || native.size > limits.maxBytes) {
    throw new RangeError('Encoded image exceeds the decoding limit or is empty');
  }
  if (!native.type.startsWith('image/')) throw new TypeError('Expected an image Blob');
  return native;
}

export function assertBlobImageDimensions({ width, height, limits }: {
  width: number, height: number, limits: BlobImageLimits,
}): void {
  if (!Number.isSafeInteger(limits.maxPixels) || limits.maxPixels < 1
    || limits.maxPixels > Math.floor(Number.MAX_SAFE_INTEGER / 4)
    || !Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1
    || width > Math.floor(limits.maxPixels / height)) {
    throw new RangeError('Decoded image exceeds the pixel limit or has invalid dimensions');
  }
}

/** Validate both the native result and each untrusted reverse-RPC response. */
export function parseBlobImagePixels({ value, limits }: { value: unknown, limits: BlobImageLimits }): BlobImagePixels {
  const pixels = pixelsSchema.parse(value);
  assertBlobImageDimensions({ width: pixels.width, height: pixels.height, limits });
  assertBlobBytes({ bytes: pixels.rgba, length: pixels.width * pixels.height * 4 });
  return pixels;
}

/** Only decoder failures may try another local/remote decoder, never security or bounds errors. */
export function isBlobImageDecodeFailure({ error }: { error: unknown }): boolean {
  return typeof error === 'object' && error !== null && 'name' in error
    && ['NotReadableError', 'InvalidStateError', 'EncodingError', 'NotSupportedError'].includes(String(error.name));
}

function readImagePixels({ image, width, height, limits, signal }: {
  image: ImageBitmap | HTMLImageElement,
  width: number,
  height: number,
  limits: BlobImageLimits,
  signal: AbortSignal,
}): BlobImagePixels {
  signal.throwIfAborted();
  assertBlobImageDimensions({ width, height, limits });
  let canvas: OffscreenCanvas | HTMLCanvasElement | undefined;
  try {
    let context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
    if (typeof OffscreenCanvas === 'function') {
      canvas = new OffscreenCanvas(width, height);
      context = canvas.getContext('2d');
    }
    // A host Window may have 2D canvas even without OffscreenCanvas's 2D support.
    if (context === null && typeof document !== 'undefined') {
      if (canvas) {
        canvas.width = 0; canvas.height = 0;
      }
      canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      context = canvas.getContext('2d');
    }
    if (!context) throw new DOMException('Image pixel extraction is unavailable', 'NotSupportedError');
    signal.throwIfAborted();
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, width, height);
    if (Object.prototype.toString.call(data) !== '[object Uint8ClampedArray]'
      || Object.prototype.toString.call(data.buffer) !== '[object ArrayBuffer]'
      || data.byteOffset !== 0 || data.byteLength !== data.buffer.byteLength) {
      throw new TypeError('Image decoder must return an owned RGBA8 buffer');
    }
    const pixels = parseBlobImagePixels({ value: { width, height, rgba: new Uint8Array(data.buffer) }, limits });
    signal.throwIfAborted();
    return pixels;
  } finally {
    if (canvas) {
      canvas.width = 0; canvas.height = 0;
    }
  }
}

/** A Window-only fallback. Never attach the element or accept an arbitrary URL. */
async function decodeBlobImageElement({ blob, limits, signal }: {
  blob: Blob, limits: BlobImageLimits, signal: AbortSignal,
}): Promise<BlobImagePixels> {
  signal.throwIfAborted();
  const urls = createBlobURLScope();
  let image: HTMLImageElement | undefined;
  let onLoad: (() => void) | undefined;
  let onError: (() => void) | undefined;
  try {
    const lease = urls.createObjectURL({ blob });
    image = document.createElement('img');
    signal.throwIfAborted();
    const element = image;
    let operation: Promise<void>;
    if (typeof element.decode === 'function') {
      element.src = lease.url;
      operation = element.decode();
    } else {
      // Attach before src, including for already-cached/synchronously reported loads.
      operation = new Promise<void>((resolve, reject) => {
        onLoad = resolve;
        onError = () => reject(new DOMException('Image element decoding failed', 'EncodingError'));
        element.addEventListener('load', onLoad, { once: true });
        element.addEventListener('error', onError, { once: true });
        element.src = lease.url;
      });
    }
    await waitForBlobRead({ operation, signal, timeoutMs: undefined });
    // Natural dimensions, not layout width/height (the element is not in the DOM).
    return readImagePixels({ image: element, width: element.naturalWidth, height: element.naturalHeight, limits, signal });
  } finally {
    try {
      if (image !== undefined) {
        if (onLoad !== undefined) image.removeEventListener('load', onLoad);
        if (onError !== undefined) image.removeEventListener('error', onError);
        // Removing the attribute does not request an empty URL or navigate to a
        // document-relative URL. Late events/decode rejection cannot publish pixels.
        image.removeAttribute('src');
      }
    } finally {
      urls.dispose();
    }
  }
}

/** Native operations in the current realm; the Worker adapter chooses the remote host. */
export async function decodeNativeBlobImage({ blob, limits, signal }: {
  blob: Blob,
  limits: BlobImageLimits,
  signal: AbortSignal,
}): Promise<BlobImagePixels> {
  signal.throwIfAborted();
  blobImageInput({ blob, limits });
  let bitmap: ImageBitmap | undefined;
  let abandoned = false;
  // Keep physical bitmap ownership separate from the cancellable logical wait.
  // The async boundary also turns a synchronous native throw into a rejection.
  const operation = (async () => {
    if (typeof createImageBitmap !== 'function') throw new DOMException('Image bitmap decoding is unavailable', 'NotSupportedError');
    return createImageBitmap(blob);
  })().then(created => {
    if (abandoned || signal.aborted) {
      created.close();
      signal.throwIfAborted();
      throw new DOMException('Image decoding abandoned', 'AbortError');
    }
    bitmap = created;
    return created;
  });
  try {
    let image: ImageBitmap;
    try {
      image = await waitForBlobRead({ operation, signal, timeoutMs: undefined });
    } catch (error) {
      signal.throwIfAborted();
      if (!isBlobImageDecodeFailure({ error }) || typeof document === 'undefined'
        || typeof document.createElement !== 'function') throw error;
      // Only a failed bitmap acquisition may fall back. Readback/security/limit
      // failures after a bitmap exists must not start a second decoder.
      return await decodeBlobImageElement({ blob, limits, signal });
    }
    return readImagePixels({ image, width: image.width, height: image.height, limits, signal });
  } finally {
    abandoned = true;
    bitmap?.close();
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
