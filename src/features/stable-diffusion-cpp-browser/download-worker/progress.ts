import { z } from 'zod';
const size = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const catalogDownloadProgressSchema = z.object({ phase: z.enum(['checking', 'transferring', 'verifying', 'complete']),
  index: size, count: size, repository: z.string(), path: z.string(), completed: size, total: size, processed: size,
  fileCompleted: size, fileTotal: size }).strict();
export type CatalogDownloadProgress = z.infer<typeof catalogDownloadProgressSchema>;
export const TEST_ONLY = {
};
