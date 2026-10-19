import { z } from 'zod';
import { huggingFaceFileSchema } from './source';

const fields = {
  source: huggingFaceFileSchema,
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  state: z.enum(['partial', 'invalid']),
};
export const pendingDownloadSchema = z.object({ version: z.literal(2), kind: z.literal('naidan-file-download'), ...fields }).strict().refine(value => value.bytes <= value.source.size);
const legacyImagePendingSchema = z.object({ version: z.literal(1), kind: z.literal('naidan-image-download'), ...fields }).strict().refine(value => value.bytes <= value.source.size);

/** Migration is local to disposable sidecars; no application settings DTO changes. */
export function readPendingDownload({ value }: { value: unknown }): z.infer<typeof pendingDownloadSchema> {
  const parsed = z.union([pendingDownloadSchema, legacyImagePendingSchema]).parse(value);
  const { version: _version, kind: _kind, source, bytes, state, ...unhandled } = parsed;
  unhandled satisfies Record<PropertyKey, never>;
  return { version: 2, kind: 'naidan-file-download', source, bytes, state };
}

export const TEST_ONLY = {
};
