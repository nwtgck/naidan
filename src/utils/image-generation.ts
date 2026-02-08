/**
 * Image Generation Utilities
 * 
 * Handles technical comments (sentinels) and model discovery for the 
 * experimental image generation feature.
 */
import { z } from 'zod';

export const SENTINEL_IMAGE_REQUEST_PREFIX = '<!-- naidan_experimental_image_request';
export const SENTINEL_IMAGE_RESPONSE_PREFIX = '<!-- naidan_experimental_image_response';
export const SENTINEL_IMAGE_PENDING = '<!-- naidan_experimental_image_generation_pending -->';
export const SENTINEL_IMAGE_PROCESSED = '<!-- naidan_experimental_image_generation_processed -->';

export const IMAGE_BLOCK_LANG = 'naidan_experimental_image';

export const GeneratedImageBlockSchema = z.object({
  binaryObjectId: z.string().uuid(),
  displayWidth: z.number(),
  displayHeight: z.number(),
  prompt: z.string().optional(),
});

export type GeneratedImageBlock = z.infer<typeof GeneratedImageBlockSchema>;

export const ImageRequestParamsSchema = z.object({
  width: z.number().optional(),
  height: z.number().optional(),
  model: z.string().optional(),
  count: z.number().optional(),
});

export type ImageRequestParams = z.infer<typeof ImageRequestParamsSchema>;

export const ImageResponseParamsSchema = z.object({
  count: z.number().optional(),
});

export type ImageResponseParams = z.infer<typeof ImageResponseParamsSchema>;

/**
 * Finds all image generation models from a list of available models.
 * Currently looks for any model starting with 'x/z-image-turbo:'.
 */
export function getImageGenerationModels(models: string[]): string[] {
  return models.filter(m => m.startsWith('x/z-image-turbo:') || m.startsWith('x/flux2-klein:'));
}

/**
 * Creates a sentinel marker for an image generation request.
 */
export function createImageRequestMarker({ width, height, model, count }: ImageRequestParams): string {
  const params = JSON.stringify({ width, height, model, count });
  return `${SENTINEL_IMAGE_REQUEST_PREFIX} ${params} -->`;
}

/**
 * Creates a sentinel marker for an image generation response.
 */
export function createImageResponseMarker({ count }: ImageResponseParams): string {
  const params = JSON.stringify({ count });
  return `${SENTINEL_IMAGE_RESPONSE_PREFIX} ${params} -->`;
}

/**
 * Checks if the content contains an image generation request.
 */
export function isImageRequest(content: string): boolean {
  return content.includes(SENTINEL_IMAGE_REQUEST_PREFIX);
}

/**
 * Checks if the content contains an image generation response metadata.
 */
export function isImageResponse(content: string): boolean {
  return content.includes(SENTINEL_IMAGE_RESPONSE_PREFIX);
}

/**
 * Parses the image request parameters from the content.
 */
export function parseImageRequest(content: string): ImageRequestParams | null {
  const match = content.match(/<!-- naidan_experimental_image_request (\{.*?\}) -->/);
  if (!match) return null;
  try {
    const result = ImageRequestParamsSchema.safeParse(JSON.parse(match[1] || '{}'));
    if (!result.success) {
      console.warn('Failed to validate image request params', result.error);
      return null;
    }
    const data = result.data;
    return {
      width: data.width ?? 512,
      height: data.height ?? 512,
      model: data.model ?? '',
      count: data.count ?? 1
    };
  } catch (e) {
    console.warn('Failed to parse image request params JSON', e);
    return null;
  }
}

/**
 * Parses the image response parameters from the content.
 */
export function parseImageResponse(content: string): ImageResponseParams | null {
  const match = content.match(/<!-- naidan_experimental_image_response (\{.*?\}) -->/);
  if (!match) return null;
  try {
    const result = ImageResponseParamsSchema.safeParse(JSON.parse(match[1] || '{}'));
    if (!result.success) {
      console.warn('Failed to validate image response params', result.error);
      return null;
    }
    const data = result.data;
    return {
      count: data.count ?? 1
    };
  } catch (e) {
    console.warn('Failed to parse image response params JSON', e);
    return null;
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

/**
 * Calculates the progress of image generation from the content.
 * Returns total count and current remaining count.
 */
export function getImageGenerationProgress(content: string): { totalCount: number | undefined, remainingCount: number | undefined } {
  const response = parseImageResponse(content);
  if (!response) return { totalCount: undefined, remainingCount: undefined };

  const totalCount = response.count ?? 1;
  
  // Count already generated images in both OPFS (Markdown block) and local (img tag) modes
  const processedCount = 
    (content.match(new RegExp('```' + IMAGE_BLOCK_LANG, 'g')) || []).length +
    (content.match(/<img/g) || []).length;

  return {
    totalCount,
    remainingCount: Math.max(0, totalCount - processedCount)
  };
}