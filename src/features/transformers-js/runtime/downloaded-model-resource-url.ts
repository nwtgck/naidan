export function downloadedModelResourceUrl({
  modelId,
  revision,
  repositoryPath,
  workerLocationUrl,
}: {
  modelId: string;
  revision: string | undefined;
  repositoryPath: string;
  workerLocationUrl: string;
}): string {
  const encodedPath = repositoryPath.split('/').map(part => encodeURIComponent(part)).join('/');
  if (modelId.startsWith('user/') || modelId.startsWith('local/')) {
    const encodedModelId = modelId.split('/').map(part => encodeURIComponent(part)).join('/');
    return new URL(`/${encodedModelId}/${encodedPath}`, workerLocationUrl).href;
  }
  const encodedModelId = modelId.split('/').map(part => encodeURIComponent(part)).join('/');
  return `https://huggingface.co/${encodedModelId}/resolve/${encodeURIComponent(revision ?? 'main')}/${encodedPath}`;
}

export const TEST_ONLY = {
};
