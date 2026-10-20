import { z } from 'zod';
import { LlamaCppBrowserError, modelDirectoryInputSchema } from '@/features/llama-cpp-browser/types';
import { modelVariantName } from '@/features/llama-cpp-browser/hugging-face/model-variants';
import { normalizeModelDirectoryInput } from './model-directory-input';
import { resolveModelFiles, type ModelDirectory } from './model-directory';
import { isTemporaryModelReference, parseTemporaryModelReference } from './temporary-model-reference';

/** Worker-only data, never a persisted DTO or a peer-facing RPC document.
 * File is structured-cloneable; it must not be placed in a transfer list. */
export const temporaryModelSourceSchema = z.object({
  id: z.string().refine(name => isTemporaryModelReference({ name })),
  // Cache invalidation within this page, not a public identity or reload guard.
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  files: modelDirectoryInputSchema.shape.files,
  modelPath: z.string(),
  // An unscoped folder can be renamed with -2 without changing variant labels.
  variantRepository: z.string().min(1),
  projectorPath: z.string().optional(),
}).strict();
export type TemporaryModelSource = z.infer<typeof temporaryModelSourceSchema>;

export function temporarySourceDirectory({ name, source }: { name: string, source: TemporaryModelSource | undefined }): ModelDirectory {
  if (source === undefined || source.id !== name) {
    throw new LlamaCppBrowserError({ code: 'missing-model' });
  }
  const parsed = temporaryModelSourceSchema.parse(source);
  const reference = parseTemporaryModelReference({ name });
  const { files } = normalizeModelDirectoryInput({ directory: { name: reference.rootName, files: parsed.files } });
  if (files.some(entry => !/\.gguf$/i.test(entry.path))) {
    throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
  }
  const resolved = resolveModelFiles({ files });
  if (resolved.modelPath !== parsed.modelPath || resolved.projectorPath !== parsed.projectorPath
    || (reference.repository !== undefined && parsed.variantRepository !== reference.repository)
    || (reference.selector !== undefined && reference.selector !== modelVariantName({ repository: parsed.variantRepository, path: parsed.modelPath }))) {
    throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
  }
  return {
    id: name,
    name,
    files: files.map(({ path, file }) => ({ path, file, storageKind: 'temp', revision: parsed.revision })),
    ...resolved,
  };
}

export const TEST_ONLY = {
};
