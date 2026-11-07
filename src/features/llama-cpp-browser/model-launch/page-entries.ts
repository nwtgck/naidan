// eslint-disable-next-line local-rules-imports/prefer-root-alias-imports -- Also loaded by the Hosted Vite build and isolated Vite dev module graph, before app aliases.
import { hfRepositories, type HfRepositoryEntry } from '../hugging-face/model-repositories';
import { modelLaunchMetadata, modelLaunchLabel } from './document-metadata';
import { modelIdFromPagePath, modelPagePath } from './page-url';
// eslint-disable-next-line local-rules-imports/prefer-root-alias-imports -- Shared Node/browser code must not depend on the application-only alias.
import { SITE_METADATA, type PageMetadata } from '../../../logic/document-metadata';
// eslint-disable-next-line local-rules-imports/prefer-root-alias-imports -- Pure helper shared with Node publication code before app aliases.
import { exactObject } from '../../../utils/exact-object';

export type ModelPageEntry = Readonly<{
  modelId: string,
  repository: string,
  label: string,
  pathname: string,
  canonicalUrl: string,
  metadata: PageMetadata,
}>;

export function modelPageEntries({ repositories }: { repositories: readonly HfRepositoryEntry[] }): readonly ModelPageEntry[] {
  const seen = new Set<string>();
  return repositories.map(entry => {
    const { hfRepository, ...unhandled } = entry;
    unhandled satisfies Record<PropertyKey, never>;
    const modelId = `hf.co/${hfRepository}`;
    const pathname = modelPagePath({ modelId });
    if (seen.has(pathname)) {
      throw new Error(`Duplicate model page path: ${pathname}`);
    }
    seen.add(pathname);
    return exactObject<ModelPageEntry>()({
      modelId,
      repository: hfRepository,
      label: modelLaunchLabel({ repository: hfRepository, variant: undefined }),
      pathname,
      canonicalUrl: new URL(pathname, SITE_METADATA.url).href,
      // A repository page cannot know the current upstream quantization choices.
      metadata: modelLaunchMetadata({ repository: hfRepository, variant: undefined }),
    });
  });
}

// No eager snapshot: development reloads the module through Vite's module graph.
export function listModelPageEntries(): readonly ModelPageEntry[] {
  return modelPageEntries({ repositories: hfRepositories });
}

export function findModelPageEntry({ pathname }: { pathname: string }): ModelPageEntry | undefined {
  const modelId = modelIdFromPagePath({ pathname });
  return modelId === undefined ? undefined : listModelPageEntries().find(entry => entry.modelId === modelId);
}

export const TEST_ONLY = {
};
