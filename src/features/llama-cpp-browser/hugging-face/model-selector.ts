import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';
import { modelVariantName } from './model-variants';

/** Only current readable variants select a group. File paths are captured by
 * the selected directory rather than encoded into a second model identity.
 */
export function selectRepositoryModel<T extends { primaryFile: { relativePath: string } }>({ models, repository, variant }: { models: T[], repository: string, variant: string | undefined }): T {
  const matching = variant === undefined ? models : models.filter(model => modelVariantName({ repository, path: model.primaryFile.relativePath }) === variant);
  if (matching.length !== 1) {
    throw new LlamaCppBrowserError({ code: matching.length ? 'unsupported-input' : 'missing-model' });
  }
  return matching[0]!;
}

export const TEST_ONLY = {
};
