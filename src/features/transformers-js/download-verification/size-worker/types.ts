import { z } from 'zod';

export const downloadSizeRequestSchema = z.object({
  modelId: z.string().regex(/^[^/]+\/[^/]+$/u),
  revision: z.string().regex(/^[a-f0-9]{40}$/iu),
  paths: z.array(z.string().min(1).max(65_536)).max(256),
}).strict();
export type DownloadSizeRequest = z.infer<typeof downloadSizeRequestSchema>;
export const downloadSizeResultSchema = z.object({
  sizes: z.array(z.object({ path: z.string().min(1).max(65_536), bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict()).max(256),
  quotaLimited: z.boolean(),
}).strict();
export type DownloadSizeResult = z.infer<typeof downloadSizeResultSchema>;
export interface DownloadSizeWorkerApi {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink remote API uses a positional request boundary.
  collect(request: DownloadSizeRequest): Promise<DownloadSizeResult>;
}
export const TEST_ONLY = {
};
