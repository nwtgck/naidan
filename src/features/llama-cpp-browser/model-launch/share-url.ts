import type { RepositoryCatalog } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { variantLabel } from '@/features/llama-cpp-browser/hugging-face/model-variants';
import { MODEL_LAUNCH_QUERY } from './entry-state';
import { resolveModelLaunchTarget } from './target';

/** Share the public variant selector, not the local file ID or download plan. */
export function modelLaunchShareUrl({ baseUrl, catalog, mainFilePath }: { baseUrl: string, catalog: RepositoryCatalog, mainFilePath: string }): string | undefined {
  try {
    const variant = variantLabel({ repository: catalog.repository, path: mainFilePath });
    // The HF URL parser decodes path segments before reading the variant. Encode
    // its nested paths and reserved characters before the outer fragment query.
    const input = `hf.co/${catalog.repository}:${encodeURIComponent(variant)}`;
    const { target } = resolveModelLaunchTarget({ input, catalog });
    if (target.mainFilePath !== mainFilePath) {
      return undefined;
    }
    const url = new URL(baseUrl);
    url.search = '';
    url.hash = `/?${new URLSearchParams({ [MODEL_LAUNCH_QUERY]: input })}`;
    return url.href;
  } catch {
    // Ambiguous names, auxiliary weights and unresolved companions cannot be
    // represented by the existing model-launch entry point.
    return undefined;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
