import { z } from 'zod';
import { toBinaryObjectId, toImageGenerationId } from '@/01-models/ids';
import type { ImageGenerationHistoryPage, ImageGenerationHistoryQuery } from '@/01-models/image-generation-history';

export const historyQuerySchema = z.object({
  storageType: z.literal('opfs'),
  query: z.object({ text: z.string().max(4096), offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100) }).strict(),
}).strict();
export const historyPageSchema = z.object({
  items: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{2,128}$/).transform(raw => toImageGenerationId({ raw })),
    createdAt: z.number().finite().nonnegative(),
    prompt: z.string(),
    modelName: z.string(),
    binaryObjectId: z.string().regex(/^[a-zA-Z0-9_-]{2,128}$/).transform(raw => toBinaryObjectId({ raw })),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    previewCount: z.number().int().nonnegative(),
  }).strict()).max(100),
  total: z.number().int().nonnegative(),
  warnings: z.array(z.object({ path: z.string().max(1024), message: z.string().max(1024) }).strict()).max(100),
  warningCount: z.number().int().nonnegative(),
}).strict();

export interface ImageHistoryWorker {
  query({ request }: { request: z.infer<typeof historyQuerySchema> }): Promise<z.input<typeof historyPageSchema>>,
}
export interface ImageHistoryClient {
  query({ query }: { query: ImageGenerationHistoryQuery }): Promise<ImageGenerationHistoryPage>,
  dispose(): Promise<void>,
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
