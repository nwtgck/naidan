import { z } from 'zod';
const size = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const fileDownloadProgressSchema = z.object({
  phase: z.enum(['checking', 'transferring', 'verifying', 'complete']),
  index: size,
  count: size,
  repository: z.string(),
  revision: z.string().optional(),
  path: z.string(),
  completed: size,
  total: size,
  processed: size,
  fileCompleted: size,
  fileTotal: size,
}).strict();
export type FileDownloadProgress = z.infer<typeof fileDownloadProgressSchema>;
export const TEST_ONLY = {
};
