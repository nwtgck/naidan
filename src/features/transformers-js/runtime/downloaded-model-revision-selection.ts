import { z } from 'zod';

/** A pinned legacy-main Load must never be widened into cache discovery. */
export const downloadedModelRevisionSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pinned'), revision: z.string().optional() }).strict(),
  z.object({ kind: z.literal('discover-cached') }).strict(),
]);

export type DownloadedModelRevisionSelection = z.infer<typeof downloadedModelRevisionSelectionSchema>;

export const TEST_ONLY = {
};
