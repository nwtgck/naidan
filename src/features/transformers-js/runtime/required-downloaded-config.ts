import { downloadedModelResourceUrl } from './downloaded-model-resource-url';
import type { createOpfsModelCache } from './opfs-model-cache';
import { MissingDownloadedModelArtifactError } from './plan-downloaded-model-candidates';

/** Admit the required local entry before configuration-driven candidate planning. */
export async function requireDownloadedModelConfig({ modelId, revision, modelCache, workerLocationUrl }: {
  modelId: string;
  revision: string | undefined;
  modelCache: Pick<ReturnType<typeof createOpfsModelCache>, 'match'>;
  workerLocationUrl: string;
}): Promise<void> {
  const response = await modelCache.match(downloadedModelResourceUrl({
    modelId, revision, repositoryPath: 'config.json', workerLocationUrl,
  }));
  if (response === undefined) {
    // Only an actual cache miss is incomplete. I/O errors and subsequent JSON
    // parsing failures remain terminal, not permission to repair during Load.
    throw new MissingDownloadedModelArtifactError({
      message: `Downloaded model is incomplete; required config.json is absent before candidate planning (model=${modelId}, revision=${revision ?? 'main'}). Offline Load will not download or repair files.`,
    });
  }
  // Presence admission does not consume the body or replace AutoConfig parsing.
  await response.body?.cancel();
}

export const TEST_ONLY = {
};
