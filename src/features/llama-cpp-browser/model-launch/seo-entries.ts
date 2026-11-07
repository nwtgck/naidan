// eslint-disable-next-line local-rules-imports/prefer-root-alias-imports -- Also loaded by the publication CLI and isolated Vite dev module graph, before app aliases.
import { hfRepositories, type HfRepositoryEntry } from '../hugging-face/model-repositories';
import { modelLaunchMetadata } from './document-metadata';
import { modelIdFromSeoPath, modelSeoPath } from './seo-url';
// eslint-disable-next-line local-rules-imports/prefer-root-alias-imports -- Shared Node/browser code must not depend on the application-only alias.
import { SITE_METADATA, type PageMetadata } from '../../../logic/document-metadata';

export type ModelSeoEntry = Readonly<{
  modelId: string,
  repository: string,
  quantization: string,
  pathname: string,
  canonicalUrl: string,
  metadata: PageMetadata,
}>;

export function modelSeoEntries({ repositories }: { repositories: readonly HfRepositoryEntry[] }): readonly ModelSeoEntry[] {
  const seen = new Set<string>();
  return repositories.flatMap(entry => {
    const { hfRepository, seoPageQuantizations, ...unhandled } = entry;
    unhandled satisfies Record<PropertyKey, never>;
    if (seoPageQuantizations.length === 0) {
      throw new Error(`No public quantization for ${hfRepository}`);
    }
    return seoPageQuantizations.map(quantization => {
      const modelId = `hf.co/${hfRepository}:${quantization}`;
      const pathname = modelSeoPath({ modelId });
      if (seen.has(pathname)) {
        throw new Error(`Duplicate model SEO path: ${pathname}`);
      }
      seen.add(pathname);
      return {
        modelId,
        repository: hfRepository,
        quantization,
        pathname,
        canonicalUrl: new URL(pathname, SITE_METADATA.url).href,
        metadata: modelLaunchMetadata({ repository: hfRepository, variant: quantization }),
      };
    });
  });
}

// No eager snapshot: development reloads the module through Vite's module graph.
export function listModelSeoEntries(): readonly ModelSeoEntry[] {
  return modelSeoEntries({ repositories: hfRepositories });
}

export function findModelSeoEntry({ pathname }: { pathname: string }): ModelSeoEntry | undefined {
  const modelId = modelIdFromSeoPath({ pathname });
  return modelId === undefined ? undefined : listModelSeoEntries().find(entry => entry.modelId === modelId);
}

export const TEST_ONLY = {
};
