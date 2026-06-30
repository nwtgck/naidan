import { z } from 'zod';

export const highlightModeSchema = z.union([
  z.literal('named-language'),
  z.literal('auto-detect'),
]);

export const highlightRequestSchema = z.object({
  code: z.string(),
  language: z.union([z.string().min(1), z.undefined()]),
  mode: highlightModeSchema,
});

export const highlightResponseSchema = z.object({
  html: z.string(),
  resolvedLanguage: z.string(),
});

export type HighlightRequest = z.infer<typeof highlightRequestSchema>;
export type HighlightResponse = z.infer<typeof highlightResponseSchema>;

export interface IHighlightWorker {
  highlight({ request }: { request: HighlightRequest }): Promise<HighlightResponse>,
}

export interface HighlightWorkerClient {
  highlight({ request }: { request: HighlightRequest }): Promise<HighlightResponse>,
  dispose(): Promise<void>,
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
