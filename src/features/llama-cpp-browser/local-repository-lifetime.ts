import type { TemporaryModelDirectory } from '@/01-models/temporary-model-files';

type SourceLifetime = { isCurrent(): boolean, retain(): { release(): void } };
const sources = new Map<string, SourceLifetime>();
const roots = new WeakSet<TemporaryModelDirectory>();

export function claimLocalRepositoryRoot({ root }: { root: TemporaryModelDirectory }): void {
  roots.add(root);
}

export function isLocalRepositoryRoot({ root }: { root: TemporaryModelDirectory }): boolean {
  return roots.has(root);
}

/** Chat admission stays lightweight. File parsing/copying is loaded only after
 * a local input action registers the callbacks for its captured source. */
export function registerLocalRepositoryLifetime({ modelIds, lifetime }: {
  modelIds: readonly string[], lifetime: SourceLifetime,
}): () => void {
  for (const modelId of modelIds) {
    sources.set(modelId, lifetime);
  }
  return () => {
    for (const modelId of modelIds) {
      if (sources.get(modelId) === lifetime) {
        sources.delete(modelId);
      }
    }
  };
}

export function retainLocalRepositorySource({ modelId }: { modelId: string }): { release(): void } | undefined {
  const source = sources.get(modelId);
  if (!source) {
    return undefined;
  }
  if (!source.isCurrent()) {
    sources.delete(modelId);
    return undefined;
  }
  return source.retain();
}

export const TEST_ONLY = {
};
