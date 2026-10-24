import { resolveHuggingFaceFile } from '@/logic/hugging-face-download/source';
import { z } from 'zod';
import type { CatalogFetch } from '@/features/stable-diffusion-cpp-browser/download-worker/fetch-types';
import { validModelPath } from './model-path';
import { isExperimentalImageCatalogMain } from '@/01-models/experimental-image-catalog-source';
// Catalog downloads normally require an immutable commit. The newly published
// Abiray Turbo weights have no verified commit id yet; allow *only* their known
// six files at main for experimental use. Every download is still bound to and
// checked against the LFS SHA-256 returned by the explicit metadata request.
// Remove this exception and pin a commit once its 40-digit id is verified.
export const imageDownloadSourceSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  revision: z.string().regex(/^(?:[a-f0-9]{40}|main)$/),
  path: z.string().refine(path => validModelPath({ path }) && /\.(gguf|safetensors|sft)$/i.test(path) && !path.split('/').some(part => part.startsWith('.'))),
}).superRefine((source, ctx) => {
  if (source.revision === 'main' && !isExperimentalImageCatalogMain(source)) {
    ctx.addIssue({ code: 'custom', message: 'Mutable model revision is not permitted for this catalog file' });
  }
});
export type ImageDownloadSource = z.infer<typeof imageDownloadSourceSchema>;
export const imageFileIdentitySchema = imageDownloadSourceSchema.safeExtend({ size: z.number().int().min(8).max(Number.MAX_SAFE_INTEGER), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
export type ImageFileIdentity = z.infer<typeof imageFileIdentitySchema>;

/** Image catalog policy remains here; metadata identity comes from the shared HF resolver. */
export async function imageFileIdentity({ file, signal, fetch }: { file: ImageDownloadSource, signal: AbortSignal, fetch: CatalogFetch }): Promise<ImageFileIdentity> {
  return imageFileIdentitySchema.parse(await resolveHuggingFaceFile({ file: imageDownloadSourceSchema.parse(file), signal, fetch }));
}

export const TEST_ONLY = {
};
