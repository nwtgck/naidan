import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';
import { modelVariantName } from './model-variants';

/** Exact file identities and public variants share one namespace. Never let an
 * exact match silently win over a different model's variant (or vice versa).
 */
export function selectRepositoryModel<T extends { modelPath: string }>({ models, repository, selectors }: { models: T[], repository: string, selectors: string[] | undefined }): T {
  const matching = selectors === undefined ? models : models.filter(model => selectors.some(selector => model.modelPath === selector || modelVariantName({ repository, path: model.modelPath }) === selector));
  if (matching.length !== 1) {
    throw new LlamaCppBrowserError({ code: matching.length ? 'unsupported-input' : 'missing-model' });
  }
  return matching[0]!;
}

export const TEST_ONLY = {
};
