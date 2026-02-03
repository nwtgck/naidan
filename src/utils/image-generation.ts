/**
 * Image Generation Utilities
 * 
 * Handles technical comments (sentinels) and model discovery for the 
 * experimental image generation feature.
 */

export const SENTINEL_IMAGE_REQUEST_PREFIX = '<!-- naidan_experimental_image_request';
export const SENTINEL_IMAGE_PENDING = '<!-- naidan_experimental_image_generation_pending -->';
export const SENTINEL_IMAGE_PROCESSED = '<!-- naidan_experimental_image_generation_processed -->';

export interface ImageRequestParams {
  width: number;
  height: number;
}

/**
 * Finds an image generation model from a list of available models.
 * Currently looks for any model starting with 'x/z-image-turbo:'.
 */
export function findImageGenerationModel(models: string[]): string | null {
  return models.find(m => m.startsWith('x/z-image-turbo:')) || null;
}

/**
 * Creates a sentinel marker for an image generation request.
 */
export function createImageRequestMarker({ width, height }: ImageRequestParams): string {
  const params = JSON.stringify({ width, height });
  return `${SENTINEL_IMAGE_REQUEST_PREFIX} ${params} -->`;
}

/**
 * Checks if the content contains an image generation request.
 */
export function isImageRequest(content: string): boolean {
  return content.includes(SENTINEL_IMAGE_REQUEST_PREFIX);
}

/**
 * Parses the image request parameters from the content.
 */
export function parseImageRequest(content: string): ImageRequestParams | null {
  const match = content.match(/<!-- naidan_experimental_image_request (\{.*?\}) -->/);
  if (!match) return null;
  try {
    const params = JSON.parse(match[1] || '{}');
    return {
      width: typeof params.width === 'number' ? params.width : 512,
      height: typeof params.height === 'number' ? params.height : 512
    };
  } catch (e) {
    console.warn('Failed to parse image request params', e);
    return { width: 512, height: 512 };
  }
}

/**
 * Removes all naidan-specific technical comments from the content.
 */
export function stripNaidanSentinels(content: string): string {
  return content.replace(/<!-- naidan_.*? -->/g, '');
}

/**
 * Checks if the content indicates a pending image generation.
 */
export function isImageGenerationPending(content: string): boolean {
  return content.includes(SENTINEL_IMAGE_PENDING);
}

/**
 * Checks if the content indicates a processed image generation.
 */
export function isImageGenerationProcessed(content: string): boolean {
  return content.includes(SENTINEL_IMAGE_PROCESSED);
}